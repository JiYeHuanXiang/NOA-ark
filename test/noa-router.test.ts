import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IdMapper } from '../src/core/idmap.js';
import { DEFAULT_NOA_EXT, type NoaConf, type NoaExtConf } from '../src/config.js';
import { NoaActionRouter } from '../src/noa/router.js';
import type { NoaExtensionService } from '../src/noa/service.js';

function tempMapper(): IdMapper {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-router-'));
  return new IdMapper({ file: path.join(dir, 'idmap.json') });
}

function noaConf(ext: Partial<NoaExtConf> = {}): NoaConf {
  return {
    ext: { ...DEFAULT_NOA_EXT, ...ext },
    autoAckInteraction: true,
    interactionRaw: false,
  };
}

function makeService() {
  return {
    sendTyping: vi.fn(async () => ({ passive: true, seconds: 8 })),
    ackInteraction: vi.fn(async () => undefined),
    setMenu: vi.fn(async () => ({ version: 3 })),
    createPanel: vi.fn(async () => ({ panel_id: 'p_1' })),
    listPanels: vi.fn(async () => ({ records: [] })),
    setJoinPolicy: vi.fn(async () => ({ strategy_id: 'st_1', is_enable: 'on', expire_at: '' })),
    streamBegin: vi.fn(async () => ({ streamId: 's_1', index: 1, remainMsgLen: 10, passive: true })),
    streamAppend: vi.fn(async () => ({ streamId: 's_1', index: 2, remainMsgLen: 5 })),
    streamEnd: vi.fn(async () => ({ streamId: 's_1', ended: true as const, remainMsgLen: 0 })),
    sendWakeup: vi.fn(async () => undefined),
  };
}

function makeRouter(conf: NoaConf, service = makeService()) {
  const mapper = tempMapper();
  const router = new NoaActionRouter({
    conf,
    service: service as unknown as NoaExtensionService,
    mapper,
    idMode: 'mapped',
    logger: { warn: () => undefined },
  });
  return { router, mapper, service };
}

describe('NoaActionRouter', () => {
  it('returns null for non-noa actions', async () => {
    const { router } = makeRouter(noaConf());
    await expect(router.dispatch('send_group_msg', {}, undefined)).resolves.toBeNull();
  });

  it('rejects disabled extensions with 1404 and never calls the service', async () => {
    const { router, service } = makeRouter(noaConf());
    const r = await router.dispatch('noa_send_typing', { user_id: 1 }, undefined);
    expect(r?.retcode).toBe(1404);
    expect(r?.message).toContain('typing');
    expect(service.sendTyping).not.toHaveBeenCalled();
  });

  it('routes noa_send_typing to c2c and rejects group scene', async () => {
    const { router, mapper, service } = makeRouter(noaConf({ typing: true }));
    const userId = Number(mapper.pseudoOf('USER_A'));

    const group = await router.dispatch('noa_send_typing', { group_id: 1, user_id: userId }, undefined);
    expect(group?.retcode).toBe(1404);

    const ok = await router.dispatch('noa_send_typing', { user_id: userId, seconds: 8 }, undefined);
    expect(ok?.status).toBe('ok');
    expect(ok?.data).toMatchObject({ sent: true, passive: true, seconds: 8 });
    expect(service.sendTyping).toHaveBeenCalledWith('c2c', 'USER_A', 8);
  });

  it('validates interaction ack codes and defaults to 0', async () => {
    const { router, service } = makeRouter(noaConf({ interaction: true }));
    const bad = await router.dispatch('noa_ack_interaction', { interaction_id: 'i_1', code: 9 }, undefined);
    expect(bad?.retcode).toBe(1400);

    const ok = await router.dispatch('noa_ack_interaction', { interaction_id: 'i_1' }, undefined);
    expect(ok?.status).toBe('ok');
    expect(service.ackInteraction).toHaveBeenCalledWith('i_1', 0);
  });

  it('lists and creates panels under the menu switch', async () => {
    const { router, service } = makeRouter(noaConf({ menu: true }));
    const missingScope = await router.dispatch('noa_list_panels', {}, undefined);
    expect(missingScope?.retcode).toBe(1400);

    const list = await router.dispatch('noa_list_panels', { scope: 'group', limit: 20 }, undefined);
    expect(list?.data).toEqual({ records: [] });
    expect(service.listPanels).toHaveBeenCalledWith('group', undefined, 20);

    const created = await router.dispatch('noa_set_panel', { panel: { scope: 'group' } }, undefined);
    expect(created?.data).toEqual({ panel_id: 'p_1' });
    expect(service.createPanel).toHaveBeenCalledWith({ scope: 'group' });

    const menu = await router.dispatch('noa_set_menu', { menu: { items: [] } }, undefined);
    expect(menu?.data).toEqual({ version: 3 });
  });

  it('requires at least one field for the join approval policy', async () => {
    const { router, mapper, service } = makeRouter(noaConf({ joinPolicy: true }));
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const empty = await router.dispatch('noa_set_group_add_request_policy', { group_id: groupId }, undefined);
    expect(empty?.retcode).toBe(1400);

    const ok = await router.dispatch(
      'noa_set_group_add_request_policy',
      { group_id: groupId, enable: true, whitelist_users: [1234567, '2345678'], execute: true },
      undefined,
    );
    expect(ok?.status).toBe('ok');
    expect(service.setJoinPolicy).toHaveBeenCalledWith({
      groupOpenid: 'GROUP_A',
      enable: true,
      expireAt: undefined,
      remark: undefined,
      whitelistUsers: ['1234567', '2345678'],
      whitelistOp: 'add',
      execute: true,
    });
  });

  it('drives the single-chat stream lifecycle', async () => {
    const { router, mapper, service } = makeRouter(noaConf({ stream: true }));
    const userId = Number(mapper.pseudoOf('USER_A'));

    const group = await router.dispatch('noa_stream_begin', { group_id: 1, content: 'x' }, undefined);
    expect(group?.retcode).toBe(1404);
    const refIdx = await router.dispatch('noa_stream_begin', { user_id: userId, content: 'x', ref_idx: 'REFIDX' }, undefined);
    expect(refIdx?.retcode).toBe(1400);

    const begin = await router.dispatch('noa_stream_begin', { user_id: userId, content: 'x' }, undefined);
    expect(begin?.data).toMatchObject({ stream_id: 's_1', index: 1, passive: true });

    const append = await router.dispatch('noa_stream_append', { stream_id: 's_1', content: 'xy' }, undefined);
    expect(append?.data).toMatchObject({ stream_id: 's_1', index: 2 });

    const end = await router.dispatch('noa_stream_end', { stream_id: 's_1' }, undefined);
    expect(end?.data).toMatchObject({ stream_id: 's_1' });
    expect(service.streamEnd).toHaveBeenCalledWith('s_1', undefined);
  });

  it('rejects group wakeup and routes single-chat wakeup', async () => {
    const { router, mapper, service } = makeRouter(noaConf({ wakeup: true }));
    const userId = Number(mapper.pseudoOf('USER_A'));
    const group = await router.dispatch('noa_send_wakeup', { group_id: 1, message: 'x' }, undefined);
    expect(group?.retcode).toBe(1404);

    const ok = await router.dispatch('noa_send_wakeup', { user_id: userId, message: '回来看看' }, undefined);
    expect(ok?.status).toBe('ok');
    expect(service.sendWakeup).toHaveBeenCalledWith('USER_A', '回来看看');
  });
});
