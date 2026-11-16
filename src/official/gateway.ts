import type { Logger } from '../types.js';
import { redact } from '../types.js';

export interface WebSocketLike {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export const CLOSE_CODES = {
  NORMAL: 1000,
  SERVER_ERROR: 4000,
  AUTH_FAILED: 4004,
  RATE_LIMITED: 4008,
  SESSION_TIMEOUT: 4009,
} as const;

const STOP_CLOSE_CODES = new Set<number>([
  4914,
  4915,
]);

const IDENTIFY_CLOSE_CODES = new Set<number>([
  4001,
  4002,
  4004,
  4006,
  4007,
  4010,
  4011,
  4012,
  4013,
  4014,
]);

export type CloseAction = 'resume' | 'identify' | 'stop';

export function classifyCloseCode(code: number): CloseAction {
  if (STOP_CLOSE_CODES.has(code)) return 'stop';
  if (IDENTIFY_CLOSE_CODES.has(code)) return 'identify';
  if (code >= 4900 && code <= 4913) return 'identify';
  return 'resume';
}

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface OfficialEventEnvelope {
  eventType: string;
  data: Record<string, unknown>;
  seq?: number;
}

export interface GatewayOptions {
  appId: string;
  appSecret: string;
  baseUrl: string;
  tokenBaseUrl: string;
  logger: Logger;

  onEvent?: (event: OfficialEventEnvelope) => void;

  tokenProvider?: () => Promise<string>;
  WebSocketCtor?: WebSocketCtor;
  fetchImpl?: typeof fetch;

  reconnectDelayMs?: number;

  intents?: number;
}

export interface GatewayHandle {

  ready: Promise<void>;

  done: Promise<void>;
  readonly online: boolean;
  stop(): void;
  onEvent(handler: (event: OfficialEventEnvelope) => void): void;
}

export const DEFAULT_INTENTS = (1 << 25) | (1 << 24);

export const FALLBACK_INTENTS = 1 << 25;

export function connectGateway(options: GatewayOptions): GatewayHandle {
  const { logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let online = false;
  let stopping = false;
  let halted = false;
  let sessionId: string | undefined;
  let lastSeq: number | undefined;
  let ws: WebSocketLike | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatIntervalMs = 30_000;
  const handlers = new Set<(event: OfficialEventEnvelope) => void>();
  if (options.onEvent) handlers.add(options.onEvent);

  const intentFallback = options.intents === undefined ? FALLBACK_INTENTS : undefined;
  let currentIntents = options.intents ?? DEFAULT_INTENTS;

  let settleReady: (() => void) | undefined;
  let failReady: ((error: Error) => void) | undefined;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
    failReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  void ready.catch(() => undefined);

  const done = run();

  async function run(): Promise<void> {
    let attempt = 0;
    while (!stopping && !halted) {
      try {
        await openOnce();
        attempt = 0;
      } catch (err) {
        logger.warn(`网关连接结束：${redact(err instanceof Error ? err.message : String(err))}`);
      }
      online = false;
      if (stopping || halted) break;
      attempt += 1;
      const base = options.reconnectDelayMs ?? 500;
      const delay = Math.min(60_000, base * 2 ** Math.min(attempt, 6));
      logger.info(`将在 ${delay}ms 后重连 QQ 网关`);
      await sleep(delay);
    }
    failReady?.(new Error(halted ? '网关已被平台永久关闭（4914/4915）' : '网关在就绪前已停止'));
  }

  async function openOnce(): Promise<void> {
    const token = await getToken();
    const gatewayUrl = await fetchGatewayUrl(token);
    const Ctor: WebSocketCtor = options.WebSocketCtor ?? (await loadWs());
    const socket = new Ctor(gatewayUrl);
    ws = socket;

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        logger.debug('网关 WebSocket 已打开');
      };

      socket.onmessage = (event: { data: unknown }) => {
        const text = String(event.data ?? '');
        if (text === '') return;
        let msg: { op?: number; d?: unknown; s?: number; t?: string };
        try {
          msg = JSON.parse(text) as { op?: number; d?: unknown; s?: number; t?: string };
        } catch {
          logger.warn('网关消息非 JSON，已忽略');
          return;
        }
        handleFrame(msg, socket);
      };

      socket.onclose = (event) => {
        const code = typeof event.code === 'number' ? event.code : 0;
        logger.warn(`网关断开（code=${code}${event.reason ? ` ${redact(event.reason)}` : ''}）`);
        online = false;
        const intentRejected = code === 4013 || code === 4014;
        const action = classifyCloseCode(code);
        if (intentRejected && intentFallback !== undefined && currentIntents !== intentFallback) {
          logger.warn(
            `网关拒绝 intents=${currentIntents}（code=${code}），回退为 ${intentFallback}（不再订阅群成员事件）`,
          );
          currentIntents = intentFallback;
          sessionId = undefined;
          lastSeq = undefined;
        } else if (action === 'identify') {
          sessionId = undefined;
          lastSeq = undefined;
        } else if (action === 'stop') {
          halted = true;
          sessionId = undefined;
          lastSeq = undefined;
          logger.error(`QQ 网关已被平台永久关闭（code=${code}），停止重连`);
        }
        stopHeartbeat();
        safeClose(socket);
        if (stopping || halted) resolve();
        else reject(new Error(`网关连接已关闭 (code=${code})`));
      };

      socket.onerror = () => {
        logger.warn('网关 WebSocket 发生错误');
      };
    });
  }

  function handleFrame(
    msg: { op?: number; d?: unknown; s?: number; t?: string },
    socket: WebSocketLike,
  ): void {
    switch (msg.op) {
      case OP_DISPATCH: {
        lastSeq = msg.s ?? lastSeq;
        const t = msg.t ?? '';
        const d = (msg.d ?? {}) as Record<string, unknown>;
        if (t === 'READY') {
          sessionId = typeof d.session_id === 'string' ? d.session_id : undefined;
          online = true;
          settleReady?.();
          logger.info('QQ 网关已连接（READY）');
        } else if (t === 'RESUMED') {
          online = true;
          settleReady?.();
          logger.info('QQ 网关会话已恢复（RESUMED）');
        }
        if (t !== '') {
          const envelope: OfficialEventEnvelope = { eventType: t, data: d };
          if (typeof msg.s === 'number') envelope.seq = msg.s;
          for (const handler of handlers) {
            try {
              handler(envelope);
            } catch (err) {
              logger.warn(`官方事件处理回调失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        break;
      }
      case OP_HELLO: {
        const d = (msg.d ?? {}) as { heartbeat_interval?: number };
        heartbeatIntervalMs = d.heartbeat_interval ?? 30_000;
        startHeartbeat(socket);
        if (sessionId !== undefined) {
          socket.send(
            JSON.stringify({
              op: OP_RESUME,
              d: {
                token: `QQBot ${lastTokenForResume}`,
                session_id: sessionId,
                seq: lastSeq ?? 0,
              },
            }),
          );
        } else {
          socket.send(
            JSON.stringify({
              op: OP_IDENTIFY,
              d: {
                token: `QQBot ${lastTokenForResume}`,
                intents: currentIntents,
                shard: [0, 1],
                properties: {
                  $os: process.platform,
                  $browser: 'noa-ark',
                  $device: 'noa-ark',
                },
              },
            }),
          );
        }
        break;
      }
      case OP_HEARTBEAT_ACK:
        break;
      case OP_RECONNECT:
        logger.info('服务端要求重连（op=7）');
        safeClose(socket);
        break;
      case OP_INVALID_SESSION:
        logger.warn('session 已失效（op=9），将重新鉴权');
        sessionId = undefined;
        lastSeq = undefined;
        safeClose(socket);
        break;
      default:
        break;
    }
  }

  let lastTokenForResume = '';

  async function getToken(): Promise<string> {
    if (options.tokenProvider) {
      lastTokenForResume = await options.tokenProvider();
      return lastTokenForResume;
    }
    const resp = await fetchImpl(`${options.tokenBaseUrl}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: options.appId, clientSecret: options.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await resp.json()) as { access_token?: string };
    if (!resp.ok || !payload?.access_token) {
      throw new Error(`获取 access_token 失败：HTTP ${resp.status}`);
    }
    lastTokenForResume = payload.access_token;
    return payload.access_token;
  }

  async function fetchGatewayUrl(token: string): Promise<string> {
    const resp = await fetchImpl(`${options.baseUrl}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`GET /gateway 失败：HTTP ${resp.status}`);
    const payload = (await resp.json()) as { url?: string };
    if (!payload?.url) throw new Error('GET /gateway 未返回 url');
    return payload.url;
  }

  function startHeartbeat(socket: WebSocketLike): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket !== ws) return;
      try {
        socket.send(JSON.stringify({ op: OP_HEARTBEAT, d: lastSeq ?? null }));
      } catch {
        logger.warn('心跳发送失败');
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function safeClose(socket: WebSocketLike): void {
    try {
      socket.close(CLOSE_CODES.NORMAL);
    } catch {

    }
  }

  return {
    ready,
    done: done.then(() => undefined),
    get online() {
      return online;
    },
    stop(): void {
      if (stopping) return;
      stopping = true;
      online = false;
      stopHeartbeat();
      if (ws !== null) safeClose(ws);
      failReady?.(new Error('网关在就绪前已停止'));
    },
    onEvent(handler) {
      handlers.add(handler);
    },
  };
}

async function loadWs(): Promise<WebSocketCtor> {
  try {
    const mod = (await import('ws')) as unknown as { default: WebSocketCtor };
    return mod.default;
  } catch {
    throw new Error('无法加载 WebSocket 库（ws），请先 npm install');
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
