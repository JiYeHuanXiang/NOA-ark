/**
 * dsh 侧 AI 对话服务 — 把 `noa_dsh_chat` 动作接到 dsh 的 agent 服务上。
 *
 * 设计：
 *   - 每个 `conversation_id` 对应一个 dsh agent 会话（sessionId 由
 *     conversation_id + cwd 派生），闲置超时后回收；历史由 dsh 持久化，
 *     下次同名对话会 resume。
 *   - 限制模式（默认）在该 agent 的 scope 里注册一条 `tools.guard`，
 *     任何工具调用都会被拒绝：不读文件、不写文件、不执行命令，只剩对话。
 *     安装不了 guard 时直接拒绝本次调用（fail closed），不降级。
 *   - 只返回文本回复，不向 QQ 发送任何消息；发送由外接 OneBot 程序决定。
 *
 * 本模块不 import 任何 dsh 包，只做结构化类型匹配，便于单测。
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DshChatConf } from '../config.js';
import type { NoaAiChat, NoaAiChatRequest, NoaAiChatResult } from '../noa/router.js';
import type { Logger } from '../types.js';

/** 同时保留的活跃对话数；超出后回收最久未用的。 */
const MAX_LIVE_CONVERSATIONS = 16;

/** 限制模式下所有工具调用的拒绝理由。 */
export const TOOL_DENY_REASON = 'noa_dsh_chat 限制模式：本次调用只允许对话回复，禁止读取、写入、修改或执行任何操作';

/** dsh 插件 Context 的最小读取接口。 */
export interface DshHost {
  get(name: string): unknown;
}

interface DshSessionEvent {
  type: string;
  data?: unknown;
}

interface DshSession {
  /** 下一个事件的序号（即当前日志长度）。 */
  readonly seq: number;
  eventAt(seq: number): DshSessionEvent | undefined;
}

interface DshAgentOptions {
  provider?: unknown;
  model?: unknown;
}

interface DshAgent {
  readonly session: DshSession;
  readonly options?: DshAgentOptions;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  cancel(cause: { kind: string; reason?: string }): void;
}

interface DshAgentHandle {
  agent: DshAgent;
  dispose(): Promise<void>;
}

interface DshAgents {
  create(options: Record<string, unknown>): Promise<DshAgentHandle>;
  resume(options: Record<string, unknown>): Promise<DshAgentHandle>;
}

interface DshSelection {
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
}

interface DshAgentDefaultModel {
  currentSelection(): DshSelection;
}

interface DshSessions {
  flush(session: DshSession): Promise<boolean>;
}

interface ConversationRecord {
  handle: DshAgentHandle;
  lastUsed: number;
  /** 正在执行的调用数；>0 时不参与 LRU 回收。 */
  busy: number;
}

interface AgentSetupContext {
  tools?: {
    guard?: (guard: () => string | undefined) => unknown;
  };
}

export class DshChatService implements NoaAiChat {
  private readonly records = new Map<string, ConversationRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly host: DshHost,
    private conf: DshChatConf,
    private readonly logger: Logger,
  ) {}

  /** 配置热更新：限制策略、回收时间或 cwd 变化时重建现有对话 agent。 */
  setConfig(next: DshChatConf): void {
    if (this.closed) return;
    const changed = next.restrictTools !== this.conf.restrictTools
      || next.sessionIdleMs !== this.conf.sessionIdleMs
      || next.cwd !== this.conf.cwd;
    this.conf = next;
    if (!changed) return;
    this.logger.info('dshChat 配置已更新，回收现有对话 agent 以应用新策略');
    void this.disposeAll();
  }

  async chat(request: NoaAiChatRequest): Promise<NoaAiChatResult> {
    if (this.closed) throw new Error('dsh 插件正在卸载，AI 对话已停止');
    const conversationId = request.conversationId ?? `chat-${randomUUID()}`;
    return this.enqueue(conversationId, () => this.runTurn(conversationId, request));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.disposeAll();
  }

  /** 同一 conversation_id 串行执行，避免两轮 turn 交叉。 */
  private enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.queues.set(key, next);
    return next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
  }

  private async runTurn(conversationId: string, request: NoaAiChatRequest): Promise<NoaAiChatResult> {
    const record = await this.ensureAgent(conversationId);
    record.busy += 1;
    try {
      const agent = record.handle.agent;
      const timeoutMs = request.timeoutMs ?? this.conf.timeoutMs;
      const firstSeq = agent.session.seq;
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: request.message }],
        source: { kind: 'user' },
      });
      await withTimeout(agent.whenIdle(), timeoutMs, () => {
        try {
          agent.cancel({ kind: 'hook', reason: 'noa_dsh_chat 超时' });
        } catch {
          // 轮次已经结束时 cancel 可能抛错；超时结果照常返回
        }
      });
      const { text, reason } = readTurn(agent.session, firstSeq);
      const failure = turnFailure(reason);
      if (failure !== null) throw new Error(`dsh AI 调用失败：${failure}`);
      if (text === '') {
        throw new Error('dsh AI 未返回文本回复（本轮可能被取消或只发起了工具调用）');
      }
      await this.flush(agent.session);
      return {
        reply: text,
        conversationId,
        restricted: this.conf.restrictTools,
      };
    } finally {
      record.busy -= 1;
      record.lastUsed = Date.now();
      if (this.conf.sessionIdleMs === 0) await this.disposeRecord(conversationId);
      else this.evictOverflow();
    }
  }

  private async ensureAgent(conversationId: string): Promise<ConversationRecord> {
    const existing = this.records.get(conversationId);
    if (existing !== undefined) {
      if (Date.now() - existing.lastUsed <= this.conf.sessionIdleMs) {
        existing.lastUsed = Date.now();
        return existing;
      }
      await this.disposeRecord(conversationId);
    }
    const record: ConversationRecord = {
      handle: await this.createAgent(conversationId),
      lastUsed: Date.now(),
      busy: 0,
    };
    this.records.set(conversationId, record);
    this.evictOverflow();
    return record;
  }

  private async createAgent(conversationId: string): Promise<DshAgentHandle> {
    const agents = this.service<DshAgents>('agents');
    if (agents === undefined || typeof agents.create !== 'function') {
      throw new Error('当前 dsh 没有可用的 agent 服务（dsh-agent-loop 未启用），无法调用 AI');
    }
    const cwd = path.resolve(this.conf.cwd === '' ? process.cwd() : this.conf.cwd);
    const selection = this.currentSelection();
    const common: Record<string, unknown> = {};
    if (selection !== undefined) {
      common.agentOptions = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      };
    }
    if (this.conf.restrictTools) {
      common.setup = (agentCtx: unknown): void => {
        const tools = isRecord(agentCtx) && isRecord(agentCtx.tools) ? agentCtx.tools : undefined;
        if (tools === undefined || typeof tools.guard !== 'function') {
          throw new Error('无法安装 dsh 工具限制（tools.guard 不可用），已拒绝本次 AI 调用');
        }
        (tools.guard as (guard: () => string) => unknown).call(tools, () => TOOL_DENY_REASON);
      };
    }

    const sessionId = sessionIdFor(conversationId, cwd);
    try {
      const resumed = await agents.resume({ resumeSessionId: sessionId, ...common });
      this.logger.debug(`dshChat 续接会话 ${sessionId}`);
      return resumed;
    } catch (err) {
      this.logger.debug(`dshChat 续接会话失败，改为新建：${errText(err)}`);
    }
    const created = await agents.create({ sessionId, meta: { cwd }, ...common });
    this.logger.info(`dshChat 新建对话会话（restrictTools=${this.conf.restrictTools}）`);
    return created;
  }

  private currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const service = this.service<DshAgentDefaultModel>('agentDefaultModel');
    if (service === undefined || typeof service.currentSelection !== 'function') return undefined;
    try {
      const selection = service.currentSelection();
      if (!isRecord(selection)) return undefined;
      if (typeof selection.provider !== 'string' || selection.provider === '') return undefined;
      if (typeof selection.model !== 'string' || selection.model === '') return undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async flush(session: DshSession): Promise<void> {
    const sessions = this.service<DshSessions>('sessions');
    if (sessions === undefined || typeof sessions.flush !== 'function') return;
    try {
      await sessions.flush(session);
    } catch (err) {
      this.logger.debug(`dshChat 会话 flush 失败：${errText(err)}`);
    }
  }

  private async disposeRecord(conversationId: string): Promise<void> {
    const record = this.records.get(conversationId);
    if (record === undefined) return;
    this.records.delete(conversationId);
    await disposeHandle(record.handle, this.logger);
  }

  private async disposeAll(): Promise<void> {
    const records = [...this.records.values()];
    this.records.clear();
    await Promise.all(records.map((record) => disposeHandle(record.handle, this.logger)));
  }

  private evictOverflow(): void {
    while (this.records.size > MAX_LIVE_CONVERSATIONS) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.records) {
        if (record.busy > 0) continue;
        if (record.lastUsed < oldest) {
          oldest = record.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      void this.disposeRecord(oldestKey);
    }
  }

  private service<T>(name: string): T | undefined {
    try {
      const value = this.host.get(name);
      return value === null || value === undefined ? undefined : (value as T);
    } catch {
      return undefined;
    }
  }
}

/** conversation_id + cwd 派生稳定会话 id；cwd 变化时自然分流到新会话。 */
export function sessionIdFor(conversationId: string, cwd: string): string {
  const digest = createHash('sha256').update(`${conversationId}\u0000${cwd}`).digest('hex').slice(0, 32);
  return `noa-chat-${digest}`;
}

/** 从本轮新增的会话事件里取最后一条助手文本与 turn 结束原因。 */
export function readTurn(
  session: DshSession,
  fromSeq: number,
): { text: string; reason: unknown } {
  let text = '';
  let reason: unknown;
  const end = session.seq;
  for (let seq = fromSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'assistant/message') {
      const data = event.data;
      const message = isRecord(data) ? data.message : undefined;
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      const joined = message.content
        .filter((block): block is { type: string; text: string } =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    } else if (event.type === 'turn/end') {
      reason = isRecord(event.data) ? event.data.reason : undefined;
    }
  }
  return { text, reason };
}

function turnFailure(reason: unknown): string | null {
  if (!isRecord(reason) || reason.kind !== 'error') return null;
  const error = isRecord(reason.error) ? reason.error : {};
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN';
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : '未知错误';
  return `${code}: ${message}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // 取消失败不影响超时结果
      }
      reject(new Error(`等待 dsh AI 回复超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function disposeHandle(handle: DshAgentHandle, logger: Logger): Promise<void> {
  try {
    await handle.dispose();
  } catch (err) {
    logger.debug(`dshChat 回收对话 agent 失败：${errText(err)}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
