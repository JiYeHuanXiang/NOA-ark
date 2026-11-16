import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RecentMessageCache } from '../src/bridge.js';
import { IdMapper } from '../src/core/idmap.js';
import { MilkyActionRouter } from '../src/milky/actions.js';
import type { CachedMessage, MessageSender } from '../src/onebot/actions.js';

function makeRouter() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noa-milky-'));
  const mapper = new IdMapper({ file: path.join(dir, 'idmap.json') });
  const cache = new RecentMessageCache();
  const sender = {
    sendGroupText: vi.fn(async () => ({ messageId: 'RAW_OUT', passive: true })),
    sendPrivateText: vi.fn(async () => ({ messageId: 'RAW_OUT', passive: true })),
    setGroupBan: vi.fn(async () => undefined),
    recall: vi.fn(async () => undefined),
    approveGroupRequest: vi.fn(async () => undefined),
  } as unknown as MessageSender;
  const router = new MilkyActionRouter({
    sender,
    messageCache: cache,
    idMode: 'mapped',
    mapper,
    selfOpenid: 'BOT_OPENID',
    selfNickname: 'noa-ark',
  });
  return { router, mapper, cache, sender };
}

describe('MilkyActionRouter', () => {
  it('returns the cached message_seq without remapping it', async () => {
    const { router, mapper, cache } = makeRouter();
    const pseudo = mapper.pseudoMsgOf('RAW_MSG');
    const record: CachedMessage = {
      rawMsgId: 'RAW_MSG',
      scope: 'group',
      peerOpenid: 'GROUP_A',
      senderOpenid: 'USER_A',
      senderName: 'Alice',
      segments: [{ type: 'text', data: { text: 'hi' } }],
      rawMessage: 'hi',
      tsMs: Date.now(),
    };
    cache.put(pseudo, record);

    const r = await router.dispatch('get_message', { message_seq: Number(pseudo) });
    expect(r.status).toBe('ok');
    expect((r.data as { message: { message_seq: number } }).message.message_seq).toBe(Number(pseudo));

    expect(mapper.rawMsgOf(String(Number(pseudo) + 1))).toBeNull();
  });

  it('derives get_login_info uin from the bot openid, not the app id', async () => {
    const { router, mapper } = makeRouter();
    const r = await router.dispatch('get_login_info', {});
    expect(r.status).toBe('ok');
    expect((r.data as { uin: number }).uin).toBe(Number(mapper.selfPseudo('BOT_OPENID')));
  });

  it('rejects muting an unresolved user instead of muting the whole group', async () => {
    const { router, mapper, sender } = makeRouter();
    const groupId = Number(mapper.pseudoOf('GROUP_A'));
    const r = await router.dispatch('set_group_member_mute', {
      group_id: groupId,
      user_id: 123456,
    });
    expect(r.status).toBe('failed');
    expect(r.retcode).toBe(-400);
    expect(sender.setGroupBan).not.toHaveBeenCalled();
  });
});
