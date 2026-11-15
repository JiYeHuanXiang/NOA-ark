import { describe, expect, it } from 'vitest';
import {
  connectGateway,
  DEFAULT_INTENTS,
  FALLBACK_INTENTS,
  type WebSocketLike,
} from '../src/official/gateway.js';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private fired = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.fire(code);
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  simulateClose(code: number): void {
    this.fire(code);
  }

  private fire(code: number): void {
    if (this.fired) return;
    this.fired = true;
    this.onclose?.({ code });
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待条件超时');
}

describe('official gateway close codes', () => {
  function makeGateway() {
    FakeSocket.instances = [];
    return connectGateway({
      appId: 'app',
      appSecret: 'secret',
      baseUrl: 'https://api.example.test',
      tokenBaseUrl: 'https://api.example.test',
      logger: quietLogger,
      tokenProvider: async () => 'TOKEN',
      fetchImpl: (async () => jsonResponse({ url: 'wss://gateway.example.test' })) as unknown as typeof fetch,
      WebSocketCtor: FakeSocket,
      reconnectDelayMs: 1,
    });
  }

  function lastFrame(socket: FakeSocket): { op: number; d: Record<string, unknown> } {
    return JSON.parse(socket.sent.at(-1) ?? '{}') as { op: number; d: Record<string, unknown> };
  }

  it('resumes after 4009 and re-identifies after 4006', async () => {
    const gateway = makeGateway();
    try {
      const first = await waitFor(() => FakeSocket.instances[0]);
      first.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
      first.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'SESSION_1' } });

      first.simulateClose(4009);
      const second = await waitFor(() => FakeSocket.instances[1]);
      second.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
      expect(lastFrame(second)).toMatchObject({ op: 6, d: { session_id: 'SESSION_1' } });

      second.receive({ op: 0, t: 'RESUMED', s: 2, d: {} });
      second.simulateClose(4006);
      const third = await waitFor(() => FakeSocket.instances[2]);
      third.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
      expect(lastFrame(third).op).toBe(2);
    } finally {
      gateway.stop();
    }
  });

  it('stops reconnecting when the platform permanently closes the bot', async () => {
    const gateway = makeGateway();
    try {
      const first = await waitFor(() => FakeSocket.instances[0]);
      first.simulateClose(4914);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(FakeSocket.instances).toHaveLength(1);
      await expect(gateway.done).resolves.toBeUndefined();
    } finally {
      gateway.stop();
    }
  });
});

describe('official gateway intents', () => {
  it('falls back from GROUP_MEMBER intents to GROUP_AND_C2C when the platform answers 4014', async () => {
    FakeSocket.instances = [];
    const gateway = connectGateway({
      appId: 'app',
      appSecret: 'secret',
      baseUrl: 'https://api.example.test',
      tokenBaseUrl: 'https://api.example.test',
      logger: quietLogger,
      tokenProvider: async () => 'TOKEN',
      fetchImpl: (async () => jsonResponse({ url: 'wss://gateway.example.test' })) as unknown as typeof fetch,
      WebSocketCtor: FakeSocket,
      reconnectDelayMs: 1,
    });

    try {
      const first = await waitFor(() => FakeSocket.instances[0]);
      first.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
      const identify1 = JSON.parse(first.sent.at(-1) ?? '{}') as { op: number; d: { intents: number } };
      expect(identify1.op).toBe(2);
      expect(identify1.d.intents).toBe(DEFAULT_INTENTS);
      expect(DEFAULT_INTENTS).toBe((1 << 25) | (1 << 24));

      first.simulateClose(4014);

      const second = await waitFor(() => FakeSocket.instances[1]);
      second.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
      const identify2 = JSON.parse(second.sent.at(-1) ?? '{}') as { op: number; d: { intents: number } };
      expect(identify2.op).toBe(2);
      expect(identify2.d.intents).toBe(FALLBACK_INTENTS);
      expect(FALLBACK_INTENTS).toBe(1 << 25);
    } finally {
      gateway.stop();
    }
  });
});
