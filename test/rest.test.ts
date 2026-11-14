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
    if (url.endsWith('/upload_prepare')) {
      return jsonResponse({
        upload_id: 'UP_1',
        block_size: '5242881',
        parts: [
          { index: 0, presigned_url: 'https://cos.example.test/part0', block_size: '5242881' },
        ],
        upload_config: { retry_delay: 1 },
      });
    }
    if (url.includes('/upload_part_finish')) {
      return jsonResponse({});
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
      return jsonResponse({ version: 4, menu: { items: [] } });
    }
    if (url.endsWith('/panels/p_1/target')) {
      return jsonResponse({});
    }
    if (url.endsWith('/panels/p_1')) {
      if (init?.method === 'GET') return jsonResponse({ panel_id: 'p_1', scope: 'group' });
      if (init?.method === 'PUT') return jsonResponse({ version: 2 });
      return jsonResponse({});
    }
    if (url.includes('/panels') && init?.method === 'POST') {
      return jsonResponse({ panel_id: 'p_1' });
    }
    if (url.includes('/panels')) {
      return jsonResponse({ records: [{ panel_id: 'p_1' }] });
    }
    if (url.includes('/join_request_list')) {
      return jsonResponse({
        list: [
          {
            join_request_id: 'jr_1',
            member_openid: 'USER_A',
            username: 'Alice',
            apply_at: '2026-08-05T14:19:09+08:00',
            apply_source: 'self_apply',
            invited_by: '',
            bot: false,
            risk_tips: '',
            verify_info: { method: 'verify_message', verify_message: '放我进去' },
          },
        ],
        next_cursor: 'C2',
      });
    }
    if (url.includes('/approval_join_request/')) {
      return jsonResponse({});
    }
    if (url.includes('/restrict_chat_setting')) {
      if (init?.method === 'GET') {
        return jsonResponse({
          global_rule: { mode: 'none' },
          members: [{ member_openid: 'USER_A', mute_expire_at: '2027-01-01T00:00:00+08:00', username: 'Alice' }],
        });
      }
      return jsonResponse({});
    }
    if (url.includes('/member_blacklist')) {
      if (init?.method === 'GET') {
        return jsonResponse({
          users: [{ member_openid: 'USER_B', username: 'Bob', banned_at: '2026-01-01T00:00:00+08:00', bot: false }],
          next_cursor: '',
        });
      }
      return jsonResponse({ fail_openids: ['USER_C'] });
    }
    if (url.endsWith('/bot_state')) {
      return jsonResponse({
        member_openid: 'USER_A',
        joined_at: '2026-01-01T00:00:00+08:00',
        allow_proactive_msg: true,
        recv_msg_setting: 'all',
        member_role: 'admin',
      });
    }
    if (url.endsWith('/media-images/prepare')) {
      return jsonResponse({
        upload_id: 'UP_IMG',
        presigned_url: 'https://cos.example.test/img',
        expires_in: 3600,
      });
    }
    if (url.endsWith('/media-images/complete')) {
      return jsonResponse({
        image_id: 'img_1',
        url: 'qqbot-media://image/v1/token',
        ttl: 7776000,
        preview_url: 'https://cos.example.test/preview',
      });
    }
    if (url.includes('/media-images/') && url.endsWith('/delete')) {
      return jsonResponse({});
    }
    if (url.endsWith('/media-images') || url.includes('/media-images?')) {
      return jsonResponse({ images: [], next_cursor: '', total: 0 });
    }
    if (url.endsWith('/generate_url_link')) {
      return jsonResponse({ data: { url: 'https://qun.qq.com/x' } });
    }
    if (url.includes('/whitelist_users') || url.endsWith('/execute')) {
      return jsonResponse({ ok: true });
    }
    if (url.includes('/join_approval_strategy/') && init?.method === 'DELETE') {
      return jsonResponse({});
    }
    if (url.includes('/join_approval_strategy')) {
      if (init?.method === 'GET') {
        return jsonResponse({ strategies: [{ strategy_id: 'st_1' }], next_cursor: '' });
      }
      return jsonResponse({ strategy_id: 'st_1', is_enable: 'on', expire_at: '2027-01-01T00:00:00+08:00' });
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

  it('uploads local binaries larger than 5MB via the chunked flow', async () => {
    const { rest, calls } = makeRest();
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
    const result = await rest.uploadMedia(
      { scope: 'group', targetId: 'GROUP_A' },
      oversized,
      { fileType: 1, fileName: 'big.png' },
    );
    expect(result.fileInfo).toBe('FILE_INFO');
    const prepare = calls.find((call) => call.url.endsWith('/upload_prepare'));
    expect(prepare).toBeDefined();
    expect(bodyOf(prepare!)).toMatchObject({
      file_type: 1,
      file_name: 'big.png',
      file_size: String(oversized.length),
    });
    expect(calls.some((call) => call.url === 'https://cos.example.test/part0')).toBe(true);
    expect(calls.some((call) => call.url.includes('/upload_part_finish'))).toBe(true);
    const merge = calls.find((call) => call.url.endsWith('/files'));
    expect(bodyOf(merge!)).toMatchObject({ upload_id: 'UP_1', file_name: 'big.png' });
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
    await rest.sendMarkdown(target, { content: '**你好**' }, {
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
    await expect(rest.setMenu({ items: [] })).resolves.toMatchObject({ version: 4 });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(bodyOf(calls[0]!)).toEqual({ menu: { items: [] } });

    await expect(rest.createPanel({ scope: 'group' })).resolves.toEqual({ panel_id: 'p_1' });
    expect(calls[1]?.init.method).toBe('POST');
    await expect(rest.listPanels('group', 'CUR', 20)).resolves.toEqual({ records: [{ panel_id: 'p_1' }] });
    expect(calls[2]?.init.method).toBe('GET');
    expect(calls[2]?.url).toContain('/v2/panels?scope=group&cursor=CUR&limit=20');
  });

  it('reads the menu and drives panel detail/update/target/delete', async () => {
    const { rest, calls } = makeRest();
    await expect(rest.getMenu()).resolves.toMatchObject({ version: 4 });
    expect(calls[0]?.init.method).toBe('GET');

    await expect(rest.getPanel('p_1')).resolves.toMatchObject({ panel_id: 'p_1' });
    expect(calls[1]?.url).toBe('https://api.example.test/v2/panels/p_1');

    await expect(rest.updatePanel('p_1', { remark: 'x' })).resolves.toEqual({ version: 2 });
    expect(bodyOf(calls[2]!)).toEqual({ panel: { remark: 'x' } });

    await rest.updatePanelTarget('p_1', 'add', { groupOpenids: ['GROUP_A'] });
    expect(calls[3]?.url).toBe('https://api.example.test/v2/panels/p_1/target');
    expect(bodyOf(calls[3]!)).toEqual({ op: 'add', group_openids: ['GROUP_A'] });

    await rest.deletePanel('p_1');
    expect(calls[4]?.init.method).toBe('DELETE');
  });

  it('lists join requests, approves them, and queries group admin state', async () => {
    const { rest, calls } = makeRest();
    const page = await rest.listJoinRequests('GROUP_A', 'C1', 30);
    expect(calls[0]?.url).toContain('/v2/groups/GROUP_A/join_request_list?cursor=C1&limit=30');
    expect(page.nextCursor).toBe('C2');
    expect(page.list[0]).toMatchObject({
      joinRequestId: 'jr_1',
      memberOpenid: 'USER_A',
      username: 'Alice',
    });

    await rest.approveJoinRequest('GROUP_A', 'USER_A', {
      op: 'decline',
      joinRequestId: 'jr_1',
      rejectReason: '满员',
      addToMemberBlacklist: true,
    });
    expect(calls[1]?.url).toBe('https://api.example.test/v2/groups/GROUP_A/approval_join_request/USER_A');
    expect(bodyOf(calls[1]!)).toEqual({
      op: 'decline',
      join_request_id: 'jr_1',
      reject_reason: '满员',
      add_to_member_blacklist: true,
    });

    await expect(rest.getMuteState('GROUP_A')).resolves.toMatchObject({
      globalRule: { mode: 'none' },
      members: [{ memberOpenid: 'USER_A' }],
    });
    await rest.setMemberMutes('GROUP_A', [
      { op: 'add', memberOpenid: 'USER_A', muteExpireAt: '2027-01-01T00:00:00+08:00' },
    ]);
    expect(bodyOf(calls[3]!)).toEqual({
      members: [{ op: 'add', member_openid: 'USER_A', mute_expire_at: '2027-01-01T00:00:00+08:00' }],
    });

    const blacklist = await rest.listMemberBlacklist('GROUP_A');
    expect(blacklist.users[0]).toMatchObject({ memberOpenid: 'USER_B', username: 'Bob' });
    const update = await rest.updateMemberBlacklist('GROUP_A', 'add', ['USER_C']);
    expect(update.failedOpenids).toEqual(['USER_C']);
    expect(bodyOf(calls[5]!)).toEqual({ op: 'add', member_openids: ['USER_C'] });

    await expect(rest.getGroupBotState('GROUP_A')).resolves.toMatchObject({
      recv_msg_setting: 'all',
      member_role: 'admin',
    });
  });

  it('lists and deletes join approval strategies', async () => {
    const { rest, calls } = makeRest();
    const page = await rest.listJoinApprovalStrategies('C1', 10);
    expect(calls[0]?.url).toBe(
      'https://api.example.test/v2/groups/join_approval_strategy?cursor=C1&limit=10',
    );
    expect(page.strategies[0]).toMatchObject({ strategy_id: 'st_1' });

    await rest.deleteJoinApprovalStrategy('st_1');
    expect(calls[1]?.url).toBe('https://api.example.test/v2/groups/join_approval_strategy/st_1');
    expect(calls[1]?.init.method).toBe('DELETE');
  });

  it('uploads, lists and deletes material images, then generates a share link', async () => {
    const { rest, calls } = makeRest();
    const image = await rest.uploadMediaImage('base64://aGVsbG8=', {
      fileName: 'a.png',
      contentType: 'image/png',
    });
    expect(image).toMatchObject({ imageId: 'img_1', url: 'qqbot-media://image/v1/token' });
    expect(calls[0]?.url).toBe('https://api.example.test/v2/media-images/prepare');
    expect(bodyOf(calls[0]!)).toMatchObject({
      file_name: 'a.png',
      content_type: 'image/png',
      file_size: 5,
    });
    expect(calls[1]?.url).toBe('https://cos.example.test/img');
    expect(calls[1]?.init.method).toBe('PUT');
    expect((calls[1]?.init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(calls[2]?.url).toBe('https://api.example.test/v2/media-images/complete');

    await expect(rest.listMediaImages('C1')).resolves.toMatchObject({ total: 0 });
    expect(calls[3]?.url).toBe('https://api.example.test/v2/media-images?cursor=C1');

    await rest.deleteMediaImage('img_1');
    expect(calls[4]?.init.method).toBe('DELETE');

    await expect(rest.generateUrlLink('abc')).resolves.toEqual({ url: 'https://qun.qq.com/x' });
    expect(bodyOf(calls[5]!)).toEqual({ callback_data: 'abc' });
  });

  it('sends markdown template payload and event_id passive replies', async () => {
    const { rest, calls } = makeRest();
    await rest.sendMarkdown(target, {
      custom_template_id: 'tpl_1',
      params: [{ key: 'title', values: ['标题'] }],
    });
    expect(bodyOf(calls[0]!)).toMatchObject({
      msg_type: 2,
      markdown: { custom_template_id: 'tpl_1', params: [{ key: 'title', values: ['标题'] }] },
    });

    await rest.sendText(target, 'hi', { eventId: 'EV_1', msgSeq: 2 });
    expect(bodyOf(calls[1]!)).toMatchObject({ event_id: 'EV_1', msg_seq: 2 });
    expect(bodyOf(calls[1]!).msg_id).toBeUndefined();
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
