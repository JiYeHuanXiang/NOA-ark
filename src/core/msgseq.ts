import type { OfficialScope } from '../types.js';

export interface PassiveWindow {

  windowStart: number;

  used: number;
}

export interface MsgSeqDecision {

  passive: boolean;

  msgSeq: number;

  remaining: number;

  remainingMs: number;
}

const GROUP_WINDOW = 5 * 60_000;
const GROUP_MAX = 5;
const C2C_WINDOW = 60 * 60_000;
const C2C_MAX = 4;

export const GROUP_WINDOW_MS = GROUP_WINDOW;

export const GROUP_LIMIT = GROUP_MAX;

export const C2C_WINDOW_MS = C2C_WINDOW;

export const C2C_LIMIT = C2C_MAX;

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

  get size(): number {
    return this.windows.size;
  }

  openWindow(rawMsgId: string, at?: number): PassiveWindow {
    const key = String(rawMsgId);
    const existing = this.windows.get(key);
    if (existing) return { ...existing };

    const window: PassiveWindow = { windowStart: at ?? this.now(), used: 0 };
    this.windows.set(key, window);
    return { ...window };
  }

  acquire(rawMsgId: string, scope: OfficialScope): MsgSeqDecision {
    const windowMs = scope === 'group' ? GROUP_WINDOW : C2C_WINDOW;
    const limit = scope === 'group' ? GROUP_MAX : C2C_MAX;
    const key = String(rawMsgId);
    const window = this.windows.get(key);

    if (!window) return inactive(0);

    const now = this.now();
    const elapsed = now - window.windowStart;
    if (elapsed >= windowMs) {

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

  clear(): void {
    this.windows.clear();
  }
}

function inactive(remainingMs: number): MsgSeqDecision {
  return { passive: false, msgSeq: 0, remaining: 0, remainingMs };
}
