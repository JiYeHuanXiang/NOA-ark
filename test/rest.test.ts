import { describe, expect, it, vi } from 'vitest';
import { Rest } from '../src/official/rest.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeRest(): { rest: Rest; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/app/getAppAccessToken')) {
      return jsonResponse({ access_token: 'TOKEN', expires_in: 7200 });
    }
    calls.push({ url, init: init ?? {} });
    if (url.endsWith('/info')) {
      return jsonResponse({
        group_openid: 'GROUP_A',
        group_name: '读书分享会',
        group_member_num: 256,
        group_finger_memo: '每周共读',
      });
    }
    if (url.endsWith('/files')) {
      return jsonResponse({ file_info: 'FILE_INFO', ttl: 300 });
    }
    if (url.includes('/members/')) {
      return jsonResponse({
        member_openid: 'USER_B',
        username: 'Bob',
        member_role: 'admin',
        bot: false,
        joined_at: '2025-08-20T09:15:00+08:00',
      });
    }
    if (url.endsWith('/members') || url.includes('/members?')) {
      return jsonResponse({
        members: [
          {
            member_openid: 'USER_A',
            username: 'Alice',
            member_role: 'member',
            bot: false,
            joined_at: '2025-07-01T10:30:00+08:00',
          },
        ],
        next_cursor: 'C2',
      });
    }
    if (url.endsWith('/batch_remove_members')) {
      return jsonResponse({
        remove_members_result: 'success',
        add_to_member_blacklist_fail_openids: ['USER_C'],
      });
    }
    if (url.endsWith('/stream_messages')) {
      return jsonResponse({ id: 'STREAM_1', remain_msg_len: 42, ext_info: { ref_idx: 'REFIDX_S' } });
    }
    if (url.includes('/interactions/')) {
      return jsonResponse({});
    }
    if (url.endsWith('/menu')) {
      return jsonResponse({ version: 4 });
    }
    if (url.includes('/panels') && init?.method === 'POST') {
      return jsonResponse({ panel_id: 'p_1' });
    }
    if (url.includes('/panels')) {
      return jsonResponse({ records: [{ panel_id: 'p_1' }] });
    }
    if (url.endsWith('/join_approval_strategy')) {
      return jsonResponse({ strategy_id: 'st_1', is_enable: 'on', expire_at: '2027-01-01T00:00:00+08:00' });
    }
    if (url.includes('/whitelist_users') || url.endsWith('/execute')) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ id: 'ROBOT1.0_OUT', ext_info: { ref_idx: 'REFIDX_OUT' } });
  });
  const rest = new Rest({
    appId: 'app',
    appSecret: 'secret',
    baseUrl: 'https://api.example.test',
    tokenBaseUrl: 'https://api.example.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { rest, calls };
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('Rest rich media', () => {
  it('uploads a URL to the group-scoped files endpoint', async () => {
    const { rest, calls } = makeRest();
    const result = await rest.uploadMedia(
      { scope: 'group', targetId: 'GROUP_A' },
      'https://cdn.example.test/a.png',
      { fileType: 1 },
    );
    expect(result.fileInfo).toBe('FILE_INFO');
    expect(calls[0]?.url).toBe('https://api.example.test/v2/groups/GROUP_A/files');
    expect(bodyOf(calls[0]!)).toMatchObject({
      file_type: 1,
      url: 'https://cdn.example.test/a.png',
      srv_send_msg: false,
    });
  });

  it('uploads base64 payloads to the c2c-scoped files endpoint', async () => {
    const { rest, calls } = makeRest();
    const raw = Buffer.from('hello-media');
    await rest.uploadMedia(
      { scope: 'c2c', targetId: 'USER_A' },
      `base64://${raw.toString('base64')}`,
      { fileType: 1 },
    );
    expect(calls[0]?.url).toBe('https://api.example.test/v2/users/USER_A/files');
    const body = bodyOf(calls[0]!);
    expect(body.file_data).toBe(raw.toString('base64'));
    expect(typeof body.file_name).toBe('string');
  });

  it('rejects local binaries larger than the 5MB direct-upload limit', async () => {
    const { rest } = makeRest();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    await expect(
      rest.uploadMedia({ scope: 'group', targetId: 'GROUP_A' }, oversized, { fileType: 1 }),
    ).rejects.toThrow('5MB');
  });

  it('sends msg_type=7 with media and message_reference', async () => {
    const { rest, calls } = makeRest();
    const result = await rest.sendRichMedia(
      { scope: 'group', targetId: 'GROUP_A' },
      'FILE_INFO',
      '',
      { msgId: 'RAW_IN', msgSeq: 2, refIdx: 'REFIDX_ABC' },
    );
    expect(result.ext_info?.ref_idx).toBe('REFIDX_OUT');
    expect(bodyOf(calls[0]!)).toMatchObject({
      msg_type: 7,
      media: { file_info: 'FILE_INFO' },
      msg_id: 'RAW_IN',
      msg_seq: 2,
      message_reference: { message_id: 'REFIDX_ABC' },
    });
  });

  it('sends text with message_reference', async () => {
    const { rest, calls } = makeRest();
    await rest.sendText(
      { scope: 'c2c', targetId: 'USER_A' },
      '收到',
      { msgId: 'RAW_IN', msgSeq: 1, refIdx: 'REFIDX_ABC' },
    );
    expect(bodyOf(calls[0]!)).toMatchObject({
      content: '收到',
      msg_type: 0,
      message_reference: { message_id: 'REFIDX_ABC' },
    });
  });

  it('parses official group info fields', async () => {
    const { rest } = makeRest();
    await expect(rest.getGroupInfo('GROUP_A')).resolves.toEqual({
      groupOpenid: 'GROUP_A',
      groupName: '读书分享会',
      memberCount: 256,
      fingerMemo: '每周共读',
    });
  });
});

describe('Rest noa/1 endpoints', () => {
  const target = { scope: 'group' as const, targetId: 'GROUP_A' };

  it('sends markdown (msg_type=2) with keyboard and passive parameters', async () => {
    const { rest, calls } = makeRest();
    await rest.sendMarkdown(target, '**你好**', {
      msgId: 'RAW_IN',
      msgSeq: 3,
      keyboard: { id: '1070001' },
    });
    expect(calls[0]?.url).toBe('https://api.example.test/v2/groups/GROUP_A/messages');
    expect(bodyOf(calls[0]!)).toMatchObject({
      msg_type: 2,
      markdown: { content: '**你好**' },
      keyboard: { id: '1070001' },
      msg_id: 'RAW_IN',
      msg_seq: 3,
    });
  });

  it('sends a tuwen card (msg_type=8)', async () => {
    const { rest, calls } = makeRest();
    const card = {
      type: 'tuwen',
      content: { title: '标题', description: '描述', url: 'https://a', pic_url: 'https://b' },
    };
    await rest.sendCard(target, card);
    expect(bodyOf(calls[0]!)).toMatchObject({ msg_type: 8, card });
  });

  it('sends single-chat typing (msg_type=6) and interaction ACKs', async () => {
    const { rest, calls } = makeRest();
    await rest.sendTyping('USER_A', 8, { msgId: 'RAW_IN', msgSeq: 1 });
    expect(calls[0]?.url).toBe('https://api.example.test/v2/users/USER_A/messages');
    expect(bodyOf(calls[0]!)).toMatchObject({
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 8 },
      msg_id: 'RAW_IN',
      msg_seq: 1,
    });

    await rest.ackInteraction('i_1', 0);
    expect(calls[1]?.url).toBe('https://api.example.test/interactions/i_1');
    expect(calls[1]?.init.method).toBe('PUT');
    expect(bodyOf(calls[1]!)).toEqual({ code: 0 });
  });

  it('sends stream frames with stream_msg_id and maps remain_msg_len', async () => {
    const { rest, calls } = makeRest();
    const result = await rest.sendStreamFrame('USER_A', {
      streamMsgId: 'S1',
      index: 1,
      inputState: 1,
      contentType: 'markdown',
      inputMode: 'replace',
      content: '正文',
      msgId: 'RAW_IN',
      msgSeq: 2,
    });
    expect(calls[0]?.url).toBe('https://api.example.test/v2/users/USER_A/stream_messages');
    expect(bodyOf(calls[0]!)).toMatchObject({
      stream_msg_id: 'S1',
      index: 1,
      input_state: 1,
      content_type: 'markdown',
      input_mode: 'replace',
      content_raw: '正文',
      msg_id: 'RAW_IN',
      msg_seq: 2,
    });
    expect(result).toEqual({ streamMsgId: 'STREAM_1', remainMsgLen: 42, refIdx: 'REFIDX_S' });
  });

  it('sets menu and creates/lists panels', async () => {
    const { rest, calls } = makeRest();
    await expect(rest.setMenu({ items: [] })).resolves.toEqual({ version: 4 });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(bodyOf(calls[0]!)).toEqual({ menu: { items: [] } });

    await expect(rest.createPanel({ scope: 'group' })).resolves.toEqual({ panel_id: 'p_1' });
    expect(calls[1]?.init.method).toBe('POST');
    await expect(rest.listPanels('group', 'CUR', 20)).resolves.toEqual({ records: [{ panel_id: 'p_1' }] });
    expect(calls[2]?.init.method).toBe('GET');
    expect(calls[2]?.url).toContain('/v2/panels?scope=group&cursor=CUR&limit=20');
  });

  it('creates and updates join approval strategies', async () => {
    const { rest, calls } = makeRest();
    await expect(
      rest.createJoinApprovalStrategy({ group_openids: ['GROUP_A'], is_enable: 'on' }),
    ).resolves.toMatchObject({ strategy_id: 'st_1' });
    expect(calls[0]?.init.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ group_openids: ['GROUP_A'], is_enable: 'on' });

    await rest.updateJoinApprovalWhitelist('st_1', 'del', ['1234567']);
    expect(calls[1]?.url).toBe(
      'https://api.example.test/v2/groups/join_approval_strategy/st_1/whitelist_users',
    );
    expect(bodyOf(calls[1]!)).toEqual({ op: 'del', whitelist_users: ['1234567'] });

    await rest.executeJoinApprovalStrategy('st_1');
    expect(calls[2]?.url).toBe(
      'https://api.example.test/v2/groups/join_approval_strategy/st_1/execute',
    );
  });
});

describe('Rest group member endpoints', () => {
  it('lists members with cursor and maps official fields', async () => {
    const { rest, calls } = makeRest();
    const page = await rest.listGroupMembers('GROUP_A', 'C1');
    expect(calls[0]?.url).toBe('https://api.example.test/v2/groups/GROUP_A/members?cursor=C1');
    expect(page.nextCursor).toBe('C2');
    expect(page.members[0]).toMatchObject({
      memberOpenid: 'USER_A',
      username: 'Alice',
      role: 'member',
      joinedAt: '2025-07-01T10:30:00+08:00',
    });
  });

  it('gets a single member and batch-removes with blacklist failures', async () => {
    const { rest, calls } = makeRest();
    await expect(rest.getGroupMember('GROUP_A', 'USER_B')).resolves.toMatchObject({
      memberOpenid: 'USER_B',
      role: 'admin',
    });
    expect(calls[0]?.url).toBe('https://api.example.test/v2/groups/GROUP_A/members/USER_B');

    const result = await rest.batchRemoveGroupMembers('GROUP_A', ['USER_B'], true);
    expect(calls[1]?.url).toBe('https://api.example.test/v2/groups/GROUP_A/batch_remove_members');
    expect(bodyOf(calls[1]!)).toEqual({
      member_openids: ['USER_B'],
      add_to_member_blacklist: true,
    });
    expect(result).toEqual({ result: 'success', failedBlacklistOpenids: ['USER_C'] });
  });
});
