/**
 * noa/1 扩展动作的官方实现（文档 §5 / §6）。
 *
 * 发送类动作复用桥接层的被动窗口 / 配额；管理类动作直接走官方 REST。
 * 本文件不依赖 OneBot 路由，便于单测替换 Rest 与 sender。
 */

import type { OfficialScope } from '../types.js';
import { RestApiError, type Rest, type StreamFrameResponse } from '../official/rest.js';
import type { JoinStrategyStore } from './join-policy.js';

/** 桥接层发送能力的只读视图；passive 预留由桥接层统一记账。 */
export interface NoaSendBridge {
  /** 领取一次被动槽；被动窗关闭且未启用 proactive 时抛错。 */
  reserve(scope: OfficialScope, targetOpenid: string): { msgId?: string; msgSeq?: number; passive: boolean };
  /** 主动消息真正发送成功后记账（平台判定优先）。 */
  recordProactive(scope: OfficialScope, targetOpenid: string): void;
}

export interface NoaServiceDeps {
  rest: Rest;
  sender: NoaSendBridge;
  strategyStore?: JoinStrategyStore;
  logger: { warn(message: string): void; debug?(message: string): void };
}

export interface StreamBeginOptions {
  content: string;
  contentType?: 'text' | 'markdown';
  inputMode?: 'append' | 'replace';
  isWakeup?: boolean;
}

export interface StreamBeginResult {
  streamId: string;
  index: number;
  remainMsgLen?: number;
  passive: boolean;
}

export interface StreamFrameResult {
  streamId: string;
  index: number;
  remainMsgLen?: number;
}

export interface StreamEndResult {
  streamId: string;
  ended: true;
  remainMsgLen?: number;
}

export interface JoinPolicyParams {
  groupOpenid: string;
  enable?: boolean;
  expireAt?: string;
  remark?: string;
  whitelistUsers?: string[];
  whitelistOp?: 'add' | 'del';
  execute?: boolean;
}

interface StreamState {
  userOpenid: string;
  index: number;
  contentType: 'text' | 'markdown';
  inputMode: 'append' | 'replace';
  /** 已成功下发的内容（replace 模式用于前缀校验）。 */
  sentContent: string;
  grant: { msgId?: string; msgSeq?: number };
  busy: boolean;
  /** 最后一次成功活动时间；用于惰性清理长时间无活动的流。 */
  lastActiveAt: number;
}

const STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/** 放弃 end 的流最多保留 10 分钟；同时限制活跃流数量，避免内存常驻。 */
const STREAM_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_STREAMS = 200;

export class NoaExtensionService {
  /** 流式状态只存在内存：进程重启后流丢失（文档 §6.1）。 */
  private readonly streams = new Map<string, StreamState>();

  constructor(private readonly deps: NoaServiceDeps) {}

  // —— 单聊正在输入 ——

  async sendTyping(
    scope: OfficialScope,
    targetOpenid: string,
    seconds: number,
  ): Promise<{ passive: boolean; seconds: number }> {
    if (scope !== 'c2c') throw new Error('官方群聊不支持「正在输入」状态（仅单聊）');
    const clamped = Math.min(60, Math.max(1, Math.floor(seconds)));
    const grant = this.deps.sender.reserve('c2c', targetOpenid);
    await this.deps.rest.sendTyping(
      targetOpenid,
      clamped,
      grant.msgId === undefined ? undefined : { msgId: grant.msgId, msgSeq: grant.msgSeq },
    );
    if (grant.passive === false) this.deps.sender.recordProactive('c2c', targetOpenid);
    return { passive: grant.passive, seconds: clamped };
  }

  // —— 互动 ——

  async ackInteraction(interactionId: string, code: number): Promise<void> {
    await this.deps.rest.ackInteraction(interactionId, code);
  }

  // —— 菜单 / 面板 ——

  async setMenu(menu: Record<string, unknown>): Promise<{ version?: number }> {
    return this.deps.rest.setMenu(menu);
  }

  async createPanel(panel: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.deps.rest.createPanel(panel);
  }

  async listPanels(
    scope: 'c2c' | 'group',
    cursor?: string,
    limit?: number,
  ): Promise<Record<string, unknown>> {
    return this.deps.rest.listPanels(scope, cursor, limit);
  }

  // —— 入群自动审批策略 ——

  async setJoinPolicy(params: JoinPolicyParams): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (params.enable !== undefined) body.is_enable = params.enable ? 'on' : 'off';
    if (params.expireAt !== undefined) body.expire_at = params.expireAt;
    if (params.remark !== undefined) body.remark = params.remark;

    let strategyId = this.deps.strategyStore?.get(params.groupOpenid);
    let created: Record<string, unknown>;
    if (strategyId === undefined) {
      created = await this.deps.rest.createJoinApprovalStrategy({
        group_openids: [params.groupOpenid],
        ...body,
      });
      strategyId = stringOf(created.strategy_id);
      if (strategyId === '') throw new Error('官方创建审批策略未返回 strategy_id');
      this.deps.strategyStore?.set(params.groupOpenid, strategyId);
    } else {
      // 只有 whitelist/execute 时不必发空 PATCH（官方会校验至少一个更新字段）。
      created = Object.keys(body).length === 0
        ? {}
        : await this.deps.rest.updateJoinApprovalStrategy(strategyId, body);
    }

    const result: Record<string, unknown> = {
      strategy_id: strategyId,
      // 只有 whitelist/execute 时没有策略响应，真实开关状态未知，返回空串而不是猜测。
      is_enable: stringOf(created.is_enable)
        || (params.enable === undefined ? '' : params.enable ? 'on' : 'off'),
      expire_at: stringOf(created.expire_at) || params.expireAt || '',
    };
    if (params.whitelistUsers !== undefined && params.whitelistUsers.length > 0) {
      result.whitelist = await this.deps.rest.updateJoinApprovalWhitelist(
        strategyId,
        params.whitelistOp ?? 'add',
        params.whitelistUsers,
      );
    }
    if (params.execute === true) {
      result.execute = await this.deps.rest.executeJoinApprovalStrategy(strategyId);
    }
    return result;
  }

  // —— 单聊流式 ——

  async streamBegin(userOpenid: string, options: StreamBeginOptions): Promise<StreamBeginResult> {
    if (options.content.trim() === '') throw new Error('noa_stream_begin 的 content 不能为空');
    const contentType = options.contentType ?? 'markdown';
    const inputMode = options.inputMode ?? 'replace';
    const isWakeup = options.isWakeup === true;
    const grant = isWakeup
      ? { msgId: undefined, msgSeq: undefined, passive: false }
      : this.deps.sender.reserve('c2c', userOpenid);

    const resp = await this.sendFrameWithRetry(userOpenid, {
      index: 0,
      inputState: 1,
      contentType,
      inputMode,
      content: options.content,
      msgId: grant.msgId,
      msgSeq: grant.msgSeq,
      isWakeup,
    });
    if (grant.passive === false && !isWakeup) this.deps.sender.recordProactive('c2c', userOpenid);

    const streamId = resp.streamMsgId;
    if (streamId === '') throw new Error('官方流式消息未返回 stream_msg_id');
    this.pruneStreams();
    this.streams.set(streamId, {
      userOpenid,
      index: 1,
      contentType,
      inputMode,
      sentContent: options.content,
      grant: { msgId: grant.msgId, msgSeq: grant.msgSeq },
      busy: false,
      lastActiveAt: Date.now(),
    });
    return { streamId, index: 1, remainMsgLen: resp.remainMsgLen, passive: grant.passive && !isWakeup };
  }

  async streamAppend(streamId: string, content: string): Promise<StreamFrameResult> {
    const state = this.requireStream(streamId);
    if (state.busy) throw new Error('该流上一帧尚未完成，请串行调用 noa_stream_append / noa_stream_end');
    if (content.trim() === '') throw new Error('noa_stream_append 的 content 不能为空');
    this.assertPrefix(state, content);

    state.busy = true;
    try {
      const resp = await this.sendFrameWithRetry(state.userOpenid, {
        streamMsgId: streamId,
        index: state.index,
        inputState: 1,
        contentType: state.contentType,
        inputMode: state.inputMode,
        content,
        msgId: state.grant.msgId,
        msgSeq: state.grant.msgSeq,
      });
      state.index += 1;
      state.sentContent = state.inputMode === 'replace' ? content : state.sentContent + content;
      state.lastActiveAt = Date.now();
      return { streamId, index: state.index, remainMsgLen: resp.remainMsgLen };
    } finally {
      state.busy = false;
    }
  }

  async streamEnd(streamId: string, content?: string): Promise<StreamEndResult> {
    const state = this.requireStream(streamId);
    if (state.busy) throw new Error('该流上一帧尚未完成，请串行调用 noa_stream_append / noa_stream_end');
    const finalContent = content ?? state.sentContent;
    if (finalContent.trim() === '') throw new Error('noa_stream_end 的 content 不能为空');
    this.assertPrefix(state, finalContent);

    state.busy = true;
    try {
      const resp = await this.sendFrameWithRetry(state.userOpenid, {
        streamMsgId: streamId,
        index: state.index,
        inputState: 10,
        contentType: state.contentType,
        inputMode: state.inputMode,
        content: finalContent,
        msgId: state.grant.msgId,
        msgSeq: state.grant.msgSeq,
      });
      this.streams.delete(streamId);
      return { streamId, ended: true, remainMsgLen: resp.remainMsgLen };
    } finally {
      state.busy = false;
    }
  }

  // —— 互动召回 ——

  async sendWakeup(userOpenid: string, content: string): Promise<void> {
    if (content.trim() === '') throw new Error('noa_send_wakeup 的 message 不能为空');
    await this.deps.rest.sendWakeup(userOpenid, content);
  }

  // —— helpers ——

  private pruneStreams(): void {
    const cutoff = Date.now() - STREAM_TTL_MS;
    for (const [id, state] of this.streams) {
      if (state.lastActiveAt < cutoff) this.streams.delete(id);
    }
    while (this.streams.size >= MAX_ACTIVE_STREAMS) {
      const oldest = this.streams.keys().next();
      if (oldest.done === true) break;
      this.streams.delete(oldest.value);
    }
  }

  private requireStream(streamId: string): StreamState {
    const state = this.streams.get(streamId);
    if (state === undefined) throw new Error('流不存在或已结束（重复调用 noa_stream_end 无效）');
    return state;
  }

  private assertPrefix(state: StreamState, content: string): void {
    if (state.inputMode !== 'replace') return;
    if (!content.startsWith(state.sentContent)) {
      throw new Error('input_mode=replace 时 content 必须以上一次已下发内容为前缀（平台错误码 40007）');
    }
  }

  /** 429 / 平台 50002 按下一个 index 指数退避重试（1000/2000/4000ms，最多 3 次）。 */
  private async sendFrameWithRetry(
    userOpenid: string,
    options: Parameters<Rest['sendStreamFrame']>[1],
  ): Promise<StreamFrameResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= STREAM_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.deps.rest.sendStreamFrame(userOpenid, options);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof RestApiError
          && (err.httpStatus === 429 || err.bizCode === 50002);
        if (!retryable || attempt === STREAM_RETRY_DELAYS_MS.length) break;
        const delay = STREAM_RETRY_DELAYS_MS[attempt] ?? 4_000;
        this.deps.logger.warn(`[noa] 流式消息触发限流（${String(err.bizCode ?? err.httpStatus)}），${delay}ms 后重试`);
        await sleep(delay);
      }
    }
    throw lastError;
  }
}

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
