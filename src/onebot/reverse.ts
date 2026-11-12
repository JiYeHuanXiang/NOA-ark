/**
 * OneBot v11 反向 WebSocket 客户端（文档 §3.1）。
 *
 * 适配器主动连接旧程序提供的 URL；连上后立即推送 lifecycle 事件，
 * 之后所有事件经广播推送；对端在同一条连接上发 {action, params, echo}，
 * 适配器回 {status, retcode, data, message, echo}。
 *
 * 断线按指数退避重连；close() 时停止全部循环。
 */

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
  /** 连接旧程序时附带的 Authorization（可选）。 */
  accessToken?: string;
  reconnectDelayMs?: number;
}

export interface ReverseHandle {
  /** 广播事件到全部在线反向连接。 */
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
          // ignore
        }
      });

      ws.on('message', (raw) => {
        void handleMessage(ws, raw.toString());
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
    const response = await options.dispatch(action, params, frame.echo);
    safeSend(ws, response);
  }

  function safeSend(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ignore
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
          // ignore single socket
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
          // ignore
        }
      }
      sockets.clear();
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
