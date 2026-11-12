import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parseConfig } from '../src/config.js';
import { TakeoverRuntime, type DshTakeoverConf } from '../src/dsh/plugin.js';
import type { Logger } from '../src/types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const takeoverConf: DshTakeoverConf = {
  appId: '',
  autoAckInteraction: false,
  isolation: 'auto',
  retryDelayMs: 0,
};

function nextJson(ws: WebSocket, predicate?: (data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 WS 消息超时')), 5000);
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

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('dsh takeover runtime', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl = '';
  let dir = '';
  let runtime: TakeoverRuntime | undefined;
  let client: WebSocket | undefined;
  let calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'noa-dsh-runtime-'));
    calls = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const send = (payload: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.includes('/app/getAppAccessToken')) {
        send({ access_token: 'TOKEN', expires_in: 7200 });
        return;
      }
      if (req.url?.includes('/users/@me')) {
        send({ id: 'BOT_OPENID', username: 'Noa' });
        return;
      }
      if (req.method === 'POST' && req.url?.includes('/v2/')) {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            body = {};
          }
          calls.push({ url: req.url ?? '', body });
          send({ id: 'MSG_1' });
        });
        return;
      }
      send({ id: 'MSG_1' });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    await runtime?.close();
    runtime = undefined;
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts OneBot from a captured bot, forwards raw events and isolates replies', async () => {
    const config = parseConfig({
      baseUrl,
      tokenBaseUrl: baseUrl,
      dataDir: dir,
      onebot: { enable: true, wsPort: 0, wsPath: '/ws', reverseUrls: [] },
      milky: { enable: false },
    });
    runtime = new TakeoverRuntime(config, takeoverConf, logger);
    runtime.onBot({ appId: 'APP_ID', appSecret: 'APP_SECRET' });
    // auto 且未配置反向 WS：启动窗口内没有 OneBot 端能抢先回复，dsh 继续处理
    expect(runtime.shouldSuppressDshMessage({ eventType: 'C2C_MESSAGE_CREATE', data: {} })).toBe(false);

    const url = await waitFor(() => runtime!.onebotUrl);
    client = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      client!.once('open', () => resolve());
      client!.once('error', reject);
    });

    runtime.onEvent({
      eventType: 'C2C_MESSAGE_CREATE',
      data: {
        id: 'RAW_1',
        author: { user_openid: 'USER_A', username: 'Alice' },
        content: 'hello',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    });
    const event = await nextJson(client, (data) => data.post_type === 'message');
    expect(event.message_type).toBe('private');
    expect(event.raw_message).toBe('hello');
    expect(typeof event.user_id).toBe('number');

    expect(runtime.shouldSuppressDshMessage({ eventType: 'C2C_MESSAGE_CREATE', data: {}, botAppId: 'APP_ID' })).toBe(true);
    expect(runtime.shouldSuppressDshMessage({ eventType: 'C2C_MESSAGE_CREATE', data: {}, botAppId: 'OTHER' })).toBe(false);

    client.send(JSON.stringify({ action: 'get_status', echo: 'e1' }));
    const status = await nextJson(client, (data) => data.echo === 'e1');
    expect(status.status).toBe('ok');
    expect((status.data as Record<string, unknown>).online).toBe(true);

    client.send(JSON.stringify({
      action: 'send_private_msg',
      params: { user_id: event.user_id, message: 'reply' },
      echo: 'e2',
    }));
    const sent = await nextJson(client, (data) => data.echo === 'e2');
    expect(sent.status).toBe('ok');
    const sendCall = calls.find((call) => call.url.includes('/v2/users/') && call.body.content === 'reply');
    expect(sendCall).toBeDefined();
    expect(sendCall?.body.msg_id).toBe('RAW_1');
    expect(sendCall?.body.msg_seq).toBe(1);

    // 额外 QQBot 实例：事件不转发、不触发隔离
    runtime.onBot({ appId: 'OTHER', appSecret: 'OTHER_SECRET' });
    runtime.onEvent({
      eventType: 'C2C_MESSAGE_CREATE',
      botAppId: 'OTHER',
      data: {
        id: 'RAW_OTHER',
        author: { user_openid: 'USER_B', username: 'Bob' },
        content: 'from-other',
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    });
    runtime.onEvent({
      eventType: 'C2C_MESSAGE_CREATE',
      botAppId: 'APP_ID',
      data: {
        id: 'RAW_2',
        author: { user_openid: 'USER_A', username: 'Alice' },
        content: 'second',
        timestamp: '2026-01-01T00:03:00.000Z',
      },
    });
    const second = await nextJson(client, (data) => data.post_type === 'message');
    expect(second.raw_message).toBe('second');

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.shouldSuppressDshMessage({ eventType: 'C2C_MESSAGE_CREATE', data: {} })).toBe(false);
  }, 15_000);

  it('suppresses dsh during the startup window when isolation is always', async () => {
    const config = parseConfig({
      baseUrl,
      tokenBaseUrl: baseUrl,
      dataDir: dir,
      onebot: { enable: true, wsPort: 0, wsPath: '/ws', reverseUrls: [] },
      milky: { enable: false },
    });
    runtime = new TakeoverRuntime(config, { ...takeoverConf, isolation: 'always' }, logger);
    runtime.onBot({ appId: 'APP_ID', appSecret: 'APP_SECRET' });
    expect(runtime.shouldSuppressDshMessage({ eventType: 'C2C_MESSAGE_CREATE', data: {} })).toBe(true);

    await waitFor(() => runtime!.onebotUrl);
    expect(runtime.shouldSuppressDshMessage({ eventType: 'C2C_MESSAGE_CREATE', data: {} })).toBe(true);
  }, 15_000);
});
