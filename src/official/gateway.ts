/**
 * OfficialGateway — QQ 官方开放平台 WebSocket 网关客户端（自研直连）。
 *
 * 网关协议（v2，Discord 风格）：
 *   - 服务端 op 10 Hello { heartbeat_interval } → 客户端按间隔发 op 1 心跳
 *   - 客户端 op 2 Identify { token, intents, shard, properties }
 *   - 服务端 op 0 Dispatch：READY / RESUMED / 各业务事件（t, d, s）
 *   - 断线重连：session 有效时 op 6 Resume { token, session_id, seq }
 *   - op 7 Reconnect / op 9 Invalid Session 按指示范畴处理
 *
 * 关闭码分类（FATAL：丢弃 session，重新 Identify）：
 *   4004 鉴权失败，4009 session 超时。
 * 其余（可恢复）：保留 session，用 Resume 恢复。
 */

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

const FATAL_CLOSE_CODES = new Set<number>([
  CLOSE_CODES.AUTH_FAILED,
  CLOSE_CODES.SESSION_TIMEOUT,
  4013, // 无效的 intent
  4014, // intent 无权限
]);

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
  /** 订阅官方业务事件。 */
  onEvent?: (event: OfficialEventEnvelope) => void;
  /** 取 access_token（复用 Rest 的缓存）；不提供则自行获取。 */
  tokenProvider?: () => Promise<string>;
  WebSocketCtor?: WebSocketCtor;
  fetchImpl?: typeof fetch;
  /** 断线重连的最小延迟（测试可置 0）。 */
  reconnectDelayMs?: number;
  /**
   * 显式 intents。省略时使用 DEFAULT_INTENTS（1<<25 | 1<<24），
   * 若平台以 4013/4014 拒绝则自动回退到 1<<25 并重连。
   */
  intents?: number;
}

export interface GatewayHandle {
  /** 首次 READY / RESUMED 后 resolve；就绪前 stop 会 reject。 */
  ready: Promise<void>;
  /** 连接任务结束（永不 reject）。 */
  done: Promise<void>;
  readonly online: boolean;
  stop(): void;
  onEvent(handler: (event: OfficialEventEnvelope) => void): void;
}

/** 默认订阅：GROUP_AND_C2C_EVENT（1<<25）+ GROUP_MEMBER（1<<24）。 */
export const DEFAULT_INTENTS = (1 << 25) | (1 << 24);
/** 群成员事件无权限时的回退订阅（仅群/单聊消息事件）。 */
export const FALLBACK_INTENTS = 1 << 25;

export function connectGateway(options: GatewayOptions): GatewayHandle {
  const { logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = (): number => Date.now();
  let online = false;
  let stopping = false;
  let sessionId: string | undefined;
  let lastSeq: number | undefined;
  let ws: WebSocketLike | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatIntervalMs = 30_000;
  const handlers = new Set<(event: OfficialEventEnvelope) => void>();
  if (options.onEvent) handlers.add(options.onEvent);
  // 只有「未显式配置」时才允许因 4013/4014 回退，避免掩盖配置错误。
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
    while (!stopping) {
      try {
        await openOnce();
        attempt = 0;
      } catch (err) {
        logger.warn(`网关连接结束：${redact(err instanceof Error ? err.message : String(err))}`);
      }
      online = false;
      if (stopping) break;
      attempt += 1;
      const base = options.reconnectDelayMs ?? 500;
      const delay = Math.min(60_000, base * 2 ** Math.min(attempt, 6));
      logger.info(`将在 ${delay}ms 后重连 QQ 网关`);
      await sleep(delay);
    }
    failReady?.(new Error('网关在就绪前已停止'));
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
        if (intentRejected && intentFallback !== undefined && currentIntents !== intentFallback) {
          logger.warn(
            `网关拒绝 intents=${currentIntents}（code=${code}），回退为 ${intentFallback}（不再订阅群成员事件）`,
          );
          currentIntents = intentFallback;
          sessionId = undefined;
          lastSeq = undefined;
        } else if (FATAL_CLOSE_CODES.has(code)) {
          sessionId = undefined;
          lastSeq = undefined;
        }
        stopHeartbeat();
        safeClose(socket);
        if (stopping) resolve();
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
      // ignore
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
