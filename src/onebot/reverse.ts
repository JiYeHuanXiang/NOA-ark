import { WebSocket } from 'ws';
import type { OneBotResponse } from './actions.js';
import { buildLifecycleEvent } from './events.js';
import type { Logger } from '../types.js';

export interface ReverseOptions {
  urls: string[];
  logger: Logger;
  selfId: () => number | string;
  now?: () => number;
  dispatch: (action: string, params: Record<string, unknown>, echo: unknown) => Promise<OneBotResponse>;

  accessToken?: string;
  reconnectDelayMs?: number;
}

export interface ReverseHandle {

  broadcast(event: unknown): void;
  close(): void;
  readonly connections: number;
}

export function startReverseClients(options: ReverseOptions): ReverseHandle {
  const { logger } = options;
  const now = options.now ?? (() => Date.now());
  const sockets = new Set<WebSocket>();
  const timers = new Set<NodeJS.Timeout>();
  let stopping = false;

  for (const url of options.urls) {
    if (url.trim() === '') continue;
    void loop(url);
  }

  async function loop(url: string): Promise<void> {
    let attempt = 0;
    while (!stopping) {
      try {
        await connectOnce(url);
        attempt = 0;
      } catch (err) {
        logger.warn(`反向 WS 连接失败（${url}）：${err instanceof Error ? err.message : String(err)}`);
      }
      if (stopping) break;
      attempt += 1;
      const base = options.reconnectDelayMs ?? 1000;
      const delay = Math.min(60_000, base * 2 ** Math.min(attempt, 6));
      await sleep(delay);
    }
  }

  function connectOnce(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {},
      });
      let opened = false;

      ws.on('open', () => {
        opened = true;
        sockets.add(ws);
        logger.info(`反向 WS 已连接：${url}`);
        try {
          ws.send(JSON.stringify(buildLifecycleEvent(options.selfId(), now)));
        } catch {

        }
      });

      ws.on('message', (raw) => {
        void handleMessage(ws, raw.toString()).catch((err: unknown) => {
          logger.warn(`反向 WS 消息处理失败：${err instanceof Error ? err.message : String(err)}`);
        });
      });

      ws.on('close', () => {
        sockets.delete(ws);
        if (opened) logger.warn(`反向 WS 已断开：${url}`);
        resolve();
      });

      ws.on('error', (err) => {
        sockets.delete(ws);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async function handleMessage(ws: WebSocket, text: string): Promise<void> {
    let frame: { action?: unknown; params?: unknown; echo?: unknown };
    try {
      frame = JSON.parse(text) as { action?: unknown; params?: unknown; echo?: unknown };
    } catch {
      logger.warn('反向 WS 收到非 JSON 消息');
      return;
    }
    const action = typeof frame.action === 'string' ? frame.action : '';
    if (action === '') {
      safeSend(ws, { status: 'failed', retcode: 1400, data: null, message: '缺少 action', echo: frame.echo });
      return;
    }
    const params = typeof frame.params === 'object' && frame.params !== null && !Array.isArray(frame.params)
      ? (frame.params as Record<string, unknown>)
      : {};
    let response: OneBotResponse;
    try {
      response = await options.dispatch(action, params, frame.echo);
    } catch (err) {
      logger.warn(`反向 WS 动作 ${action} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      safeSend(ws, { status: 'failed', retcode: 1500, data: null, message: '内部错误', echo: frame.echo });
      return;
    }
    safeSend(ws, response);
  }

  function safeSend(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {

    }
  }

  return {
    get connections(): number {
      return sockets.size;
    },
    broadcast(event: unknown): void {
      const text = JSON.stringify(event);
      for (const ws of sockets) {
        try {
          ws.send(text);
        } catch {

        }
      }
    },
    close(): void {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {

        }
      }
      sockets.clear();
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
