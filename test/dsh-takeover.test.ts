import { describe, expect, it, vi } from 'vitest';
import {
  installTakeover,
  type CapturedBot,
  type QqbotClassLike,
  type TakeoverRawEvent,
  type TakeoverSink,
} from '../src/dsh/takeover.js';
import type { Logger } from '../src/types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface FakeBot {
  handled: unknown[];
  on(event: string, handler: (...args: unknown[]) => unknown): FakeBot;
  emit(event: string, ...args: unknown[]): Promise<void>;
  handleInboundMessage(raw: unknown): Promise<void>;
  getCredentials(): { appId: string; clientSecret: string };
}

function makeFakeClass(withInbound = true): new (appId: string, secret: string) => FakeBot {
  const Cls = class FakeQQBot implements FakeBot {
    readonly handled: unknown[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

    constructor(
      private readonly appId: string,
      private readonly secret: string,
    ) {}

    on(event: string, handler: (...args: unknown[]) => unknown): FakeBot {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    getCredentials(): { appId: string; clientSecret: string } {
      return { appId: this.appId, clientSecret: this.secret };
    }

    async emit(event: string, ...args: unknown[]): Promise<void> {
      for (const handler of this.handlers.get(event) ?? []) {
        await handler(...args);
      }
    }

    async handleInboundMessage(raw: unknown): Promise<void> {
      this.handled.push(raw);
      await this.emit('message', { message: raw }, raw);
    }
  };
  if (!withInbound) {
    delete (Cls.prototype as Partial<FakeBot>).handleInboundMessage;
  }
  return Cls;
}

function install(
  QQBot: new (appId: string, secret: string) => FakeBot,
  sink: TakeoverSink,
): ReturnType<typeof installTakeover> {
  return installTakeover(QQBot as unknown as QqbotClassLike, sink, logger);
}

function inbound(rawEventType = 'C2C_MESSAGE_CREATE', id = 'm1'): Record<string, unknown> {
  return {
    rawEventType,
    kind: 'c2c',
    senderId: 'USER_A',
    content: 'hello',
    messageId: id,
    timestamp: '2026-01-01T00:01:00.000Z',
    raw: { id, author: { user_openid: 'USER_A', username: 'Alice' }, content: 'hello' },
  };
}

describe('dsh takeover', () => {
  it('captures credentials and forwards rawEvent without breaking dsh-qqbot handlers', async () => {
    const QQBot = makeFakeClass();
    const events: TakeoverRawEvent[] = [];
    const bots: CapturedBot[] = [];
    const handle = install(QQBot, {
      onBot: (bot) => bots.push(bot),
      onEvent: (event) => events.push(event),
    });
    try {
      const bot = new QQBot('APP_ID', 'APP_SECRET');
      const original = vi.fn();
      bot.on('rawEvent', original);

      await bot.emit('rawEvent', { eventType: 'GROUP_ADD_ROBOT', data: { group_openid: 'G1' } });

      expect(bots).toEqual([{ appId: 'APP_ID', appSecret: 'APP_SECRET' }]);
      expect(events).toEqual([
        { eventType: 'GROUP_ADD_ROBOT', data: { group_openid: 'G1' }, botAppId: 'APP_ID' },
      ]);
      expect(original).toHaveBeenCalledTimes(1);
    } finally {
      handle.uninstall();
    }
  });

  it('forwards inbound messages before middleware and suppresses dsh when isolated', async () => {
    const QQBot = makeFakeClass();
    const events: TakeoverRawEvent[] = [];
    let suppress = false;
    const handle = install(QQBot, {
      onBot: () => undefined,
      onEvent: (event) => events.push(event),
      shouldSuppressDshMessage: () => suppress,
    });
    try {
      const bot = new QQBot('APP_ID', 'APP_SECRET');
      const onMessage = vi.fn();
      bot.on('message', onMessage);

      const first = inbound('C2C_MESSAGE_CREATE', 'm1');
      await bot.handleInboundMessage(first);
      expect(bot.handled).toHaveLength(1);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(events[0]).toEqual({
        eventType: 'C2C_MESSAGE_CREATE',
        data: first.raw,
        botAppId: 'APP_ID',
      });

      suppress = true;
      const second = inbound('GROUP_AT_MESSAGE_CREATE', 'm2');
      await bot.handleInboundMessage(second);
      // OneBot 仍收到；dsh-qqbot 的 handleInboundMessage 完全没有进入
      expect(bot.handled).toHaveLength(1);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(2);
      expect(events[1]?.eventType).toBe('GROUP_AT_MESSAGE_CREATE');
    } finally {
      handle.uninstall();
    }
  });

  it('forwards INTERACTION_CREATE from the interaction event', async () => {
    const QQBot = makeFakeClass();
    const events: TakeoverRawEvent[] = [];
    const handle = install(QQBot, {
      onBot: () => undefined,
      onEvent: (event) => events.push(event),
    });
    try {
      const bot = new QQBot('APP_ID', 'APP_SECRET');
      const interaction = { id: 'i1', type: 11, scene: 'group', data: { resolved: {} } };
      await bot.emit('interaction', { bot, event: interaction }, interaction);
      expect(events).toEqual([
        { eventType: 'INTERACTION_CREATE', data: interaction, botAppId: 'APP_ID' },
      ]);
    } finally {
      handle.uninstall();
    }
  });

  it('falls back to emit(message) when the SDK has no handleInboundMessage', async () => {
    const QQBot = makeFakeClass(false);
    const events: TakeoverRawEvent[] = [];
    const handle = install(QQBot, {
      onBot: () => undefined,
      onEvent: (event) => events.push(event),
      shouldSuppressDshMessage: () => true,
    });
    try {
      const bot = new QQBot('APP_ID', 'APP_SECRET');
      const onMessage = vi.fn();
      bot.on('message', onMessage);
      const raw = inbound('C2C_MESSAGE_CREATE', 'm1');

      await bot.emit('message', { message: raw }, raw);

      expect(events).toHaveLength(1);
      expect(events[0]?.data).toEqual(raw.raw);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      handle.uninstall();
    }
  });

  it('restores the original emit and handleInboundMessage after the last sink uninstalls', () => {
    const QQBot = makeFakeClass();
    const originalEmit = QQBot.prototype.emit;
    const originalInbound = QQBot.prototype.handleInboundMessage;
    const sink: TakeoverSink = { onBot: () => undefined, onEvent: () => undefined };

    const first = install(QQBot, sink);
    const second = install(QQBot, sink);
    expect(QQBot.prototype.emit).not.toBe(originalEmit);
    expect(QQBot.prototype.handleInboundMessage).not.toBe(originalInbound);

    first.uninstall();
    expect(QQBot.prototype.emit).not.toBe(originalEmit);
    second.uninstall();
    expect(QQBot.prototype.emit).toBe(originalEmit);
    expect(QQBot.prototype.handleInboundMessage).toBe(originalInbound);
  });

  it('fans out to multiple sinks and stops on uninstall', async () => {
    const QQBot = makeFakeClass();
    const first: TakeoverRawEvent[] = [];
    const second: TakeoverRawEvent[] = [];
    const h1 = install(QQBot, { onBot: () => undefined, onEvent: (e) => first.push(e) });
    const h2 = install(QQBot, { onBot: () => undefined, onEvent: (e) => second.push(e) });
    try {
      const bot = new QQBot('APP_ID', 'APP_SECRET');
      await bot.emit('rawEvent', { eventType: 'A', data: {} });
      await bot.emit('rawEvent', { eventType: 'B', data: {} });
      expect(first.map((e) => e.eventType)).toEqual(['A', 'B']);
      expect(second.map((e) => e.eventType)).toEqual(['A', 'B']);

      h1.uninstall();
      await bot.emit('rawEvent', { eventType: 'C', data: {} });
      expect(first.map((e) => e.eventType)).toEqual(['A', 'B']);
      expect(second.map((e) => e.eventType)).toEqual(['A', 'B', 'C']);
    } finally {
      h1.uninstall();
      h2.uninstall();
    }
  });

  it('rejects a class without emit', () => {
    expect(() =>
      installTakeover({ prototype: {} } as QqbotClassLike, { onBot: () => undefined, onEvent: () => undefined }, logger),
    ).toThrow(/emit/);
  });
});
