/**
 * Quota — 主动消息的本地配额估算。
 *
 * 平台规则（2026 口径）：单关系约 20 条/分钟；每群/每好友约 1000 条/日；
 * Bot 维度未认证约 5 QPS / 30 QPM。平台不提供实时余额查询，
 * 这里只记录本进程可观察的成功发送并持久化当日计数；
 * 实际是否放行仍以平台返回码（40034105 / 40034100 等）为准。
 *
 * 每日计数按 `data/quota/<key>/daily.json` 隔离，key 通常为 appId；
 * 分钟级窗口只驻留内存，随进程重启清空。
 */

import path from 'node:path';
import { readJson, writeJsonAtomic, safeSegment } from '../store/json-store.js';
import type { OfficialScope } from '../types.js';

export const MINUTE_MS = 60_000;
export const SECOND_MS = 1_000;

export type QuotaReason = 'daily' | 'minute' | 'bot-qps' | 'bot-qpm';

export interface QuotaCheckResult {
  ok: boolean;
  reason?: QuotaReason;
  message?: string;
  /** 建议重试等待时间；daily 场景为距离次日 0 点的毫秒数。 */
  retryAfterMs?: number;
}

export interface QuotaLimits {
  dailyLimitPerPeer: number;
  perMinuteLimit: number;
  botQpsLimit: number;
  botQpmLimit: number;
}

export interface QuotaOptions {
  /** 数据根目录，最终文件为 `<dataDir>/quota/<key>/daily.json`。 */
  dataDir: string;
  /** 隔离 key（通常为 appId）；空则用 default。 */
  key?: string;
  config: QuotaLimits;
  logger?: { warn(message: string): void };
  now?: () => number;
}

interface DailyFile {
  date: string;
  counts: Record<string, number>;
}

const DEFAULT_KEY = 'default';

export class Quota {
  private dataDir: string;
  private key: string;
  private file: string;
  private daily: DailyFile;
  private botEvents: number[] = [];
  private readonly peerEvents = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly limits: QuotaLimits;
  private readonly logger?: { warn(message: string): void };

  constructor(options: QuotaOptions) {
    this.dataDir = options.dataDir;
    this.key = normalizeKey(options.key);
    this.file = quotaFile(this.dataDir, this.key);
    this.now = options.now ?? (() => Date.now());
    this.limits = options.config;
    this.logger = options.logger;
    this.daily = this.loadDaily();
  }

  /** 当前隔离 key。 */
  get currentKey(): string {
    return this.key;
  }

  /** 当日已用主动额度。 */
  dailyUsed(scope: OfficialScope, targetId: string): number {
    this.ensureToday();
    return this.daily.counts[peerKey(scope, targetId)] ?? 0;
  }

  /** 当日剩余主动额度（本地估算，最小 0）。 */
  dailyRemaining(scope: OfficialScope, targetId: string): number {
    return Math.max(0, this.limits.dailyLimitPerPeer - this.dailyUsed(scope, targetId));
  }

  /**
   * 检查能否立即主动发送 count 条。
   *
   * 调用方必须把 check → 平台发送 → record 串行化，避免并发穿透。
   * 每次 check 都会顺带清理一分钟以外的分钟窗口。
   */
  check(scope: OfficialScope, targetId: string, count = 1): QuotaCheckResult {
    this.ensureToday();
    const amount = normalizeCount(count);
    const now = this.now();
    this.prune(now);

    const key = peerKey(scope, targetId);
    const usedToday = this.daily.counts[key] ?? 0;
    if (usedToday + amount > this.limits.dailyLimitPerPeer) {
      return {
        ok: false,
        reason: 'daily',
        message: `本会话今日主动消息本地额度已用完（${usedToday}/${this.limits.dailyLimitPerPeer}）`,
        retryAfterMs: msUntilTomorrow(now),
      };
    }

    const peer = this.peerEvents.get(key) ?? [];
    if (peer.length + amount > this.limits.perMinuteLimit) {
      return {
        ok: false,
        reason: 'minute',
        message: `发送过快：最近一分钟 ${peer.length} 条，上限 ${this.limits.perMinuteLimit}`,
        retryAfterMs: this.retryAfter(peer, now, MINUTE_MS),
      };
    }

    const lastSecond = this.botEvents.filter((ts) => ts > now - SECOND_MS);
    if (lastSecond.length + amount > this.limits.botQpsLimit) {
      return {
        ok: false,
        reason: 'bot-qps',
        message: `Bot 速率受限：最近 1 秒 ${lastSecond.length} 条，上限 ${this.limits.botQpsLimit}`,
        retryAfterMs: this.retryAfter(lastSecond, now, SECOND_MS),
      };
    }

    if (this.botEvents.length + amount > this.limits.botQpmLimit) {
      return {
        ok: false,
        reason: 'bot-qpm',
        message: `Bot 频率受限：最近一分钟 ${this.botEvents.length} 条，上限 ${this.limits.botQpmLimit}`,
        retryAfterMs: this.retryAfter(this.botEvents, now, MINUTE_MS),
      };
    }

    return { ok: true };
  }

  /** 记录一条已在平台成功发出的主动消息。 */
  record(scope: OfficialScope, targetId: string, ts?: number): void {
    this.ensureToday();
    const at = ts ?? this.now();
    this.prune(at);

    this.botEvents.push(at);
    const key = peerKey(scope, targetId);
    const peer = this.peerEvents.get(key) ?? [];
    peer.push(at);
    this.peerEvents.set(key, peer);
    this.daily.counts[key] = (this.daily.counts[key] ?? 0) + 1;
    this.save();
  }

  /**
   * 运行中换绑 AppID：切换配额目录、清空分钟窗口并重载当日计数。
   */
  rebindKey(key: string): void {
    this.key = normalizeKey(key);
    this.file = quotaFile(this.dataDir, this.key);
    this.botEvents = [];
    this.peerEvents.clear();
    this.daily = this.loadDaily();
  }

  private dayKey(ts: number): string {
    const date = new Date(ts);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  private ensureToday(): void {
    const today = this.dayKey(this.now());
    if (this.daily.date === today) return;
    this.daily = { date: today, counts: {} };
  }

  private loadDaily(): DailyFile {
    const today = this.dayKey(this.now());
    const raw = readJson<Partial<DailyFile>>(this.file, {}, (_file, _backup, err) => {
      this.logger?.warn(
        `[quota] 配额文件损坏，已隔离并重建：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (!raw || raw.date !== today || typeof raw.counts !== 'object' || raw.counts === null) {
      return { date: today, counts: {} };
    }

    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw.counts)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        counts[key] = Math.floor(value);
      }
    }
    return { date: today, counts };
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.daily);
    } catch (err) {
      this.logger?.warn(
        `[quota] 写额度文件失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 清理 1 分钟前的 Bot / 单会话窗口。 */
  private prune(now: number): void {
    const cutoff = now - MINUTE_MS;
    this.botEvents = this.botEvents.filter((ts) => ts > cutoff);
    for (const [key, events] of this.peerEvents) {
      const kept = events.filter((ts) => ts > cutoff);
      if (kept.length === 0) this.peerEvents.delete(key);
      else this.peerEvents.set(key, kept);
    }
  }

  private retryAfter(events: readonly number[], now: number, windowMs: number): number {
    const oldest = events.length === 0 ? now : Math.min(...events);
    return Math.max(1, oldest + windowMs - now);
  }
}

function peerKey(scope: OfficialScope, targetId: string): string {
  return `${scope}:${targetId}`;
}

function quotaFile(dataDir: string, key: string): string {
  return path.join(dataDir, 'quota', key, 'daily.json');
}

function normalizeKey(key: string | undefined): string {
  const safe = safeSegment(key ?? DEFAULT_KEY);
  return safe === '' ? DEFAULT_KEY : safe;
}

function normalizeCount(count: number): number {
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.floor(count);
}

function msUntilTomorrow(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(0, next.getTime() - now);
}
