import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IdMapper } from '../src/core/idmap.js';
import { OneBotActionRouter, type CachedMessage, type MessageSender } from '../src/onebot/actions.js';

function tempIdMap(): IdMapper {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-actions-'));
  return new IdMapper({ file: path.join(dir, 'idmap.json') });
}

function makeRouter(overrides?: Partial<MessageSender>) {
  const mapper = tempIdMap();
  const sender: MessageSender = {
    sendGroupText: vi.fn(async () => ({ messageId: 'RAW_OUT_1', passive: true })),
    sendPrivateText: vi.fn(async () => ({ messageId: 'RAW_OUT_2', passive: true })),
    recall: vi.fn(async () => undefined),
    setGroupBan: vi.fn(async () => undefined),
    approveGroupRequest: vi.fn(async () => undefined),
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

  it('sends group text through the injected sender', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', { group_id: groupId, message: 'hello' });
    expect(r.status).toBe('ok');
    expect(sender.sendGroupText).toHaveBeenCalledWith('GROUP_A', 'hello');
    const data = r.data as { message_id: number; passive: boolean };
    expect(data.message_id).toBe(Number(mapper.pseudoMsgOf('RAW_OUT_1')));
    expect(data.passive).toBe(true);
  });

  it('rejects unknown group ids with retcode 1400', async () => {
    const { router } = makeRouter();
    const r = await router.dispatch('send_group_msg', { group_id: 999, message: 'hi' });
    expect(r.status).toBe('failed');
    expect(r.retcode).toBe(1400);
    expect(r.message).toContain('未知 group_id');
  });

  it('rejects rich media sends explicitly (phase 2)', async () => {
    const { router, sender, mapper } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'image', data: { file: 'https://example.com/a.png' } }],
    });
    expect(r.status).toBe('failed');
    expect(r.message).toContain('富媒体');
    expect(sender.sendGroupText).not.toHaveBeenCalled();
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

  it('rejects set_group_kick with 1404', async () => {
    const { router } = makeRouter();
    const r = await router.dispatch('set_group_kick', { group_id: 1, user_id: 2 });
    expect(r.retcode).toBe(1404);
  });
});
