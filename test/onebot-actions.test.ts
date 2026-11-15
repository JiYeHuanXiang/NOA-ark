import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IdMapper } from '../src/core/idmap.js';
import type { MediaCache } from '../src/core/media-cache.js';
import {
  OneBotActionRouter,
  type ActionDeps,
  type CachedMessage,
  type MessageSender,
} from '../src/onebot/actions.js';

function tempIdMap(): IdMapper {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-actions-'));
  return new IdMapper({ file: path.join(dir, 'idmap.json') });
}

function makeRouter(
  overrides?: Partial<MessageSender>,
  extraDeps?: Partial<ActionDeps>,
) {
  const mapper = tempIdMap();
  const sender: MessageSender = {
    sendGroupText: vi.fn(async () => ({ messageId: 'RAW_OUT_1', passive: true })),
    sendPrivateText: vi.fn(async () => ({ messageId: 'RAW_OUT_2', passive: true })),
    sendGroupParts: vi.fn(async (_group, parts) => ({
      parts: Array.from({ length: parts.length }, (_, i) => ({ messageId: `RAW_OUT_${i + 1}`, refIdx: `REFIDX_OUT_${i + 1}` })),
      passive: true,
    })),
    sendPrivateParts: vi.fn(async (_user, parts) => ({
      parts: Array.from({ length: parts.length }, (_, i) => ({ messageId: `RAW_PM_${i + 1}` })),
      passive: true,
    })),
    getGroupInfo: vi.fn(async () => null),
    recall: vi.fn(async () => undefined),
    setGroupBan: vi.fn(async () => undefined),
    approveGroupRequest: vi.fn(async () => undefined),
    approveJoinRequest: vi.fn(async () => undefined),
    listGroupMembers: vi.fn(async () => ({ members: [], nextCursor: '' })),
    getGroupMember: vi.fn(async () => ({
      memberOpenid: 'USER_B',
      username: 'Bob',
      role: 'member',
      bot: false,
      joinedAt: '2025-08-20T09:15:00+08:00',
    })),
    batchRemoveGroupMembers: vi.fn(async () => ({ failedBlacklistOpenids: [] })),
    ...overrides,
  };
  const cache = new Map<string, CachedMessage>();
  const router = new OneBotActionRouter({
    idMode: 'mapped',
    mapper,
    sender,
    messageCache: {
      put: (id, record) => cache.set(id, record),
      get: (id) => cache.get(id),
    },
    groupDirectory: {
      list: () => [{ openid: 'GROUP_A', alias: '测试群' }],
      get: (openid) => (openid === 'GROUP_A' ? { openid: 'GROUP_A', alias: '测试群' } : undefined),
    },
    selfOpenid: 'BOT_OPENID',
    selfNickname: 'Arona',
    logger: { warn: () => undefined },
    ...extraDeps,
  });
  return { router, sender, mapper, cache };
}

describe('OneBotActionRouter', () => {
  it('rejects unsupported actions with retcode 1404', async () => {
    const { router } = makeRouter();
    const r = await router.dispatch('get_friend_list', {});
    expect(r.status).toBe('failed');
    expect(r.retcode).toBe(1404);
    expect(r.message).toContain('好友列表');
  });

  it('rejects unknown actions with retcode 1404', async () => {
    const { router } = makeRouter();
    const r = await router.dispatch('not_an_action', {});
    expect(r.retcode).toBe(1404);
  });

  it('returns login info with the derived self pseudo id', async () => {
    const { router, mapper } = makeRouter();
    const r = await router.dispatch('get_login_info', {}, 'echo1');
    expect(r.status).toBe('ok');
    expect(r.echo).toBe('echo1');
    expect((r.data as { user_id: number }).user_id).toBe(Number(mapper.selfPseudo('BOT_OPENID')));
  });

  it('composes get_group_list from the directory', async () => {
    const { router, mapper } = makeRouter();
    const r = await router.dispatch('get_group_list', {});
    expect(r.status).toBe('ok');
    const list = r.data as Array<{ group_id: number; group_name: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.group_id).toBe(Number(mapper.pseudoOf('GROUP_A')));
    expect(list[0]!.group_name).toBe('测试群');
  });

  it('sends group text as an ordered part through the injected sender', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', { group_id: groupId, message: 'hello' });
    expect(r.status).toBe('ok');
    expect(sender.sendGroupParts).toHaveBeenCalledWith('GROUP_A', [{ kind: 'text', text: 'hello' }], { refIdx: '' });
    const data = r.data as { message_id: number; passive: boolean };
    expect(data.message_id).toBe(Number(mapper.pseudoMsgOf('RAW_OUT_1')));
    expect(data.passive).toBe(true);
  });

  it('forwards event_id as the passive reply key', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: 'hi',
      event_id: 'EV_1',
    });
    expect(r.status).toBe('ok');
    expect(sender.sendGroupParts).toHaveBeenCalledWith(
      'GROUP_A',
      [{ kind: 'text', text: 'hi' }],
      { refIdx: '', eventId: 'EV_1' },
    );
  });

  it('approves join requests through the new endpoint when the flag has three parts', async () => {
    const { router, sender } = makeRouter();
    const r = await router.dispatch('set_group_add_request', {
      flag: 'GROUP_A:USER_E:jr_1',
      approve: false,
      reason: '满员',
    });
    expect(r.status).toBe('ok');
    expect(sender.approveJoinRequest).toHaveBeenCalledWith('GROUP_A', 'USER_E', {
      op: 'decline',
      joinRequestId: 'jr_1',
      rejectReason: '满员',
    });

    const legacy = await router.dispatch('set_group_add_request', {
      flag: 'GROUP_A:42',
      approve: true,
    });
    expect(legacy.status).toBe('ok');
    expect(sender.approveGroupRequest).toHaveBeenCalledWith('GROUP_A', '42', true);
  });

  it('rejects legacy flags without a usable event seq', async () => {
    const { router, sender } = makeRouter();
    for (const flag of ['', 'GROUP_A:0', 'GROUP_A:', 'GROUP_A', 'GROUP_A:USER_E:']) {
      const r = await router.dispatch('set_group_add_request', { flag, approve: true });
      expect(r.retcode).toBe(1400);
    }
    expect(sender.approveGroupRequest).not.toHaveBeenCalled();
    expect(sender.approveJoinRequest).not.toHaveBeenCalled();
  });

  it('rejects unknown group ids with retcode 1400', async () => {
    const { router } = makeRouter();
    const r = await router.dispatch('send_group_msg', { group_id: 999, message: 'hi' });
    expect(r.status).toBe('failed');
    expect(r.retcode).toBe(1400);
    expect(r.message).toContain('未知 group_id');
  });

  it('sends rich media as media parts (msg_type=7 path)', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [
        { type: 'text', data: { text: '看图' } },
        { type: 'image', data: { file: 'https://example.com/a.png' } },
      ],
    });
    expect(r.status).toBe('ok');
    expect(sender.sendGroupParts).toHaveBeenCalledWith(
      'GROUP_A',
      [
        { kind: 'text', text: '看图' },
        { kind: 'media', mediaType: 'image', file: 'https://example.com/a.png' },
      ],
      { refIdx: '' },
    );
    const data = r.data as { message_ids: number[] };
    expect(data.message_ids).toHaveLength(2);
  });

  it('sends group @全体成员 as qqbot-at-everyone in a text message', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 开播了' } }],
    });
    expect(r.status).toBe('ok');
    expect(sender.sendGroupParts).toHaveBeenCalledWith(
      'GROUP_A',
      [{ kind: 'text', text: '<qqbot-at-everyone /> 开播了' }],
      { refIdx: '' },
    );
  });

  it('rejects group @user (needs markdown), c2c @, and face segments explicitly', async () => {
    const { router, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const userId = mapper.pseudoOf('USER_B');

    const atUser = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'at', data: { qq: userId } }],
    });
    expect(atUser.retcode).toBe(1400);
    expect(atUser.message).toContain('markdown');

    const c2cAll = await router.dispatch('send_private_msg', {
      user_id: userId,
      message: [{ type: 'at', data: { qq: 'all' } }],
    });
    expect(c2cAll.retcode).toBe(1400);
    expect(c2cAll.message).toContain('单聊不支持');

    const face = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: '[CQ:face,id=1]',
    });
    expect(face.retcode).toBe(1400);
    expect(face.message).toContain('表情');
  });

  it('uses cached REFIDX for quote replies', async () => {
    const { router, sender, mapper, cache } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const rawId = 'RAW_IN_QUOTE';
    const pseudo = mapper.pseudoMsgOf(rawId);
    cache.set(pseudo, {
      rawMsgId: rawId,
      refIdx: 'REFIDX_ABC',
      scope: 'group',
      peerOpenid: 'GROUP_A',
      senderOpenid: 'USER_B',
      senderName: 'Bob',
      segments: [],
      rawMessage: '',
      tsMs: Date.now(),
    });
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'reply', data: { id: pseudo } }, { type: 'text', data: { text: '收到' } }],
    });
    expect(r.status).toBe('ok');
    expect(sender.sendGroupParts).toHaveBeenCalledWith(
      'GROUP_A',
      [{ kind: 'text', text: '收到' }],
      { refIdx: 'REFIDX_ABC' },
    );
    expect((r.data as { quoted: boolean }).quoted).toBe(true);
  });

  it('degrades a quote to a normal reply when REFIDX is unavailable', async () => {
    const { router, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'reply', data: { id: 999 } }, { type: 'text', data: { text: '嗯' } }],
    });
    expect(r.status).toBe('ok');
    const data = r.data as { quoted: boolean; warning?: string };
    expect(data.quoted).toBe(false);
    expect(data.warning).toContain('缓存');
  });

  it('rejects noa_markdown explicitly instead of silently sending its text', async () => {
    const { router, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'noa_markdown', data: { content: '**x**' } }],
    });
    expect(r.retcode).toBe(1400);
    expect(r.message).toContain('文档');
  });

  it('routes set_group_whole_ban through the official whole-group mute path', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const on = await router.dispatch('set_group_whole_ban', { group_id: groupId, enable: true });
    expect(on.status).toBe('ok');
    expect(sender.setGroupBan).toHaveBeenCalledWith('GROUP_A', 86_400);
    const off = await router.dispatch('set_group_whole_ban', { group_id: groupId, enable: false });
    expect(off.status).toBe('ok');
    expect(sender.setGroupBan).toHaveBeenLastCalledWith('GROUP_A', 0);
    const missing = await router.dispatch('set_group_whole_ban', { group_id: groupId });
    expect(missing.retcode).toBe(1400);
  });

  it('merges official group info into get_group_info', async () => {
    const { router, mapper } = makeRouter({
      getGroupInfo: vi.fn(async () => ({ groupName: '官方群名', memberCount: 42 })),
    });
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('get_group_info', { group_id: groupId });
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({
      group_name: '官方群名',
      member_count: 42,
      source: 'official',
    });
  });

  it('rejects json/xml card segments explicitly', async () => {
    const { router, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_msg', {
      message_type: 'group',
      group_id: groupId,
      message: '[CQ:json,data={"app":"x"}]',
    });
    expect(r.status).toBe('failed');
    expect(r.message).toContain('json');
  });

  it('recalls a cached message through the sender', async () => {
    const { router, sender, mapper, cache } = makeRouter();
    const rawId = 'RAW_IN_1';
    const pseudo = mapper.pseudoMsgOf(rawId);
    cache.set(pseudo, {
      rawMsgId: rawId,
      scope: 'group',
      peerOpenid: 'GROUP_A',
      senderOpenid: 'USER_B',
      senderName: 'Bob',
      segments: [{ type: 'text', data: { text: 'x' } }],
      rawMessage: 'x',
      tsMs: Date.now(),
    });
    const r = await router.dispatch('delete_msg', { message_id: Number(pseudo) });
    expect(r.status).toBe('ok');
    expect(sender.recall).toHaveBeenCalledWith('group', 'GROUP_A', rawId);
  });

  it('caches outbound messages so delete_msg can recall the bot’s own reply', async () => {
    const { router, sender, mapper, cache } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const send = await router.dispatch('send_group_msg', { group_id: groupId, message: 'hi' });
    expect(send.status).toBe('ok');
    const data = send.data as { message_id: number };

    const record = cache.get(String(data.message_id));
    expect(record?.rawMsgId).toBe('RAW_OUT_1');
    expect(record?.refIdx).toBe('REFIDX_OUT_1');

    const recall = await router.dispatch('delete_msg', { message_id: data.message_id });
    expect(recall.status).toBe('ok');
    expect(sender.recall).toHaveBeenCalledWith('group', 'GROUP_A', 'RAW_OUT_1');
  });

  it('lists group members through the whitelist API and paginates', async () => {
    const pages: Record<string, { members: Array<{ memberOpenid: string; username: string; role: string; bot: boolean; joinedAt: string }>; nextCursor: string }> = {
      '': {
        members: [{ memberOpenid: 'USER_B', username: 'Bob', role: 'admin', bot: false, joinedAt: '2025-08-20T09:15:00+08:00' }],
        nextCursor: 'CURSOR_2',
      },
      CURSOR_2: {
        members: [{ memberOpenid: 'USER_C', username: 'Carol', role: 'owner', bot: false, joinedAt: '' }],
        nextCursor: '',
      },
    };
    const listGroupMembers = vi.fn(async (_group: string, cursor?: string) => pages[cursor ?? '']!);
    const { router, mapper } = makeRouter({ listGroupMembers });
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('get_group_member_list', { group_id: groupId });
    expect(r.status).toBe('ok');
    expect(listGroupMembers).toHaveBeenCalledTimes(2);
    const list = r.data as Array<{ user_id: number; role: string; join_time: number }>;
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe('admin');
    expect(list[1]!.user_id).toBe(Number(mapper.pseudoOf('USER_C')));
    expect(list[0]!.join_time).toBe(Math.floor(Date.parse('2025-08-20T09:15:00+08:00') / 1000));
  });

  it('returns official group member info and keeps the self fallback', async () => {
    const { router, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const userId = Number(mapper.pseudoOf('USER_B'));
    const r = await router.dispatch('get_group_member_info', { group_id: groupId, user_id: userId });
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({ nickname: 'Bob', role: 'member' });

    const self = await router.dispatch('get_group_member_info', {
      group_id: groupId,
      user_id: Number(mapper.selfPseudo('BOT_OPENID')),
    });
    expect(self.data).toMatchObject({ nickname: 'Arona' });
  });

  it('kicks a member through batch remove and maps reject_add_request to blacklist', async () => {
    const { router, mapper, sender } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const userId = Number(mapper.pseudoOf('USER_B'));
    const r = await router.dispatch('set_group_kick', {
      group_id: groupId,
      user_id: userId,
      reject_add_request: true,
    });
    expect(r.status).toBe('ok');
    expect(sender.batchRemoveGroupMembers).toHaveBeenCalledWith(
      'GROUP_A',
      [mapper.openidOf(String(userId))],
      true,
    );
  });

  it('reports the real gateway online state in get_status', async () => {
    const { router } = makeRouter(undefined, { isOnline: () => false });
    const r = await router.dispatch('get_status', {});
    expect(r.data).toMatchObject({ online: false, good: false });
  });

  it('emits message_sent after a successful send', async () => {
    const events: Array<Record<string, unknown>> = [];
    const { router, mapper } = makeRouter(undefined, {
      emitEvent: (event) => events.push(event as Record<string, unknown>),
    });
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    await router.dispatch('send_group_msg', { group_id: groupId, message: 'hi' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      post_type: 'message_sent',
      message_type: 'group',
      group_id: groupId,
      raw_message: 'hi',
    });
  });

  it('caches media through get_image', async () => {
    const fetchMedia = vi.fn(async () => ({ path: 'C:/tmp/a.png', size: 3, cached: false }));
    const { router } = makeRouter(undefined, {
      mediaCache: { fetch: fetchMedia } as unknown as MediaCache,
    });
    const r = await router.dispatch('get_image', { file: 'https://example.com/a.png' });
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({ file: 'C:/tmp/a.png', url: 'https://example.com/a.png' });
    expect(fetchMedia).toHaveBeenCalledWith('https://example.com/a.png');
  });

  it('rejects set_group_ban without user_id instead of muting the whole group', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('set_group_ban', { group_id: groupId, duration: 60 });
    expect(r.status).toBe('failed');
    expect(r.retcode).toBe(1400);
    expect(sender.setGroupBan).not.toHaveBeenCalled();
  });

  it('normalizes get_group_info group_id to the exposed pseudo id', async () => {
    const { router, mapper } = makeRouter({
      getGroupInfo: vi.fn(async () => ({ groupName: '官方群名', memberCount: 42 })),
    });
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('get_group_info', { group_id: String(groupId) });
    expect(r.status).toBe('ok');
    expect((r.data as { group_id: number }).group_id).toBe(groupId);
  });
});
