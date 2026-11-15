import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { connect } from 'node:net';
import { startOneBotServer } from '../src/onebot/server.js';
import type { OneBotResponse } from '../src/onebot/actions.js';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function nextJson(ws: WebSocket, predicate?: (data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 WS 消息超时')), 4000);
    const onMessage = (raw: unknown): void => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (predicate !== undefined && !predicate(parsed)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed);
    };
    ws.on('message', onMessage);
  });
}

function makeConf() {
  return {
    enable: true,
    mode: 'both' as const,
    accessToken: 't0ken',
    wsPort: 0,
    wsPath: '/ws',
    reverseUrls: [],
  };
}

describe('OneBot server (WS only)', () => {
  it('rejects plain HTTP requests with 426 Upgrade Required', async () => {
    const server = await startOneBotServer({
      conf: makeConf(),
      logger: quietLogger,
      selfId: () => 10000000000001,
      dispatch: async (): Promise<OneBotResponse> => ({ status: 'ok', retcode: 0, data: null, message: '' }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/get_status`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t0ken' },
        body: '{}',
      });
      expect(res.status).toBe(426);
    } finally {
      await server.close();
    }
  });

  it('accepts forward WS clients and answers action frames', async () => {
    const server = await startOneBotServer({
      conf: makeConf(),
      logger: quietLogger,
      selfId: () => 10000000000001,
      dispatch: async (action, params, echo): Promise<OneBotResponse> => ({
        status: 'ok',
        retcode: 0,
        data: { action, params },
        message: '',
        echo,
      }),
    });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?access_token=t0ken`);
    try {
      const lifecycle = await nextJson(ws);
      expect(lifecycle.post_type).toBe('meta_event');
      expect(lifecycle.meta_event_type).toBe('lifecycle');

      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'e1' }));
      const response = await nextJson(ws, (data) => data.retcode !== undefined);
      expect(response.status).toBe('ok');
      expect(response.echo).toBe('e1');
      expect((response.data as { action: string }).action).toBe('get_login_info');

      void server.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000 });
      const heartbeat = await nextJson(ws, (data) => data.meta_event_type === 'heartbeat');
      expect(heartbeat.interval).toBe(30000);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it('rejects WS handshake without token', async () => {
    const server = await startOneBotServer({
      conf: makeConf(),
      logger: quietLogger,
      selfId: () => 1,
      dispatch: async () => ({ status: 'ok', retcode: 0, data: null, message: '' }),
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true));
      ws.on('open', () => resolve(false));
    });
    expect(failed).toBe(true);
    ws.terminate();
    await server.close();
  });

  it('survives a malformed request target in the upgrade path', async () => {
    const server = await startOneBotServer({
      conf: makeConf(),
      logger: quietLogger,
      selfId: () => 1,
      dispatch: async () => ({ status: 'ok', retcode: 0, data: null, message: '' }),
    });
    try {
      await new Promise<void>((resolve) => {
        const socket = connect(server.port, '127.0.0.1', () => {
          socket.write(
            'GET http://[::1/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n'
            + 'Upgrade: websocket\r\n\r\n',
          );
        });
        socket.on('close', () => resolve());
        socket.on('error', () => resolve());
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 1_000);
      });

      // 进程仍存活：普通 HTTP 请求仍返回 426。
      const res = await fetch(`http://127.0.0.1:${server.port}/`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(426);
    } finally {
      await server.close();
    }
  });
});
