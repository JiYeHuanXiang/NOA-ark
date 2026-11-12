import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MediaCache } from '../src/core/media-cache.js';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'noa-media-'));
}

describe('MediaCache', () => {
  it('downloads an attachment once and serves later calls from the local file', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('png-bytes'), {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': '9' },
    }));
    const cache = new MediaCache({ dir, fetchImpl: fetchImpl as unknown as typeof fetch });

    const first = await cache.fetch('https://cdn.example.test/a.png');
    expect(first.cached).toBe(false);
    expect(existsSync(first.path)).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toBe('png-bytes');
    expect(first.path.endsWith('.png')).toBe(true);

    const second = await cache.fetch('https://cdn.example.test/a.png');
    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized attachments and non-http URLs', async () => {
    const dir = tempDir();
    const oversized = new MediaCache({
      dir,
      maxBytes: 4,
      fetchImpl: (async () => new Response('12345', {
        status: 200,
        headers: { 'Content-Length': '5' },
      })) as unknown as typeof fetch,
    });
    await expect(oversized.fetch('https://cdn.example.test/big.bin')).rejects.toThrow('上限');

    const plain = new MediaCache({ dir });
    await expect(plain.fetch('file:///etc/passwd')).rejects.toThrow('http/https');
  });

  it('rejects localhost and private network hosts', async () => {
    const cache = new MediaCache({ dir: tempDir() });
    await expect(cache.fetch('http://127.0.0.1/a.png')).rejects.toThrow('内网');
    await expect(cache.fetch('http://localhost/a.png')).rejects.toThrow('内网');
    await expect(cache.fetch('http://192.168.1.10/a.png')).rejects.toThrow('内网');
    await expect(cache.fetch('http://[::1]/a.png')).rejects.toThrow('内网');
    await expect(cache.fetch('http://[::ffff:127.0.0.1]/a.png')).rejects.toThrow('内网');
  });

  it('validates each redirect hop and refuses a jump into the private network', async () => {
    const cache = new MediaCache({
      dir: tempDir(),
      fetchImpl: (async () => new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1/secret' },
      })) as unknown as typeof fetch,
    });
    await expect(cache.fetch('https://cdn.example.test/redirected.png')).rejects.toThrow('内网');
  });

  it('enforces the size cap on chunked bodies without content-length', async () => {
    const cache = new MediaCache({
      dir: tempDir(),
      maxBytes: 4,
      fetchImpl: (async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(cache.fetch('https://cdn.example.test/chunked.bin')).rejects.toThrow('上限');
  });
});
