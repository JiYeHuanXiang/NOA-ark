import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { parseConfig } from '../src/config.js';
import { IdMapper } from '../src/core/idmap.js';
import { RecentIdSet, startBridge, type BridgeHandle } from '../src/bridge.js';
import type { GatewayHandle, OfficialEventEnvelope } from '../src/official/gateway.js';
import type { Rest } from '../src/official/rest.js';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Harness {
  wsServer: WebSocketServer;
  appPort: number;
  gateway: GatewayHandle;
  bridge: BridgeHandle;
  emit: (event: OfficialEventEnvelope) => void;
  restCalls: Array<{ target: { scope: string; targetId: string }; text: string; options?: unknown }>;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    await fn?.();
  }
});

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

async function setup(mode: 'forward' | 'reverse' | 'both' = 'both'): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-bridge-'));

  const wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wsServer.once('listening', () => resolve()));
  const addr = wsServer.address();
  const appPort = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const listeners: Array<(event: OfficialEventEnvelope) => void> = [];
  const gateway = {
    ready: Promise.resolve(),
    done: new Promise<void>(() => undefined),
    get online() {
      return true;
    },
    stop: () => undefined,
    onEvent: (handler: (event: OfficialEventEnvelope) => void) => {
      listeners.push(handler);
    },
  } as unknown as GatewayHandle;

  const restCalls: Harness['restCalls'] = [];
  const rest = {
    getBotInfo: async () => ({ id: 'BOT_OPENID' }),
    sendText: async (target: { scope: string; targetId: string }, text: string, options?: unknown) => {
      restCalls.push({ target, text, options });
      return { id: 'OFFICIAL_MSG_1' };
    },
    recallMessage: async () => undefined,
    setGroupBan: async () => undefined,
    setGroupAddRequest: async () => undefined,
  } as unknown as Rest;

  const mapper = new IdMapper({ file: path.join(dir, 'idmap.json') });
  const config = parseConfig({
    idMode: 'mapped',
    passiveOverflow: 'fail',
    onebot: {
      enable: true,
      mode,
      accessToken: '',
      wsPort: 0,
      wsPath: '/ws',
      reverseUrls: [`ws://127.0.0.1:${appPort}`],
    },
    milky: { enable: false },
  });

  const bridge = await startBridge({
    config,
    logger: quietLogger,
    dataDir: dir,
    appId: 'app1',
    appSecret: 'secret',
    mapper,
    rest,
    gateway,
    now: () => 1_000_000,
  });
  cleanups.push(async () => {
    await bridge.close();
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  });

  return {
    wsServer,
    appPort,
    gateway,
    bridge,
    restCalls,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    close: async () => undefined,
  };
}

describe('RecentIdSet', () => {
  it('rejects duplicate ids within the TTL and accepts them after expiry', () => {
    let now = 0;
    const set = new RecentIdSet(10, 100, () => now);
    expect(set.add('RAW_1')).toBe(true);
    expect(set.add('RAW_1')).toBe(false);
    now = 101;
    expect(set.add('RAW_1')).toBe(true);
  });

  it('evicts the oldest entries beyond capacity', () => {
    const set = new RecentIdSet(2, 1000, () => 0);
    expect(set.add('a')).toBe(true);
    expect(set.add('b')).toBe(true);
    expect(set.add('c')).toBe(true);
    expect(set.add('a')).toBe(true);
  });

  it('does not dedupe empty ids', () => {
    const set = new RecentIdSet(2, 1000, () => 0);
    expect(set.add('')).toBe(true);
    expect(set.add('')).toBe(true);
  });
});

describe('onebot.mode', () => {
  it('reverse 模式只拨 reverseUrls，不监听正向端口', async () => {
    const harness = await setup('reverse');
    expect(harness.bridge.onebot).toBeUndefined();
    expect(harness.bridge.reverse).toBeDefined();

    const app = await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('反向 WS 未连接')), 5000);
      harness.wsServer.once('connection', (ws) => {
        clearTimeout(timer);
        resolve(ws);
      });
    });
    cleanups.push(() => app.terminate());
    expect((await nextJson(app)).meta_event_type).toBe('lifecycle');
  });

  it('forward 模式只监听正向端口，不拨 reverseUrls', async () => {
    const harness = await setup('forward');
    expect(harness.bridge.onebot).toBeDefined();
    expect(harness.bridge.reverse).toBeUndefined();
  });
});

describe('bridge end-to-end', () => {
  it('fans official events to reverse WS and routes send_group_msg back to official REST with msg_id + msg_seq', async () => {
    const harness = await setup();

    const app = await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('反向 WS 未连接')), 5000);
      harness.wsServer.once('connection', (ws) => {
        clearTimeout(timer);
        resolve(ws);
      });
    });
    cleanups.push(() => app.terminate());

    const lifecycle = await nextJson(app);
    expect(lifecycle.meta_event_type).toBe('lifecycle');

    harness.emit({
      eventType: 'GROUP_AT_MESSAGE_CREATE',
      data: {
        id: 'RAW_1',
        group_openid: 'GROUP_A',
        author: { user_openid: 'USER_B', username: 'Bob' },
        content: '<qqbot-at-user id="BOT_OPENID"/>hello',
        timestamp: new Date(1_000_000).toISOString(),
      },
    });

    const messageEvent = await nextJson(app, (data) => data.post_type === 'message');
    expect(messageEvent.message_type).toBe('group');
    expect(String(messageEvent.raw_message)).toContain('hello');

    app.send(
      JSON.stringify({
        action: 'send_group_msg',
        params: { group_id: messageEvent.group_id, message: '收到' },
        echo: 'e1',
      }),
    );
    const response = await nextJson(app, (data) => data.retcode !== undefined);
    expect(response.status).toBe('ok');
    expect(response.echo).toBe('e1');

    expect(harness.restCalls).toHaveLength(1);
    expect(harness.restCalls[0]).toMatchObject({
      target: { scope: 'group', targetId: 'GROUP_A' },
      text: '收到',
      options: { msgId: 'RAW_1', msgSeq: 1 },
    });
  });

  it('keeps get_msg sender user_id stable and equal to the event user_id', async () => {
    const harness = await setup();

    const app = await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('反向 WS 未连接')), 5000);
      harness.wsServer.once('connection', (ws) => {
        clearTimeout(timer);
        resolve(ws);
      });
    });
    cleanups.push(() => app.terminate());
    await nextJson(app);

    harness.emit({
      eventType: 'GROUP_AT_MESSAGE_CREATE',
      data: {
        id: 'RAW_IN_GET_MSG',
        group_openid: 'GROUP_A',
        author: { user_openid: 'USER_B', username: 'Bob' },
        content: 'hello',
        timestamp: new Date(1_000_000).toISOString(),
      },
    });
    const messageEvent = await nextJson(app, (data) => data.post_type === 'message');
    const eventUserId = Number(messageEvent.user_id);

    app.send(
      JSON.stringify({
        action: 'get_msg',
        params: { message_id: messageEvent.message_id },
        echo: 'g1',
      }),
    );
    const first = await nextJson(app, (data) => data.echo === 'g1');
    expect(first.status).toBe('ok');
    expect((first.data as { sender: { user_id: number } }).sender.user_id).toBe(eventUserId);

    app.send(
      JSON.stringify({
        action: 'get_msg',
        params: { message_id: messageEvent.message_id },
        echo: 'g2',
      }),
    );
    const second = await nextJson(app, (data) => data.echo === 'g2');
    expect(second.status).toBe('ok');
    expect((second.data as { sender: { user_id: number } }).sender.user_id).toBe(eventUserId);
  });

  it('delivers a repeated official msg_id only once', async () => {
    const harness = await setup();

    const app = await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('反向 WS 未连接')), 5000);
      harness.wsServer.once('connection', (ws) => {
        clearTimeout(timer);
        resolve(ws);
      });
    });
    cleanups.push(() => app.terminate());
    await nextJson(app);

    const received: string[] = [];
    app.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      if (parsed.post_type === 'message') received.push(String(parsed.raw_message));
    });

    const base = {
      eventType: 'GROUP_MESSAGE_CREATE',
      data: {
        id: 'RAW_DUP',
        group_openid: 'GROUP_A',
        author: { member_openid: 'USER_B', username: 'Bob' },
        content: 'first',
        timestamp: new Date(1_000_000).toISOString(),
      },
    };
    harness.emit(base);
    harness.emit({ ...base, data: { ...base.data, content: 'duplicate' } });

    harness.emit({ ...base, eventType: 'GROUP_AT_MESSAGE_CREATE', data: { ...base.data, content: 'at variant' } });
    harness.emit({ ...base, data: { ...base.data, id: 'RAW_DUP_2', content: 'second' } });

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(received).toEqual(['first', 'second']);
  });
});
