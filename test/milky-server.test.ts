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
      dispatch: async (api) => {
        if (api === 'get_login_info') return { status: 'ok', retcode: 0, data: { uin: 42, nickname: 'noa-ark' } };
        if (api === 'send_group_message') return { status: 'ok', retcode: 0, data: { message_seq: 7 } };
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

  it('returns 413 / 500 JSON errors without crashing the process', async () => {
    let calls = 0;
    const server = await startMilkyServer({
      conf: { enable: true, port: 0, accessToken: 'mt' },
      logger: quietLogger,
      dispatch: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { status: 'ok', retcode: 0, data: { calls } };
      },
    });
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer mt' };
    try {
      const oversized = await fetch(`${server.url}/api/x`, {
        method: 'POST',
        headers,
        body: 'a'.repeat(1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(413);
      expect(((await oversized.json()) as { retcode: number }).retcode).toBe(-413);

      const boom = await fetch(`${server.url}/api/x`, { method: 'POST', headers, body: '{}' });
      expect(boom.status).toBe(500);
      expect(((await boom.json()) as { retcode: number }).retcode).toBe(-500);

      const alive = await fetch(`${server.url}/api/x`, { method: 'POST', headers, body: '{}' });
      expect(alive.status).toBe(200);
      expect(((await alive.json()) as { data: { calls: number } }).data.calls).toBe(2);
    } finally {
      await server.close();
    }
  });
});
