import { describe, expect, it, vi } from 'vitest';
import type { Rest } from '../src/official/rest.js';
import type { JoinStrategyStore } from '../src/noa/join-policy.js';
import { NoaExtensionService, type NoaSendBridge } from '../src/noa/service.js';

function makeBridge() {
  return {
    reserve: vi.fn((): { msgId?: string; msgSeq?: number; passive: boolean } => ({
      msgId: 'RAW_IN',
      msgSeq: 1,
      passive: true,
    })),
    recordProactive: vi.fn(),
  };
}

function makeRest() {
  return {
    sendTyping: vi.fn(async () => ({ id: 'OUT' })),
    ackInteraction: vi.fn(async () => undefined),
    sendStreamFrame: vi.fn(async (_user: string, options: { index: number }) => ({
      streamMsgId: 'S1',
      remainMsgLen: 100 - options.index,
    })),
    sendWakeup: vi.fn(async () => ({ id: 'WAKEUP' })),
    setMenu: vi.fn(async () => ({ version: 1 })),
    createPanel: vi.fn(async () => ({ panel_id: 'p_1' })),
    listPanels: vi.fn(async () => ({ records: [] })),
    createJoinApprovalStrategy: vi.fn(async () => ({
      strategy_id: 'st_1',
      is_enable: 'on',
      expire_at: '2027-01-01T00:00:00+08:00',
    })),
    updateJoinApprovalStrategy: vi.fn(async () => ({ is_enable: 'off' })),
    updateJoinApprovalWhitelist: vi.fn(async () => ({ ok: true })),
    executeJoinApprovalStrategy: vi.fn(async () => ({ scanned: 1 })),
  };
}

function makeService(options?: {
  bridge?: ReturnType<typeof makeBridge>;
  rest?: ReturnType<typeof makeRest>;
  store?: { get: (group: string) => string | undefined; set: (group: string, id: string) => void };
}) {
  const bridge = options?.bridge ?? makeBridge();
  const rest = options?.rest ?? makeRest();
  const service = new NoaExtensionService({
    rest: rest as unknown as Rest,
    sender: bridge as unknown as NoaSendBridge,
    strategyStore: options?.store as unknown as JoinStrategyStore,
    logger: { warn: () => undefined },
  });
  return { service, bridge, rest };
}

describe('NoaExtensionService', () => {
  it('sends typing with a passive slot and records proactive quota only when needed', async () => {
    const { service, bridge, rest } = makeService();
    const passive = await service.sendTyping('c2c', 'USER_A', 999);
    expect(passive).toEqual({ passive: true, seconds: 60 });
    expect(rest.sendTyping).toHaveBeenCalledWith('USER_A', 60, { msgId: 'RAW_IN', msgSeq: 1 });
    expect(bridge.recordProactive).not.toHaveBeenCalled();

    bridge.reserve.mockReturnValue({ passive: false });
    const proactive = await service.sendTyping('c2c', 'USER_A', 8);
    expect(proactive.passive).toBe(false);
    expect(bridge.recordProactive).toHaveBeenCalledWith('c2c', 'USER_A');

    await expect(service.sendTyping('group', 'GROUP_A', 8)).rejects.toThrow('单聊');
  });

  it('runs the stream lifecycle with prefix checks and single-use end', async () => {
    const { service, rest } = makeService();
    const begin = await service.streamBegin('USER_A', { content: 'a' });
    expect(begin).toMatchObject({ streamId: 'S1', index: 1, passive: true });
    expect(rest.sendStreamFrame).toHaveBeenCalledWith('USER_A', expect.objectContaining({
      index: 0,
      inputState: 1,
      content: 'a',
      msgId: 'RAW_IN',
      msgSeq: 1,
    }));

    const append = await service.streamAppend('S1', 'ab');
    expect(append).toMatchObject({ streamId: 'S1', index: 2 });
    expect(rest.sendStreamFrame).toHaveBeenLastCalledWith('USER_A', expect.objectContaining({
      streamMsgId: 'S1',
      index: 1,
      inputState: 1,
      content: 'ab',
    }));

    await expect(service.streamAppend('S1', 'zz')).rejects.toThrow('40007');

    const end = await service.streamEnd('S1');
    expect(end).toMatchObject({ streamId: 'S1', ended: true });
    expect(rest.sendStreamFrame).toHaveBeenLastCalledWith('USER_A', expect.objectContaining({
      index: 2,
      inputState: 10,
      content: 'ab',
    }));

    await expect(service.streamEnd('S1')).rejects.toThrow('不存在');
  });

  it('creates a join policy once, then updates it and applies whitelist/execute', async () => {
    const store = {
      get: vi.fn(() => undefined as string | undefined),
      set: vi.fn(),
    };
    const rest = makeRest();
    const { service } = makeService({ rest, store });

    const created = await service.setJoinPolicy({ groupOpenid: 'GROUP_A', enable: true });
    expect(rest.createJoinApprovalStrategy).toHaveBeenCalledWith({
      group_openids: ['GROUP_A'],
      is_enable: 'on',
    });
    expect(store.set).toHaveBeenCalledWith('GROUP_A', 'st_1');
    expect(created).toMatchObject({ strategy_id: 'st_1', is_enable: 'on' });

    store.get.mockReturnValue('st_1');
    const updated = await service.setJoinPolicy({
      groupOpenid: 'GROUP_A',
      enable: false,
      whitelistUsers: ['1234567'],
      whitelistOp: 'del',
      execute: true,
    });
    expect(rest.updateJoinApprovalStrategy).toHaveBeenCalledWith('st_1', { is_enable: 'off' });
    expect(rest.updateJoinApprovalWhitelist).toHaveBeenCalledWith('st_1', 'del', ['1234567']);
    expect(rest.executeJoinApprovalStrategy).toHaveBeenCalledWith('st_1');
    expect(updated).toMatchObject({ strategy_id: 'st_1', is_enable: 'off' });
  });

  it('passes wakeup, menu and panel calls through to REST', async () => {
    const { service, rest } = makeService();
    await service.sendWakeup('USER_A', '回来看看');
    expect(rest.sendWakeup).toHaveBeenCalledWith('USER_A', '回来看看');

    await expect(service.setMenu({ items: [] })).resolves.toEqual({ version: 1 });
    await expect(service.createPanel({ scope: 'group' })).resolves.toEqual({ panel_id: 'p_1' });
    await expect(service.listPanels('group')).resolves.toEqual({ records: [] });
    await expect(service.ackInteraction('i_1', 0)).resolves.toBeUndefined();
  });
});
