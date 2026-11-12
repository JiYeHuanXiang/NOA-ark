/**
 * IdMapper — openid / 官方 message_id 与稳定伪数值 ID 的双向映射。
 *
 * 计数器从 10^13 起（避开真实 QQ 号区间），持久化到
 * `data/registry/idmap.json`，重启后继续递增；超出容量上限时按 LRU
 * 淘汰条目，但已分配的伪号永不复用，避免旧程序侧 ID 漂移。
 *
 * passthrough 模式不写映射表，直接返回官方原始字符串。
 */

import type { IdMode } from '../config.js';
import { readJson, writeJsonAtomic } from '../store/json-store.js';

/** 伪号起点：10^13，位于真实 QQ 号（约 10^5..10^11）之外。 */
export const PSEUDO_BASE = 10_000_000_000_000;
/** 伪号上界（含）：10^14 - 1。 */
export const PSEUDO_MAX = 99_999_999_999_999;

const SELF_RANGE = PSEUDO_MAX - PSEUDO_BASE + 1;
const DEFAULT_CAPACITY = 200_000;
const IDMAP_VERSION = 1;

/** `data/registry/idmap.json` 的持久化结构。 */
export interface IdMapFile {
  version: number;
  nextId: number;
  nextMsgId: number;
  byOpenid: Record<string, string>;
  byPseudo: Record<string, string>;
  msgBySrc: Record<string, string>;
  msgByPseudo: Record<string, string>;
}

export interface IdMapperOptions {
  /** 映射文件绝对路径，通常为 `<dataDir>/registry/idmap.json`。 */
  file: string;
  /** 每个方向的最大条目数，默认 200,000。 */
  capacity?: number;
  logger?: { warn(message: string): void };
}

export class IdMapper {
  static readonly PSEUDO_BASE = PSEUDO_BASE;
  static readonly PSEUDO_MAX = PSEUDO_MAX;
  static readonly DEFAULT_CAPACITY = DEFAULT_CAPACITY;

  private readonly file: string;
  private readonly capacity: number;
  private readonly logger?: { warn(message: string): void };
  private nextId: number;
  private nextMsgId: number;
  private readonly openidToPseudo = new Map<string, string>();
  private readonly pseudoToOpenid = new Map<string, string>();
  private readonly msgToPseudo = new Map<string, string>();
  private readonly pseudoToMsg = new Map<string, string>();
  private dirty = false;

  constructor(options: IdMapperOptions) {
    this.file = options.file;
    this.capacity = normalizeCapacity(options.capacity);
    this.logger = options.logger;

    const document = readJson<Partial<IdMapFile>>(this.file, {}, (_file, _backup, err) => {
      this.logger?.warn(
        `[idmap] 映射文件损坏，已隔离并重建：${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const raw: Partial<IdMapFile> = isRecord(document) ? document : {};

    const maxOpenidId = this.loadOpenids(raw);
    const maxMsgId = this.loadMessages(raw);
    this.nextId = normalizeNext(raw.nextId, maxOpenidId);
    this.nextMsgId = normalizeNext(raw.nextMsgId, maxMsgId);

    // 读入时已经超过容量（例如调小配置）：立即淘汰并落盘。
    this.evictIfNeeded();
  }

  /** 取得（或分配）openid 对应的稳定伪号。 */
  pseudoOf(openid: string): string {
    const key = String(openid);
    if (key === '') return '';

    const hit = this.openidToPseudo.get(key);
    if (hit !== undefined) {
      this.touchOpenid(key, hit);
      return hit;
    }

    const pseudo = String(this.nextId);
    this.nextId += 1;
    this.openidToPseudo.set(key, pseudo);
    this.pseudoToOpenid.set(pseudo, key);
    this.dirty = true;
    this.evictIfNeeded();
    this.saveIfDirty();
    return pseudo;
  }

  /** 取得（或分配）官方消息 id 对应的伪 message_id。 */
  pseudoMsgOf(rawMsgId: string): string {
    const key = String(rawMsgId);
    if (key === '') return '';

    const hit = this.msgToPseudo.get(key);
    if (hit !== undefined) {
      this.touchMessage(key, hit);
      return hit;
    }

    const pseudo = String(this.nextMsgId);
    this.nextMsgId += 1;
    this.msgToPseudo.set(key, pseudo);
    this.pseudoToMsg.set(pseudo, key);
    this.dirty = true;
    this.evictIfNeeded();
    this.saveIfDirty();
    return pseudo;
  }

  /** 伪号 → openid；未知返回 null。 */
  openidOf(pseudo: string): string | null {
    const key = String(pseudo);
    if (key === '') return null;
    return this.pseudoToOpenid.get(key) ?? null;
  }

  /** 伪 message_id → 官方原始消息 id；未知返回 null。 */
  rawMsgOf(pseudo: string): string | null {
    const key = String(pseudo);
    if (key === '') return null;
    return this.pseudoToMsg.get(key) ?? null;
  }

  /**
   * 由 AppID 派生稳定伪 self_id（FNV-1a 32 位），
   * 映射到 [10^13, 10^14-1]，无需持久化。
   */
  selfPseudo(appId: string): string {
    let hash = 0x811c9dc5;
    const payload = `noa-ark-self:${appId}`;
    for (let i = 0; i < payload.length; i += 1) {
      hash ^= payload.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return String(PSEUDO_BASE + (hash % SELF_RANGE));
  }

  /** 按 idMode 暴露 openid（mapped=伪号，passthrough=原串）。 */
  expose(openid: string, mode: IdMode): string {
    if (openid === '') return '';
    return mode === 'passthrough' ? openid : this.pseudoOf(openid);
  }

  /** 按 idMode 暴露官方消息 id（mapped=伪号，passthrough=原串）。 */
  exposeMsg(rawMsgId: string, mode: IdMode): string {
    if (rawMsgId === '') return '';
    return mode === 'passthrough' ? rawMsgId : this.pseudoMsgOf(rawMsgId);
  }

  /**
   * 解析入站 ID：mapped 模式下优先按伪号反查 openid；
   * 查不到时视为调用方直接传入了 openid，原样返回。
   */
  resolveIncoming(pseudoOrOpenid: string, mode: IdMode): string {
    const value = String(pseudoOrOpenid);
    if (value === '' || mode === 'passthrough') return value;
    return this.pseudoToOpenid.get(value) ?? value;
  }

  /**
   * 按 LRU 淘汰超限条目；返回淘汰条数。
   *
   * 只删除映射，不回退 nextId/nextMsgId——伪号一旦分配就不再复用。
   */
  evictIfNeeded(): number {
    let evicted = 0;
    evicted += this.evictOldest(this.openidToPseudo, (openid, pseudo) => {
      this.pseudoToOpenid.delete(pseudo);
      void openid;
    });
    evicted += this.evictOldest(this.msgToPseudo, (_raw, pseudo) => {
      this.pseudoToMsg.delete(pseudo);
    });
    if (evicted > 0) {
      this.dirty = true;
      this.saveIfDirty();
    }
    return evicted;
  }

  /** 立即落盘（仅 dirty 时真正写入）。 */
  flush(): void {
    this.saveIfDirty();
  }

  private touchOpenid(openid: string, pseudo: string): void {
    // Map 的插入顺序即 LRU 顺序：删除后重插 = 移到队尾。
    this.openidToPseudo.delete(openid);
    this.openidToPseudo.set(openid, pseudo);
  }

  private touchMessage(rawMsgId: string, pseudo: string): void {
    this.msgToPseudo.delete(rawMsgId);
    this.msgToPseudo.set(rawMsgId, pseudo);
  }

  private evictOldest(
    map: Map<string, string>,
    onEvict: (key: string, value: string) => void,
  ): number {
    let evicted = 0;
    while (map.size > this.capacity) {
      const first = map.keys().next();
      if (first.done === true) break;
      const key = first.value;
      const value = map.get(key);
      map.delete(key);
      if (value !== undefined) onEvict(key, value);
      evicted += 1;
    }
    return evicted;
  }

  private saveIfDirty(): void {
    if (!this.dirty) return;
    const data: IdMapFile = {
      version: IDMAP_VERSION,
      nextId: this.nextId,
      nextMsgId: this.nextMsgId,
      byOpenid: Object.fromEntries(this.openidToPseudo),
      byPseudo: Object.fromEntries(this.pseudoToOpenid),
      msgBySrc: Object.fromEntries(this.msgToPseudo),
      msgByPseudo: Object.fromEntries(this.pseudoToMsg),
    };
    writeJsonAtomic(this.file, data);
    this.dirty = false;
  }

  /** 读取 byOpenid/byPseudo，返回已用到的最大伪号。 */
  private loadOpenids(raw: Partial<IdMapFile>): number {
    let max = 0;
    const record = isRecord(raw.byOpenid) ? raw.byOpenid : {};
    for (const [openid, pseudo] of Object.entries(record)) {
      if (typeof pseudo !== 'string' || !isNumericId(pseudo)) continue;
      if (this.pseudoToOpenid.has(pseudo)) continue;
      this.openidToPseudo.set(openid, pseudo);
      this.pseudoToOpenid.set(pseudo, openid);
      max = Math.max(max, Number(pseudo));
    }

    // byPseudo 是派生数据；容忍只有 byPseudo 的旧文件。
    const reverse = isRecord(raw.byPseudo) ? raw.byPseudo : {};
    for (const [pseudo, openid] of Object.entries(reverse)) {
      if (typeof openid !== 'string' || !isNumericId(pseudo)) continue;
      if (this.pseudoToOpenid.has(pseudo) || this.openidToPseudo.has(openid)) continue;
      this.openidToPseudo.set(openid, pseudo);
      this.pseudoToOpenid.set(pseudo, openid);
      max = Math.max(max, Number(pseudo));
    }
    return max;
  }

  /** 读取 msgBySrc/msgByPseudo，返回已用到的最大伪号。 */
  private loadMessages(raw: Partial<IdMapFile>): number {
    let max = 0;
    const record = isRecord(raw.msgBySrc) ? raw.msgBySrc : {};
    for (const [src, pseudo] of Object.entries(record)) {
      if (typeof pseudo !== 'string' || !isNumericId(pseudo)) continue;
      if (this.pseudoToMsg.has(pseudo)) continue;
      this.msgToPseudo.set(src, pseudo);
      this.pseudoToMsg.set(pseudo, src);
      max = Math.max(max, Number(pseudo));
    }

    const reverse = isRecord(raw.msgByPseudo) ? raw.msgByPseudo : {};
    for (const [pseudo, src] of Object.entries(reverse)) {
      if (typeof src !== 'string' || !isNumericId(pseudo)) continue;
      if (this.pseudoToMsg.has(pseudo) || this.msgToPseudo.has(src)) continue;
      this.msgToPseudo.set(src, pseudo);
      this.pseudoToMsg.set(pseudo, src);
      max = Math.max(max, Number(pseudo));
    }
    return max;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

function normalizeCapacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CAPACITY;
  return Math.max(1, Math.floor(value));
}

function normalizeNext(raw: number | undefined, maxUsed: number): number {
  const candidate =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : PSEUDO_BASE;
  return Math.max(PSEUDO_BASE, candidate, maxUsed + 1);
}
