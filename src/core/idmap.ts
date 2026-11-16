import type { IdMode } from '../config.js';
import { readJson, writeJsonAtomic } from '../store/json-store.js';

export const PSEUDO_BASE = 10_000_000_000_000;

export const PSEUDO_MAX = 99_999_999_999_999;

const SELF_RANGE = PSEUDO_MAX - PSEUDO_BASE + 1;
const DEFAULT_CAPACITY = 200_000;
const IDMAP_VERSION = 1;

const SAVE_DEBOUNCE_MS = 1_000;

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

  file: string;

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
  private saveTimer: NodeJS.Timeout | undefined;

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

    this.evictIfNeeded();
  }

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
    this.scheduleSave();
    return pseudo;
  }

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
    this.scheduleSave();
    return pseudo;
  }

  openidOf(pseudo: string): string | null {
    const key = String(pseudo);
    if (key === '') return null;
    return this.pseudoToOpenid.get(key) ?? null;
  }

  rawMsgOf(pseudo: string): string | null {
    const key = String(pseudo);
    if (key === '') return null;
    return this.pseudoToMsg.get(key) ?? null;
  }

  selfPseudo(appId: string): string {
    let hash = 0x811c9dc5;
    const payload = `noa-ark-self:${appId}`;
    for (let i = 0; i < payload.length; i += 1) {
      hash ^= payload.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return String(PSEUDO_BASE + (hash % SELF_RANGE));
  }

  expose(openid: string, mode: IdMode): string {
    if (openid === '') return '';
    return mode === 'passthrough' ? openid : this.pseudoOf(openid);
  }

  exposeMsg(rawMsgId: string, mode: IdMode): string {
    if (rawMsgId === '') return '';
    return mode === 'passthrough' ? rawMsgId : this.pseudoMsgOf(rawMsgId);
  }

  resolveIncoming(pseudoOrOpenid: string, mode: IdMode): string {
    const value = String(pseudoOrOpenid);
    if (value === '' || mode === 'passthrough') return value;
    return this.pseudoToOpenid.get(value) ?? value;
  }

  evictIfNeeded(): number {
    let evicted = 0;
    evicted += this.evictOldest(this.openidToPseudo, (_openid, pseudo) => {
      this.pseudoToOpenid.delete(pseudo);
    });
    evicted += this.evictOldest(this.msgToPseudo, (_raw, pseudo) => {
      this.pseudoToMsg.delete(pseudo);
    });
    if (evicted > 0) {
      this.dirty = true;
      this.scheduleSave();
    }
    return evicted;
  }

  flush(): void {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.saveIfDirty();
  }

  private touchOpenid(openid: string, pseudo: string): void {

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

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveIfDirty();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
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
