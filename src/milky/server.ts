import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MilkyResponse } from './actions.js';
import type { MilkyConf } from '../config.js';
import type { Logger } from '../types.js';

export interface MilkyServerOptions {
  conf: MilkyConf;
  logger: Logger;
  dispatch: (api: string, params: Record<string, unknown>) => Promise<MilkyResponse>;
  now?: () => number;
}

export interface MilkyServerHandle {
  url: string;
  port: number;
  broadcast(event: unknown): void;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function startMilkyServer(options: MilkyServerOptions): Promise<MilkyServerHandle> {
  const { conf, logger } = options;
  const sseClients = new Set<ServerResponse>();
  const wsClients = new Set<WebSocket>();
  let heartbeat: NodeJS.Timeout | undefined;

  const httpServer: Server = createServer((req, res) => {
    void handleHttp(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      logger.warn(`Milky HTTP 请求处理失败：${err instanceof Error ? err.message : String(err)}`);
      respondJson(res, status, {
        status: 'failed',
        retcode: status === 413 ? -413 : status === 400 ? -400 : -500,
        data: {},
        message: err instanceof Error ? err.message : '内部错误',
      });
    });
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
    if (url.pathname !== '/event' || !checkAuth(req, url, conf.accessToken)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    wsClients.add(ws);
    logger.info(`Milky WS 客户端已连接（当前 ${wsClients.size}）`);
    ws.on('close', () => {
      wsClients.delete(ws);
    });
    ws.on('error', () => {
      wsClients.delete(ws);
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      respondJson(res, 400, { status: 'failed', retcode: -400, data: {}, message: '请求 URL 无效' });
      return;
    }

    if (url.pathname === '/event' && req.method === 'GET') {
      if (!checkAuth(req, url, conf.accessToken)) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);

      res.on('error', () => {
        sseClients.delete(res);
      });
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    const match = url.pathname.match(/^\/api\/([A-Za-z0-9_]+)$/);
    if (match !== null && req.method === 'POST') {
      if (!checkAuth(req, url, conf.accessToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: -403, data: {}, message: '鉴权失败' }));
        return;
      }
      const api = match[1]!;
      const bodyText = await readBody(req);
      let params: Record<string, unknown> = {};
      if (bodyText.trim() !== '') {
        try {
          const parsed = JSON.parse(bodyText) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            params = parsed as Record<string, unknown>;
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'failed', retcode: -400, data: {}, message: '请求体不是合法 JSON' }));
          return;
        }
      }
      let response: MilkyResponse;
      try {
        response = await options.dispatch(api, params);
      } catch (err) {
        logger.warn(`Milky API ${api} 执行失败：${err instanceof Error ? err.message : String(err)}`);
        respondJson(res, 500, {
          status: 'failed',
          retcode: -500,
          data: {},
          message: err instanceof Error ? err.message : '内部错误',
        });
        return;
      }
      respondJson(res, 200, response);
      return;
    }

    respondJson(res, 404, { status: 'failed', retcode: -404, data: {}, message: 'API 不存在' });
  }

  function broadcast(event: unknown): void {
    const json = JSON.stringify(event);
    for (const res of sseClients) {
      try {
        res.write(`event: milky_event\ndata: ${json}\n\n`);
      } catch {
        sseClients.delete(res);
      }
    }
    for (const ws of wsClients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(json);
        } catch {

        }
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(conf.port, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const port = typeof address === 'object' && address !== null ? address.port : conf.port;

  heartbeat = setInterval(() => {
    const event = {
      time: Math.floor((options.now ?? (() => Date.now()))() / 1000),
      self_id: 0,
      event_type: 'heartbeat',
      data: {},
    };
    broadcast(event);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    broadcast,
    async close(): Promise<void> {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      for (const res of sseClients) {
        try {
          res.end();
        } catch {

        }
      }
      sseClients.clear();
      for (const ws of wsClients) {
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, '请求体过大'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('aborted', () => fail(new HttpError(400, '客户端中断请求')));
    req.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  try {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch {

  }
}
