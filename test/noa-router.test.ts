import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IdMapper } from '../src/core/idmap.js';
import { DEFAULT_NOA_EXT, type DshChatConf, type NoaConf, type NoaExtConf } from '../src/config.js';
import { NoaActionRouter, type NoaAiChat } from '../src/noa/router.js';
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
    getMenu: vi.fn(async () => ({ version: 3, menu: { items: [] } })),
    createPanel: vi.fn(async () => ({ panel_id: 'p_1' })),
    listPanels: vi.fn(async () => ({ records: [] })),
    getPanel: vi.fn(async () => ({ panel_id: 'p_1' })),
    updatePanel: vi.fn(async () => ({ version: 2 })),
    deletePanel: vi.fn(async () => undefined),
    setPanelTarget: vi.fn(async () => undefined),
    setJoinPolicy: vi.fn(async () => ({ strategy_id: 'st_1', is_enable: 'on', expire_at: '' })),
    listJoinRequests: vi.fn(async () => ({
      list: [{ join_request_id: 'jr_1', member_openid: 'USER_A', flag: 'GROUP_A:USER_A:jr_1' }],
      nextCursor: 'C2',
    })),
    handleJoinRequest: vi.fn(async () => undefined),
    listJoinPolicies: vi.fn(async () => ({ strategies: [{ strategy_id: 'st_1' }], nextCursor: '' })),
    deleteJoinPolicy: vi.fn(async () => undefined),
    getMuteState: vi.fn(async () => ({
      global_rule: { mode: 'none' },
      members: [{ member_openid: 'USER_A', mute_expire_at: '2027-01-01T00:00:00+08:00' }],
    })),
    setMemberMutes: vi.fn(async () => undefined),
    listBlacklist: vi.fn(async () => ({
      users: [{ member_openid: 'USER_B', username: 'Bob' }],
      nextCursor: '',
    })),
    updateBlacklist: vi.fn(async () => ({ failedOpenids: ['USER_B'] })),
    getGroupBotState: vi.fn(async () => ({ member_openid: 'USER_A', recv_msg_setting: 'all' })),
    uploadMediaImage: vi.fn(async () => ({
      imageId: 'img_1',
      url: 'qqbot-media://image/v1/token',
      ttl: 100,
    })),
    listMediaImages: vi.fn(async () => ({ images: [], next_cursor: '', total: 0 })),
    deleteMediaImage: vi.fn(async () => undefined),
    generateUrlLink: vi.fn(async () => ({ url: 'https://qun.qq.com/x' })),
    streamBegin: vi.fn(async () => ({ streamId: 's_1', index: 1, remainMsgLen: 10, passive: true })),
    streamAppend: vi.fn(async () => ({ streamId: 's_1', index: 2, remainMsgLen: 5 })),
    streamEnd: vi.fn(async () => ({ streamId: 's_1', ended: true as const, remainMsgLen: 0 })),
    sendWakeup: vi.fn(async () => undefined),
  };
}

function dshChat(overrides: Partial<DshChatConf> = {}): DshChatConf {
  return {
    enable: false,
    restrictTools: true,
    timeoutMs: 120_000,
    sessionIdleMs: 30 * 60_000,
    cwd: '',
    ...overrides,
  };
}

function makeRouter(
  conf: NoaConf,
  service = makeService(),
  options: { dshChat?: Partial<DshChatConf>; ai?: NoaAiChat } = {},
) {
  const mapper = tempMapper();
  const router = new NoaActionRouter({
    conf,
    service: service as unknown as NoaExtensionService,
    mapper,
    idMode: 'mapped',
    logger: { warn: () => undefined },
    dshChat: () => dshChat(options.dshChat),
    ...(options.ai === undefined ? {} : { ai: options.ai }),
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

  it('routes menu and panel read/write actions under noa.ext.menu', async () => {
    const { router, service } = makeRouter(noaConf({ menu: true }));

    const menu = await router.dispatch('noa_get_menu', {}, undefined);
    expect(menu?.data).toEqual({ version: 3, menu: { items: [] } });

    const detail = await router.dispatch('noa_get_panel', { panel_id: 'p_1' }, undefined);
    expect(detail?.data).toEqual({ panel_id: 'p_1' });

    const updated = await router.dispatch('noa_update_panel', { panel_id: 'p_1', panel: { remark: 'x' } }, undefined);
    expect(updated?.data).toEqual({ version: 2 });
    expect(service.updatePanel).toHaveBeenCalledWith('p_1', { remark: 'x' });

    const target = await router.dispatch(
      'noa_set_panel_target',
      { panel_id: 'p_1', op: 'add', group_openids: ['GROUP_A'] },
      undefined,
    );
    expect(target?.status).toBe('ok');
    expect(service.setPanelTarget).toHaveBeenCalledWith('p_1', 'add', { groupOpenids: ['GROUP_A'] });

    const badTarget = await router.dispatch(
      'noa_set_panel_target',
      { panel_id: 'p_1', op: 'add', user_openids: ['U'], group_openids: ['G'] },
      undefined,
    );
    expect(badTarget?.retcode).toBe(1400);

    const deleted = await router.dispatch('noa_delete_panel', { panel_id: 'p_1' }, undefined);
    expect(deleted?.status).toBe('ok');
    expect(service.deletePanel).toHaveBeenCalledWith('p_1');
  });

  it('lists and handles join requests with mapped user ids', async () => {
    const { router, mapper, service } = makeRouter(noaConf({ joinPolicy: true }));
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const userId = Number(mapper.pseudoOf('USER_A'));

    const list = await router.dispatch('noa_list_join_requests', { group_id: groupId }, undefined);
    expect(list?.data).toMatchObject({
      list: [{ join_request_id: 'jr_1', member_openid: 'USER_A', user_id: userId }],
      next_cursor: 'C2',
    });
    expect(service.listJoinRequests).toHaveBeenCalledWith('GROUP_A', undefined, undefined);

    const bad = await router.dispatch(
      'noa_handle_join_request',
      { group_id: groupId, user_id: userId, op: 'approve', reject_reason: 'x' },
      undefined,
    );
    expect(bad?.retcode).toBe(1400);

    const ok = await router.dispatch(
      'noa_handle_join_request',
      {
        group_id: groupId,
        user_id: userId,
        op: 'decline',
        join_request_id: 'jr_1',
        reject_reason: '满员',
        add_to_member_blacklist: true,
      },
      undefined,
    );
    expect(ok?.status).toBe('ok');
    expect(service.handleJoinRequest).toHaveBeenCalledWith('GROUP_A', 'USER_A', {
      op: 'decline',
      joinRequestId: 'jr_1',
      rejectReason: '满员',
      addToMemberBlacklist: true,
    });
  });

  it('routes group admin queries and validates mute payloads', async () => {
    const { router, mapper, service } = makeRouter(noaConf({ groupAdmin: true }));
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const userId = Number(mapper.pseudoOf('USER_A'));

    const muted = await router.dispatch('noa_get_mute_state', { group_id: groupId }, undefined);
    expect(muted?.data).toMatchObject({
      global_rule: { mode: 'none' },
      members: [{ member_openid: 'USER_A', user_id: userId }],
    });

    const bad = await router.dispatch(
      'noa_set_member_mutes',
      { group_id: groupId, members: [{ op: 'add', user_id: userId }] },
      undefined,
    );
    expect(bad?.retcode).toBe(1400);

    const ok = await router.dispatch(
      'noa_set_member_mutes',
      { group_id: groupId, members: [{ op: 'add', user_id: userId, mute_expire_at: '2027-01-01T00:00:00+08:00' }] },
      undefined,
    );
    expect(ok?.status).toBe('ok');
    expect(service.setMemberMutes).toHaveBeenCalledWith('GROUP_A', [
      { op: 'add', memberOpenid: 'USER_A', muteExpireAt: '2027-01-01T00:00:00+08:00' },
    ]);

    const blacklist = await router.dispatch('noa_list_blacklist', { group_id: groupId }, undefined);
    const blacklistUsers = (blacklist?.data as { users: Array<Record<string, unknown>> }).users;
    expect(blacklistUsers[0]).toMatchObject({ member_openid: 'USER_B', username: 'Bob' });
    expect(typeof blacklistUsers[0]?.user_id).toBe('number');

    const tooMany = Array.from({ length: 21 }, () => 'USER_X');
    const rejected = await router.dispatch(
      'noa_update_blacklist',
      { group_id: groupId, op: 'add', member_openids: tooMany },
      undefined,
    );
    expect(rejected?.retcode).toBe(1400);

    const updated = await router.dispatch(
      'noa_update_blacklist',
      { group_id: groupId, op: 'add', user_ids: [userId] },
      undefined,
    );
    expect(updated?.data).toEqual({ fail_openids: ['USER_B'], fail_user_ids: ['USER_B'] });

    const state = await router.dispatch('noa_get_group_bot_state', { group_id: groupId }, undefined);
    expect(state?.data).toMatchObject({ user_id: userId, recv_msg_setting: 'all' });
  });

  it('gates material/share actions and validates callback_data', async () => {
    const { router, service } = makeRouter(noaConf({ material: true, share: true }));

    const uploaded = await router.dispatch(
      'noa_upload_media_image',
      { file: 'https://example.com/a.png', file_name: 'a.png' },
      undefined,
    );
    expect(uploaded?.data).toMatchObject({ image_id: 'img_1', url: 'qqbot-media://image/v1/token' });

    const listed = await router.dispatch('noa_list_media_images', {}, undefined);
    expect(listed?.data).toMatchObject({ images: [], total: 0 });

    const deleted = await router.dispatch('noa_delete_media_image', { image_id: 'img_1' }, undefined);
    expect(deleted?.status).toBe('ok');
    expect(service.deleteMediaImage).toHaveBeenCalledWith('img_1');

    const longData = 'x'.repeat(33);
    const badLink = await router.dispatch('noa_generate_url_link', { callback_data: longData }, undefined);
    expect(badLink?.retcode).toBe(1400);

    const link = await router.dispatch('noa_generate_url_link', { callback_data: 'abc' }, undefined);
    expect(link?.data).toEqual({ url: 'https://qun.qq.com/x' });
    expect(service.generateUrlLink).toHaveBeenCalledWith('abc');
  });

  it('rejects extension actions when their extension is disabled', async () => {
    const { router } = makeRouter(noaConf());
    for (const action of [
      'noa_get_menu',
      'noa_get_panel',
      'noa_list_join_requests',
      'noa_get_mute_state',
      'noa_list_media_images',
      'noa_generate_url_link',
    ]) {
      const result = await router.dispatch(action, {}, undefined);
      expect(result?.retcode).toBe(1404);
    }
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

  describe('noa_dsh_chat', () => {
    it('fails closed outside the dsh plugin and when disabled', async () => {
      const standalone = makeRouter(noaConf(), makeService(), { dshChat: { enable: true } });
      const outside = await standalone.router.dispatch('noa_dsh_chat', { message: 'hi' }, undefined);
      expect(outside?.retcode).toBe(1404);
      expect(outside?.message).toContain('dsh 插件');

      const ai: NoaAiChat = { chat: vi.fn() };
      const disabled = makeRouter(noaConf(), makeService(), { ai });
      const off = await disabled.router.dispatch('noa_dsh_chat', { message: 'hi' }, undefined);
      expect(off?.retcode).toBe(1404);
      expect(ai.chat).not.toHaveBeenCalled();
    });

    it('validates message, conversation_id and timeout', async () => {
      const ai: NoaAiChat = { chat: vi.fn(async () => ({ reply: 'ok', conversationId: 'c', restricted: true })) };
      const { router } = makeRouter(noaConf(), makeService(), { dshChat: { enable: true }, ai });

      expect((await router.dispatch('noa_dsh_chat', { message: '   ' }, undefined))?.retcode).toBe(1400);
      expect((await router.dispatch('noa_dsh_chat', { message: 'x'.repeat(32_001) }, undefined))?.retcode).toBe(1400);
      expect((await router.dispatch('noa_dsh_chat', { message: 'x', conversation_id: 'bad id!' }, undefined))?.retcode)
        .toBe(1400);
      expect((await router.dispatch('noa_dsh_chat', { message: 'x', timeout_ms: 500 }, undefined))?.retcode).toBe(1400);
      expect(ai.chat).not.toHaveBeenCalled();
    });

    it('returns the reply and passes conversation/timeout through', async () => {
      const chat = vi.fn(async () => ({ reply: '你好', conversationId: 'peer-1', restricted: true }));
      const { router } = makeRouter(noaConf(), makeService(), {
        dshChat: { enable: true },
        ai: { chat },
      });

      const result = await router.dispatch(
        'noa_dsh_chat',
        { message: '你好呀', conversation_id: 'peer-1', timeout_ms: 30_000 },
        'e1',
      );
      expect(result?.status).toBe('ok');
      expect(result?.data).toEqual({ reply: '你好', conversation_id: 'peer-1', restricted: true });
      expect(chat).toHaveBeenCalledWith({ message: '你好呀', conversationId: 'peer-1', timeoutMs: 30_000 });
    });

    it('surfaces AI failures as 1400', async () => {
      const { router } = makeRouter(noaConf(), makeService(), {
        dshChat: { enable: true },
        ai: { chat: vi.fn(async () => { throw new Error('模型不可用'); }) },
      });
      const result = await router.dispatch('noa_dsh_chat', { message: 'hi' }, undefined);
      expect(result?.retcode).toBe(1400);
      expect(result?.message).toContain('模型不可用');
    });
  });
});
