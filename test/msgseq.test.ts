import { describe, expect, it } from 'vitest';
import { C2C_LIMIT, C2C_WINDOW_MS, GROUP_LIMIT, GROUP_WINDOW_MS, MsgSeqManager } from '../src/core/msgseq.js';

describe('MsgSeqManager', () => {
  it('allows group passive replies 1..5 and then stops', () => {
    let now = 1_000_000;
    const mgr = new MsgSeqManager(() => now);
    mgr.openWindow('MSG_1', now);
    for (let i = 1; i <= GROUP_LIMIT; i += 1) {
      const d = mgr.acquire('MSG_1', 'group');
      expect(d.passive).toBe(true);
      expect(d.msgSeq).toBe(i);
    }
    const sixth = mgr.acquire('MSG_1', 'group');
    expect(sixth.passive).toBe(false);
    expect(sixth.msgSeq).toBe(0);
  });

  it('expires the group window after 5 minutes', () => {
    let now = 1_000_000;
    const mgr = new MsgSeqManager(() => now);
    mgr.openWindow('MSG_2', now);
    expect(mgr.acquire('MSG_2', 'group').passive).toBe(true);
    now += GROUP_WINDOW_MS + 1;
    expect(mgr.acquire('MSG_2', 'group').passive).toBe(false);
  });

  it('uses a 60-minute / 4-reply window for c2c', () => {
    let now = 1_000_000;
    const mgr = new MsgSeqManager(() => now);
    mgr.openWindow('MSG_3', now);
    for (let i = 1; i <= C2C_LIMIT; i += 1) {
      expect(mgr.acquire('MSG_3', 'c2c').msgSeq).toBe(i);
    }
    expect(mgr.acquire('MSG_3', 'c2c').passive).toBe(false);
    now += C2C_WINDOW_MS + 1;
    expect(mgr.acquire('MSG_3', 'c2c').passive).toBe(false);
  });

  it('returns inactive for unknown messages', () => {
    const mgr = new MsgSeqManager(() => 1_000_000);
    const d = mgr.acquire('UNKNOWN', 'group');
    expect(d).toEqual({ passive: false, msgSeq: 0, remaining: 0, remainingMs: 0 });
  });

  it('openWindow is idempotent for duplicate delivery', () => {
    let now = 1_000_000;
    const mgr = new MsgSeqManager(() => now);
    mgr.openWindow('MSG_4', now);
    expect(mgr.acquire('MSG_4', 'group').msgSeq).toBe(1);
    now += 5_000;
    mgr.openWindow('MSG_4', now); // duplicate delivery
    expect(mgr.acquire('MSG_4', 'group').msgSeq).toBe(2);
  });

  it('prunes expired windows', () => {
    let now = 1_000_000;
    const mgr = new MsgSeqManager(() => now);
    mgr.openWindow('A', now);
    mgr.openWindow('B', now);
    now += C2C_WINDOW_MS + 180_000;
    expect(mgr.prune()).toBeGreaterThanOrEqual(2);
    expect(mgr.size).toBe(0);
  });
});
