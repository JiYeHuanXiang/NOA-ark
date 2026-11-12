import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Quota } from '../src/core/quota.js';

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'noa-quota-'));
}

const baseLimits = {
  dailyLimitPerPeer: 1000,
  perMinuteLimit: 20,
  botQpsLimit: 5,
  botQpmLimit: 30,
};

describe('Quota', () => {
  it('allows sends within limits and counts them', () => {
    let now = 1_000_000;
    const quota = new Quota({ dataDir: tempDir(), key: 'test', config: baseLimits, now: () => now });
    expect(quota.check('group', 'G1').ok).toBe(true);
    quota.record('group', 'G1', now);
    expect(quota.dailyUsed('group', 'G1')).toBe(1);
    expect(quota.dailyRemaining('group', 'G1')).toBe(999);
  });

  it('enforces the per-peer daily cap', () => {
    let now = 1_000_000;
    const quota = new Quota({
      dataDir: tempDir(),
      key: 'test',
      config: { ...baseLimits, dailyLimitPerPeer: 2 },
      now: () => now,
    });
    quota.record('group', 'G1', now);
    quota.record('group', 'G1', now);
    const check = quota.check('group', 'G1');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('daily');
  });

  it('enforces the per-peer per-minute cap', () => {
    let now = 1_000_000;
    const quota = new Quota({
      dataDir: tempDir(),
      key: 'test',
      config: { ...baseLimits, perMinuteLimit: 2 },
      now: () => now,
    });
    quota.record('group', 'G1', now);
    quota.record('group', 'G1', now);
    const check = quota.check('group', 'G1');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('minute');
    expect(check.retryAfterMs).toBeGreaterThan(0);
  });

  it('enforces bot qps', () => {
    let now = 1_000_000;
    const quota = new Quota({
      dataDir: tempDir(),
      key: 'test',
      config: { ...baseLimits, botQpsLimit: 2, botQpmLimit: 100 },
      now: () => now,
    });
    quota.record('group', 'G1', now);
    quota.record('group', 'G2', now);
    const check = quota.check('group', 'G3');
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('bot-qps');
  });

  it('persists daily counts across instances', () => {
    const dataDir = tempDir();
    let now = 1_000_000;
    const first = new Quota({ dataDir, key: 'app1', config: baseLimits, now: () => now });
    first.record('group', 'G1', now);

    const second = new Quota({ dataDir, key: 'app1', config: baseLimits, now: () => now });
    expect(second.dailyUsed('group', 'G1')).toBe(1);
  });
});
