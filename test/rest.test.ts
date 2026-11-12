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
