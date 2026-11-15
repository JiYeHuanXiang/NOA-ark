import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IdMapper, PSEUDO_BASE } from '../src/core/idmap.js';

function tempFile(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-idmap-'));
  return path.join(dir, name);
}

describe('IdMapper', () => {
  it('allocates stable pseudo ids from 10^13 and resolves back', () => {
    const mapper = new IdMapper({ file: tempFile('idmap.json') });
    const pseudo = mapper.pseudoOf('OPENID_A');
    expect(Number(pseudo)).toBeGreaterThanOrEqual(PSEUDO_BASE);
    expect(mapper.pseudoOf('OPENID_A')).toBe(pseudo);
    expect(mapper.openidOf(pseudo)).toBe('OPENID_A');
    expect(mapper.openidOf('999')).toBeNull();
  });

  it('allocates distinct ids for distinct openids', () => {
    const mapper = new IdMapper({ file: tempFile('idmap.json') });
    const a = mapper.pseudoOf('A');
    const b = mapper.pseudoOf('B');
    expect(a).not.toBe(b);
  });

  it('persists mappings across instances', () => {
    const file = tempFile('idmap.json');
    const first = new IdMapper({ file });
    const pseudo = first.pseudoOf('PERSIST_ME');
    first.flush();

    const second = new IdMapper({ file });
    expect(second.pseudoOf('PERSIST_ME')).toBe(pseudo);
    expect(second.openidOf(pseudo)).toBe('PERSIST_ME');
  });

  it('maps message ids separately and reversibly', () => {
    const mapper = new IdMapper({ file: tempFile('idmap.json') });
    const pseudo = mapper.pseudoMsgOf('RAW_MSG_1');
    expect(mapper.rawMsgOf(pseudo)).toBe('RAW_MSG_1');
    expect(mapper.rawMsgOf('123')).toBeNull();
  });

  it('derives a deterministic self pseudo id from appId', () => {
    const mapper = new IdMapper({ file: tempFile('idmap.json') });
    const a = mapper.selfPseudo('102000001');
    expect(a).toBe(mapper.selfPseudo('102000001'));
    expect(a).not.toBe(mapper.selfPseudo('102000002'));
    expect(Number(a)).toBeGreaterThanOrEqual(PSEUDO_BASE);
  });

  it('evicts oldest entries beyond capacity but never reuses ids', () => {
    const mapper = new IdMapper({ file: tempFile('idmap.json'), capacity: 2 });
    const pa = mapper.pseudoOf('A');
    mapper.pseudoOf('B');
    mapper.pseudoOf('C');
    expect(mapper.openidOf(pa)).toBeNull();
    // 重新申领会分配新伪号（旧号不复用）
    const again = mapper.pseudoOf('A');
    expect(again).not.toBe(pa);
  });

  it('returns empty string for empty ids', () => {
    const mapper = new IdMapper({ file: tempFile('idmap.json') });
    expect(mapper.pseudoOf('')).toBe('');
    expect(mapper.pseudoMsgOf('')).toBe('');
  });

  it('defers file writes until flush instead of rewriting on every new id', () => {
    const file = tempFile('idmap.json');
    const mapper = new IdMapper({ file });
    mapper.pseudoOf('A');
    mapper.pseudoMsgOf('RAW_1');
    expect(existsSync(file)).toBe(false);
    mapper.flush();
    expect(existsSync(file)).toBe(true);
  });
});
