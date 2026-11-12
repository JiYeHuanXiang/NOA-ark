/**
 * MsgSeqManager — 被动回复的 msg_seq 与窗口管理。
 *
 * 官方规则（2026 口径）：
 *   群聊：收到用户消息后 5 分钟内，最多 5 条被动回复（msg_seq 1..5）
 *   单聊：60 分钟内最多 4 条
 * 同一 msg_id + 相同 msg_seq 重发会被平台拒绝，必须递增。
 *
 * 窗口按「官方原始 msg_id」记账；网关重连后的重复投递只登记一次，
 * 不会重置窗口起点，也不会额外消耗被动配额。
 */

import type { OfficialScope } from '../types.js';

export interface PassiveWindow {
  /** 窗口起点（毫秒时间戳）。 */
  windowStart: number;
  /** 已领取的被动回复条数。 */
  used: number;
}

export interface MsgSeqDecision {
  /** 是否仍在被动窗口内。 */
  passive: boolean;
  /** 本次应使用的 msg_seq（非被动时为 0）。 */
  msgSeq: number;
  /** 窗口内剩余可用条数。 */
  remaining: number;
  /** 窗口剩余有效时间（毫秒）。 */
  remainingMs: number;
}

const GROUP_WINDOW = 5 * 60_000;
const GROUP_MAX = 5;
const C2C_WINDOW = 60 * 60_000;
const C2C_MAX = 4;

/** 群聊被动回复窗口：5 分钟。 */
export const GROUP_WINDOW_MS = GROUP_WINDOW;
/** 群聊被动回复上限：5 条。 */
export const GROUP_LIMIT = GROUP_MAX;
/** 单聊被动回复窗口：60 分钟。 */
export const C2C_WINDOW_MS = C2C_WINDOW;
/** 单聊被动回复上限：4 条。 */
export const C2C_LIMIT = C2C_MAX;

/** 窗口超过单聊窗口 + 2 分钟后才允许从内存中清除。 */
const PRUNE_AFTER_MS = C2C_WINDOW + 2 * 60_000;

export class MsgSeqManager {
  static readonly GROUP_WINDOW_MS = GROUP_WINDOW;
  static readonly GROUP_LIMIT = GROUP_MAX;
  static readonly C2C_WINDOW_MS = C2C_WINDOW;
  static readonly C2C_LIMIT = C2C_MAX;

  private readonly windows = new Map<string, PassiveWindow>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 当前仍在跟踪的窗口数（主要供测试/诊断使用）。 */
  get size(): number {
    return this.windows.size;
  }

  /**
   * 收到用户消息时登记窗口起点。
   *
   * 同一个 rawMsgId 重复调用是幂等的：保留首次登记的起点与已用条数。
   */
  openWindow(rawMsgId: string, at?: number): PassiveWindow {
    const key = String(rawMsgId);
    const existing = this.windows.get(key);
    if (existing) return { ...existing };

    const window: PassiveWindow = { windowStart: at ?? this.now(), used: 0 };
    this.windows.set(key, window);
    return { ...window };
  }

  /**
   * 领取下一号被动槽。
   *
   * 没有窗口、窗口已过期或配额耗尽时返回 `passive:false`；
   * 此时调用方应改用主动消息（或按 passiveOverflow 策略失败）。
   */
  acquire(rawMsgId: string, scope: OfficialScope): MsgSeqDecision {
    const windowMs = scope === 'group' ? GROUP_WINDOW : C2C_WINDOW;
    const limit = scope === 'group' ? GROUP_MAX : C2C_MAX;
    const key = String(rawMsgId);
    const window = this.windows.get(key);

    if (!window) return inactive(0);

    const now = this.now();
    const elapsed = now - window.windowStart;
    if (elapsed >= windowMs) {
      // 已过期：顺手回收，避免长期占用内存。
      this.windows.delete(key);
      return inactive(0);
    }

    const remainingMs = Math.max(0, windowMs - elapsed);
    if (window.used >= limit) return inactive(remainingMs);

    window.used += 1;
    return {
      passive: true,
      msgSeq: window.used,
      remaining: limit - window.used,
      remainingMs,
    };
  }

  /** 定期清理过期窗口；返回本次删除的窗口数。 */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now - window.windowStart > PRUNE_AFTER_MS) {
        this.windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 清空全部窗口（clean_cache / 重启前调用）。 */
  clear(): void {
    this.windows.clear();
  }
}

function inactive(remainingMs: number): MsgSeqDecision {
  return { passive: false, msgSeq: 0, remaining: 0, remainingMs };
}
