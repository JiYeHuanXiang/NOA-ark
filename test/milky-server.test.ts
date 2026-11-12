import { describe, expect, it } from 'vitest';
import { startMilkyServer } from '../src/milky/server.js';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 4000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes(needle)) return buffer;
  }
  throw new Error(`SSE 未收到 ${needle}；已收到：${buffer}`);
}

describe('Milky server', () => {
  it('serves /api with token auth, ok and failed responses', async () => {
    const server = await startMilkyServer({
      conf: { enable: true, port: 0, accessToken: 'mt' },
      logger: quietLogger,
      dispatch: async (api, params) => {
        if (api === 'get_login_info') return { status: 'ok', retcode: 0, data: { uin: 42, nickname: 'Arona' } };
        if (api === 'send_group_message') return { status: 'ok', retcode: 0, data: { message_seq: 7 } };
        void params;
        return { status: 'failed', retcode: -404, data: {}, message: 'API 不存在' };
      },
    });

    try {
      const unauthorized = await fetch(`${server.url}/api/get_login_info`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(unauthorized.status).toBe(401);

      const login = await fetch(`${server.url}/api/get_login_info`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mt' },
      });
      const loginBody = (await login.json()) as { status: string; data: { uin: number } };
      expect(loginBody.status).toBe('ok');
      expect(loginBody.data.uin).toBe(42);

      const unknown = await fetch(`${server.url}/api/nope`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mt' },
      });
      const unknownBody = (await unknown.json()) as { retcode: number };
      expect(unknownBody.retcode).toBe(-404);
    } finally {
      await server.close();
    }
  });

  it('pushes events over SSE as milky_event', async () => {
    const server = await startMilkyServer({
      conf: { enable: true, port: 0, accessToken: 'mt' },
      logger: quietLogger,
      dispatch: async () => ({ status: 'ok', retcode: 0, data: {} }),
    });
    const controller = new AbortController();
    try {
      const res = await fetch(`${server.url}/event?access_token=mt`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      await readUntil(reader, 'connected');

      server.broadcast({ time: 1, self_id: 42, event_type: 'message_receive', data: { message_scene: 'group' } });
      const stream = await readUntil(reader, 'event: milky_event');
      expect(stream).toContain('"event_type":"message_receive"');
      controller.abort();
      void reader.cancel().catch(() => undefined);
    } finally {
      controller.abort();
      await server.close();
    }
  });
});
