import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { OneBotResponse } from './actions.js';
import { buildHeartbeatEvent, buildLifecycleEvent } from './events.js';
import type { OneBotConf } from '../config.js';
import type { Logger } from '../types.js';

export interface OneBotServerOptions {
  conf: OneBotConf;
  logger: Logger;
  selfId: () => number | string;
  now?: () => number;
  dispatch: (action: string, params: Record<string, unknown>, echo: unknown) => Promise<OneBotResponse>;

  extraBroadcasters?: Array<(event: unknown) => void | Promise<void>>;
}

export interface OneBotServerHandle {

  url: string;
  port: number;

  readonly clients: number;

  broadcast(event: unknown): Promise<void>;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;

export async function startOneBotServer(options: OneBotServerOptions): Promise<OneBotServerHandle> {
  const { conf, logger } = options;
  const now = options.now ?? (() => Date.now());
  const clients = new Set<WebSocket>();
  let heartbeat: NodeJS.Timeout | undefined;

  const httpServer: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {

    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('noa-ark: HTTP API removed; connect via WebSocket at the configured wsPath');
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {

      socket.destroy();
      return;
    }
    if (url.pathname !== conf.wsPath) {
      socket.destroy();
      return;
    }
    if (!checkAuth(req, url, conf.accessToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    logger.info(`OneBot WS 客户端已连接（当前 ${clients.size}）`);
    sendJson(ws, buildLifecycleEvent(options.selfId(), now));
    ws.on('message', (raw) => {
      void handleWsMessage(ws, raw.toString()).catch((err: unknown) => {
        logger.warn(`OneBot WS 消息处理失败：${err instanceof Error ? err.message : String(err)}`);
      });
    });
    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`OneBot WS 客户端已断开（当前 ${clients.size}）`);
    });
    ws.on('error', (err) => {
      logger.warn(`OneBot WS 错误：${err instanceof Error ? err.message : String(err)}`);
    });
  });

  async function handleWsMessage(ws: WebSocket, text: string): Promise<void> {
    let frame: { action?: unknown; params?: unknown; echo?: unknown };
    try {
      frame = JSON.parse(text) as { action?: unknown; params?: unknown; echo?: unknown };
    } catch {
      logger.warn('OneBot WS 消息不是合法 JSON');
      return;
    }
    const action = typeof frame.action === 'string' ? frame.action : '';
    if (action === '') {
      sendJson(ws, { status: 'failed', retcode: 1400, data: null, message: '缺少 action', echo: frame.echo });
      return;
    }
    const params = isRecord(frame.params) ? frame.params : {};
    let response: OneBotResponse;
    try {
      response = await options.dispatch(action, params, frame.echo);
    } catch (err) {
      logger.warn(`OneBot 动作 ${action} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      sendJson(ws, {
        status: 'failed',
        retcode: 1500,
        data: null,
        message: '内部错误',
        echo: frame.echo,
      });
      return;
    }
    sendJson(ws, response);
  }

  async function broadcast(event: unknown): Promise<void> {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) sendJson(ws, event);
    }
    for (const extra of options.extraBroadcasters ?? []) {
      try {
        await extra(event);
      } catch (err) {
        logger.warn(`附加广播失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(conf.wsPort, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const port = typeof address === 'object' && address !== null ? address.port : conf.wsPort;

  heartbeat = setInterval(() => {
    void broadcast(buildHeartbeatEvent(options.selfId(), HEARTBEAT_MS, now));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    url: `ws://127.0.0.1:${port}${conf.wsPath}`,
    port,
    get clients(): number {
      return clients.size;
    },
    broadcast,
    async close(): Promise<void> {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      for (const ws of clients) {
        try {
          ws.close();
        } catch {

        }
      }
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function checkAuth(req: IncomingMessage, url: URL, token: string): boolean {
  if (token === '') return true;
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = url.searchParams.get('access_token') ?? '';
  return bearer === token || query === token;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {

  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
