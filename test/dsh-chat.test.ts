import { describe, expect, it, vi } from 'vitest';
import type { DshChatConf } from '../src/config.js';
import { DshChatService, sessionIdFor, TOOL_DENY_REASON, type DshHost } from '../src/dsh/ai.js';
import type { Logger } from '../src/types.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function conf(overrides: Partial<DshChatConf> = {}): DshChatConf {
  return {
    enable: true,
    restrictTools: true,
    timeoutMs: 5_000,
    sessionIdleMs: 600_000,
    cwd: '',
    ...overrides,
  };
}

interface FakeEvent {
  type: string;
  data?: unknown;
}

interface AgentBehavior {
  reply?: string;
  fail?: 'error' | 'hang';
}

function makeSession(): {
  seq: number;
  events: FakeEvent[];
  eventAt(seq: number): FakeEvent | undefined;
  append(event: FakeEvent): void;
} {
  const events: FakeEvent[] = [];
  return {
    get seq() {
      return events.length;
    },
    events,
    eventAt(seq: number) {
      return events[seq];
    },
    append(event: FakeEvent) {
      events.push(event);
    },
  };
}

function makeAgent(behavior: AgentBehavior = {}) {
  const session = makeSession();
  const agent = {
    session,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    cancel: vi.fn(),
    followup: vi.fn((message: unknown) => {
      session.append({ type: 'turn/start', data: { turn: 1 } });
      session.append({ type: 'user/message', data: { message } });
      if (behavior.fail === 'hang') return;
      if (behavior.fail === 'error') {
        session.append({
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'bad key' } } },
        });
        return;
      }
      session.append({
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: behavior.reply ?? '你好' }] },
        },
      });
      session.append({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    }),
    whenIdle: vi.fn(() => {
      if (behavior.fail === 'hang') return new Promise<void>(() => undefined);
      return Promise.resolve();
    }),
  };
  return agent;
}

interface CreateEntry {
  options: Record<string, unknown>;
  agent: ReturnType<typeof makeAgent>;
  guards: Array<() => string | undefined>;
}

interface HostState {
  created: CreateEntry[];
  resumed: string[];
  disposed: unknown[];
}

function makeHost(
  behavior: AgentBehavior & { tools?: boolean; noAgents?: boolean } = {},
): { host: DshHost; state: HostState } {
  const state: HostState = { created: [], resumed: [], disposed: [] };
  const host: DshHost = {
    get(name: string) {
      if (name === 'agents') {
        if (behavior.noAgents === true) return undefined;
        return {
          resume: async (options: Record<string, unknown>) => {
            state.resumed.push(String(options.resumeSessionId));
            throw new Error('SESSION_QUERY_SESSION_NOT_FOUND');
          },
          create: async (options: Record<string, unknown>) => {
            const agent = makeAgent(behavior);
            const guards: Array<() => string | undefined> = [];
            if (typeof options.setup === 'function') {
              const tools = behavior.tools === false
                ? undefined
                : { guard: (guard: () => string | undefined) => guards.push(guard) };
              (options.setup as (ctx: unknown) => void)({ tools });
            }
            state.created.push({ options, agent, guards });
            return {
              agent,
              dispose: async () => {
                state.disposed.push(agent);
              },
            };
          },
        };
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) };
      }
      if (name === 'sessions') return { flush: async () => true };
      return undefined;
    },
  };
  return { host, state };
}

describe('DshChatService', () => {
  it('installs a deny-all tool guard in restricted mode and returns the reply', async () => {
    const { host, state } = makeHost({ reply: '在的' });
    const service = new DshChatService(host, conf(), logger);

    const result = await service.chat({ message: '在吗' });
    expect(result).toEqual({
      reply: '在的',
      conversationId: result.conversationId,
      restricted: true,
    });
    expect(result.conversationId).toMatch(/^chat-/);
    expect(state.created).toHaveLength(1);
    expect(state.created[0].guards).toHaveLength(1);
    expect(state.created[0].guards[0]()).toBe(TOOL_DENY_REASON);
    expect(state.created[0].options.agentOptions).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
    expect(state.created[0].agent.followup).toHaveBeenCalledTimes(1);
    const sent = state.created[0].agent.followup.mock.calls[0][0] as {
      role: string;
      content: Array<{ type: string; text: string }>;
      source: { kind: string };
    };
    expect(sent.role).toBe('user');
    expect(sent.content).toEqual([{ type: 'text', text: '在吗' }]);
    expect(sent.source).toEqual({ kind: 'user' });
  });

  it('skips the guard when the restriction switch is off', async () => {
    const { host, state } = makeHost();
    const service = new DshChatService(host, conf({ restrictTools: false }), logger);

    const result = await service.chat({ message: 'hi' });
    expect(result.restricted).toBe(false);
    expect(state.created[0].options.setup).toBeUndefined();
    expect(state.created[0].guards).toHaveLength(0);
  });

  it('fails closed when tools.guard is unavailable in restricted mode', async () => {
    const { host, state } = makeHost({ tools: false });
    const service = new DshChatService(host, conf(), logger);

    await expect(service.chat({ message: 'hi' })).rejects.toThrow('tools.guard');
    expect(state.created).toHaveLength(0);
  });

  it('reports a failed turn as an error', async () => {
    const { host } = makeHost({ fail: 'error' });
    const service = new DshChatService(host, conf(), logger);

    await expect(service.chat({ message: 'hi' })).rejects.toThrow('AUTH: bad key');
  });

  it('cancels the turn and rejects on timeout', async () => {
    const { host, state } = makeHost({ fail: 'hang' });
    const service = new DshChatService(host, conf({ timeoutMs: 30 }), logger);

    await expect(service.chat({ message: 'hi' })).rejects.toThrow('超时');
    expect(state.created[0].agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'noa_dsh_chat 超时' });
  });

  it('reuses one agent per conversation and separates different ids', async () => {
    const { host, state } = makeHost();
    const service = new DshChatService(host, conf(), logger);

    await service.chat({ message: 'a', conversationId: 'peer-1' });
    await service.chat({ message: 'b', conversationId: 'peer-1' });
    await service.chat({ message: 'c', conversationId: 'peer-2' });

    expect(state.created).toHaveLength(2);
    expect(state.created[0].agent.followup).toHaveBeenCalledTimes(2);
    expect(state.resumed).toEqual([sessionIdFor('peer-1', process.cwd()), sessionIdFor('peer-2', process.cwd())]);
    expect(state.created[0].options.sessionId).toBe(sessionIdFor('peer-1', process.cwd()));
  });

  it('recycles the agent after each turn when sessionIdleMs is 0', async () => {
    const { host, state } = makeHost();
    const service = new DshChatService(host, conf({ sessionIdleMs: 0 }), logger);

    await service.chat({ message: 'a', conversationId: 'peer-1' });
    await service.chat({ message: 'b', conversationId: 'peer-1' });

    expect(state.created).toHaveLength(2);
    expect(state.disposed).toHaveLength(2);
  });

  it('recycles live agents when the restriction switch changes', async () => {
    const { host, state } = makeHost();
    const service = new DshChatService(host, conf(), logger);

    await service.chat({ message: 'a', conversationId: 'peer-1' });
    service.setConfig(conf({ restrictTools: false }));
    await service.chat({ message: 'b', conversationId: 'peer-1' });

    expect(state.disposed).toHaveLength(1);
    expect(state.created).toHaveLength(2);
    expect(state.created[1].options.setup).toBeUndefined();
  });

  it('closes every live conversation', async () => {
    const { host, state } = makeHost();
    const service = new DshChatService(host, conf(), logger);

    await service.chat({ message: 'a', conversationId: 'peer-1' });
    await service.chat({ message: 'b', conversationId: 'peer-2' });
    await service.close();

    expect(state.disposed).toHaveLength(2);
  });

  it('fails clearly without the agent service', async () => {
    const { host } = makeHost({ noAgents: true });
    const service = new DshChatService(host, conf(), logger);

    await expect(service.chat({ message: 'hi' })).rejects.toThrow('agent 服务');
  });

  it('rejects new calls after close', async () => {
    const { host } = makeHost();
    const service = new DshChatService(host, conf(), logger);
    await service.close();

    await expect(service.chat({ message: 'hi' })).rejects.toThrow('卸载');
  });
});

describe('sessionIdFor', () => {
  it('is stable per conversation and splits by cwd', () => {
    expect(sessionIdFor('peer-1', 'C:\\a')).toBe(sessionIdFor('peer-1', 'C:\\a'));
    expect(sessionIdFor('peer-1', 'C:\\a')).not.toBe(sessionIdFor('peer-1', 'C:\\b'));
    expect(sessionIdFor('peer-1', 'C:\\a')).not.toBe(sessionIdFor('peer-2', 'C:\\a'));
    expect(sessionIdFor('peer-1', 'C:\\a')).toMatch(/^noa-chat-[0-9a-f]{32}$/);
  });
});
