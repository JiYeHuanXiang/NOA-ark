/**
 * 富媒体本地缓存：把官方消息附件 URL 落到本地文件，供 OneBot get_image / get_record 使用。
 *
 * 官方附件 URL 带 TTL，旧程序无法长期复用；缓存按 URL 哈希命名，重复调用同一 URL
 * 直接命中本地文件。只接受 http/https，大小与超时都有上限，避免被异常链接拖垮进程。
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MediaCacheOptions {
  /** 缓存目录（不存在时自动创建）。 */
  dir: string;
  /** 单文件大小上限，默认 20MB。 */
  maxBytes?: number;
  /** 下载超时，默认 20 秒。 */
  timeoutMs?: number;
  /** 测试注入：替换全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface MediaCacheResult {
  /** 本地绝对路径。 */
  path: string;
  size: number;
  /** 是否命中已有缓存。 */
  cached: boolean;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

/** 官方 CDN 常见 content-type → 扩展名；未知类型用 .bin。 */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/amr': '.amr',
  'audio/silk': '.silk',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

export class MediaCache {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MediaCacheOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 下载（或命中缓存）一个 http/https 附件；失败抛 Error（中文原因）。 */
  async fetch(uri: string): Promise<MediaCacheResult> {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new Error('get_image/get_record 需要 http/https 附件 URL（当前值不是合法 URL）');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('get_image/get_record 只支持 http/https 附件 URL');
    }
    assertPublicHost(url);

    const key = createHash('sha256').update(uri).digest('hex');
    const existing = this.findExisting(key);
    if (existing !== null) return existing;

    let response: Response;
    try {
      response = await this.fetchFollowingRedirects(url, AbortSignal.timeout(this.timeoutMs));
    } catch (err) {
      throw new Error(`下载附件失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new Error(`下载附件失败：HTTP ${response.status}`);
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const declaredLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      throw new Error(
        `附件 ${declaredLength} 字节超过本地缓存上限 ${this.maxBytes} 字节；请改用公网 URL 直发`,
      );
    }

    const buffer = await readBoundedBody(response, this.maxBytes);

    const file = path.join(this.dir, `${key}${extensionOf(url, contentType)}`);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, buffer);
    await rename(tmp, file);
    return { path: file, size: buffer.length, cached: false };
  }

  /** 手动跟随最多 3 次重定向，并对每一跳重新做内网校验。 */
  private async fetchFollowingRedirects(url: URL, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= 3; hop += 1) {
      const response = await this.fetchImpl(current.toString(), { signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;

      const location = response.headers.get('location');
      if (location === null || location === '') throw new Error('附件重定向缺少 Location');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('附件重定向地址非法');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error('附件重定向到非 http/https 地址');
      }
      assertPublicHost(next);
      current = next;
    }
    throw new Error('附件重定向次数过多（最多 3 次）');
  }

  /** 已缓存文件查找：哈希同名但扩展名可能因 content-type 不同而变化，逐个已知扩展名探测。 */
  private findExisting(key: string): MediaCacheResult | null {
    for (const ext of ['', ...new Set(Object.values(EXT_BY_CONTENT_TYPE)), '.bin']) {
      const file = path.join(this.dir, `${key}${ext}`);
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      if (size > 0) return { path: file, size, cached: true };
    }
    return null;
  }
}

function extensionOf(url: URL, contentType: string): string {
  const fromType = EXT_BY_CONTENT_TYPE[contentType];
  if (fromType !== undefined) return fromType;
  const ext = path.extname(url.pathname).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  return '.bin';
}

/** 边读边计数：chunked / 无 content-length 的响应也不能突破内存上限。 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`附件 ${buffer.length} 字节超过本地缓存上限 ${maxBytes} 字节；请改用公网 URL 直发`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`附件超过本地缓存上限 ${maxBytes} 字节；请改用公网 URL 直发`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** 拒绝本机/内网地址，避免 get_image/get_record 被当成内网探测代理。 */
function assertPublicHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === '0.0.0.0'
    || host === '[::1]'
    || host === '[::]'
    || host.startsWith('[::ffff:')
    || host.startsWith('[fc')
    || host.startsWith('[fd')
    || host.startsWith('[fe80')
  ) {
    throw new Error('拒绝访问本机/内网地址（get_image/get_record 只允许公网 http/https）');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host)) {
    throw new Error('拒绝访问本机/内网地址（get_image/get_record 只允许公网 http/https）');
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}
