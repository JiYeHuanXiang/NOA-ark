import { describe, expect, it } from 'vitest';
import {
  arkDataToText,
  attachmentsToSegments,
  cqToSegments,
  milkyToOnebotSegments,
  msgElementsToSegments,
  needsRichMedia,
  officialPartsToSegments,
  onebotToMilkySegments,
  parseOfficialContent,
  segmentsToCQ,
  segmentsToOfficialParts,
  segmentsToPlainText,
} from '../src/core/segments.js';

describe('parseOfficialContent', () => {
  it('splits <qqbot-at-user> tags into text and at parts', () => {
    const parts = parseOfficialContent('<qqbot-at-user id="OPENID_A"/>hello world');
    expect(parts).toEqual([
      { kind: 'at-user', openid: 'OPENID_A' },
      { kind: 'text', text: 'hello world' },
    ]);
  });

  it('splits 2026 <@member_openid> / <@all> markers', () => {
    expect(parseOfficialContent('<@OPENID_A> 你好 <@all>')).toEqual([
      { kind: 'at-user', openid: 'OPENID_A' },
      { kind: 'text', text: ' 你好 ' },
      { kind: 'at-all' },
    ]);
    expect(parseOfficialContent('<@!OPENID_B>hi')).toEqual([
      { kind: 'at-user', openid: 'OPENID_B' },
      { kind: 'text', text: 'hi' },
    ]);
    expect(parseOfficialContent('<qqbot-at-everyone/>注意')).toEqual([
      { kind: 'at-all' },
      { kind: 'text', text: '注意' },
    ]);
  });

  it('keeps plain text as a single part', () => {
    expect(parseOfficialContent('只是文本')).toEqual([{ kind: 'text', text: '只是文本' }]);
  });

  it('returns [] for empty content', () => {
    expect(parseOfficialContent('')).toEqual([]);
  });
});

describe('officialPartsToSegments', () => {
  it('resolves at openid and appends attachments', () => {
    const segments = officialPartsToSegments(parseOfficialContent('<qqbot-at-user id="U1"/>hi'), {
      attachments: [{ content_type: 'image/png', url: 'https://example.com/a.png', filename: 'a.png' }],
      selfPseudo: 'self-1',
      resolve: (openid) => `pseudo:${openid}`,
    });
    expect(segments).toEqual([
      { type: 'at', data: { qq: 'pseudo:U1' } },
      { type: 'text', data: { text: 'hi' } },
      { type: 'image', data: { file: 'https://example.com/a.png', url: 'https://example.com/a.png', summary: 'a.png' } },
    ]);
  });
});

describe('attachmentsToSegments', () => {
  it('maps image / video / voice and degrades unknown types to text', () => {
    const segments = attachmentsToSegments([
      { contentType: 'image/jpeg', url: 'u1' },
      { contentType: 'video/mp4', url: 'u2' },
      { contentType: 'voice/amr', url: 'u3' },
      { contentType: 'application/octet-stream', filename: 'x.bin' },
    ]);
    expect(segments.map((s) => s.type)).toEqual(['image', 'video', 'record', 'text']);
  });

  it('prefers voice_wav_url over the SILK url', () => {
    const segments = attachmentsToSegments([
      {
        content_type: 'voice',
        url: 'https://example.com/a.silk',
        voice_wav_url: 'https://example.com/a.wav',
        asr_refer_text: '你好',
      },
    ]);
    expect(segments).toEqual([
      { type: 'record', data: { file: 'https://example.com/a.wav', url: 'https://example.com/a.wav', summary: '你好' } },
    ]);
  });
});

describe('msgElementsToSegments / arkDataToText', () => {
  it('flattens element content (chat record / quote / parallel messages)', () => {
    const segments = msgElementsToSegments([
      { message_type: 103, content: '=== 消息 1 ===\n今天的学习计划已完成' },
    ]);
    expect(segments).toEqual([{ type: 'text', data: { text: '=== 消息 1 ===\n今天的学习计划已完成' } }]);
  });

  it('recurses into nested elements', () => {
    const segments = msgElementsToSegments([
      { message_type: 102, content: '', msg_elements: [{ content: '嵌套正文' }] },
    ]);
    expect(segments).toEqual([{ type: 'text', data: { text: '嵌套正文' } }]);
  });

  it('degrades ark cards to readable text', () => {
    expect(arkDataToText({ ark_name: '图文 H5', fields: { title: '今日新闻' } })).toBe('[卡片:今日新闻]');
    expect(arkDataToText({ prompt: '查看详情' })).toBe('[卡片:查看详情]');
    expect(arkDataToText({})).toBe('[卡片消息]');
    const segments = msgElementsToSegments([
      { message_type: 3, ark_data: { ark_name: '小程序', fields: { title: '小程序标题' } } },
    ]);
    expect(segments).toEqual([{ type: 'text', data: { text: '[卡片:小程序标题]' } }]);
  });
});

describe('CQ codec', () => {
  it('round-trips text with CQ special characters', () => {
    const original = '[CQ:face,id=1]a,b&c]';
    const segments = [{ type: 'text', data: { text: original } }];
    const cq = segmentsToCQ(segments);
    expect(cq).not.toContain('[CQ:face');
    expect(cqToSegments(cq)).toEqual(segments);
  });

  it('serializes at / reply / image segments and parses them back', () => {
    const segments = [
      { type: 'at', data: { qq: '123456' } },
      { type: 'reply', data: { id: '789' } },
      { type: 'image', data: { file: 'https://example.com/x.png' } },
    ] as const;
    const cq = segmentsToCQ([...segments]);
    expect(cq).toBe('[CQ:at,qq=123456][CQ:reply,id=789][CQ:image,file=https://example.com/x.png]');
    const parsed = cqToSegments(cq);
    expect(parsed).toEqual([...segments]);
  });

  it('keeps unknown CQ types as raw segments', () => {
    const parsed = cqToSegments('[CQ:markdown,data=hello]');
    expect(parsed[0]).toMatchObject({ type: 'markdown', data: { data: 'hello' } });
  });
});

describe('plain text and rich media detection', () => {
  it('renders v11 segments as readable text', () => {
    const text = segmentsToPlainText([
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: '注意' } },
      { type: 'image', data: { file: 'x' } },
    ]);
    expect(text).toBe('@全体成员注意[图片]');
  });

  it('detects rich media', () => {
    expect(needsRichMedia([{ type: 'text', data: { text: 'x' } }])).toBe(false);
    expect(needsRichMedia([{ type: 'image', data: { file: 'x' } }])).toBe(true);
  });
});

describe('cross-protocol segment conversion', () => {
  it('converts OneBot at/image to Milky mention/image', () => {
    const result = onebotToMilkySegments([
      { type: 'at', data: { qq: '10000000000001' } },
      { type: 'image', data: { file: 'https://example.com/a.png' } },
    ]);
    expect(result).toEqual({
      ok: true,
      segments: [
        { type: 'mention', data: { user_id: 10000000000001 } },
        { type: 'image', data: { uri: 'https://example.com/a.png' } },
      ],
    });
  });

  it('converts Milky mention to OneBot at', () => {
    const result = milkyToOnebotSegments([{ type: 'mention', data: { user_id: 42 } }]);
    expect(result).toEqual({ ok: true, segments: [{ type: 'at', data: { qq: '42' } }] });
  });

  it('rejects unsupported Milky segments explicitly', () => {
    const result = milkyToOnebotSegments([{ type: 'file', data: { file_name: 'x' } }]);
    expect(result.ok).toBe(false);
  });
});

describe('segmentsToOfficialParts · noa/1', () => {
  const noa = { markdown: true, keyboard: true, card: true };
  const keyboard = {
    content: {
      rows: [
        {
          buttons: [
            {
              id: 'btn_signin',
              render_data: { label: '签到', style: 1 },
              action: { type: 2, permission: { type: 2 }, data: '/签到', enter: true },
            },
          ],
        },
      ],
    },
  };

  it('keeps A-class text and media in segment order', () => {
    const result = segmentsToOfficialParts([
      { type: 'text', data: { text: '前' } },
      { type: 'image', data: { file: 'https://example.com/a.png' } },
      { type: 'text', data: { text: '后' } },
    ], { scope: 'group' });
    expect(result).toEqual({
      ok: true,
      replyId: '',
      parts: [
        { kind: 'text', text: '前' },
        { kind: 'media', mediaType: 'image', file: 'https://example.com/a.png' },
        { kind: 'text', text: '后' },
      ],
    });
  });

  it('converts markdown + keyboard into one msg_type=2 part', () => {
    const result = segmentsToOfficialParts(
      [
        { type: 'noa_markdown', data: { content: '**你好**' } },
        { type: 'noa_keyboard', data: keyboard as never },
      ],
      { scope: 'group', noa },
    );
    expect(result).toEqual({
      ok: true,
      replyId: '',
      parts: [{ kind: 'markdown', content: '**你好**', keyboard }],
    });
  });

  it('appends at(qq=user) as a markdown tag only in markdown mode', () => {
    const result = segmentsToOfficialParts(
      [
        { type: 'noa_markdown', data: { content: '你好' } },
        { type: 'at', data: { qq: '123456' } },
      ],
      {
        scope: 'group',
        noa,
        resolveAt: (qq) => (qq === '123456' ? 'OPENID_U' : null),
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parts[0]).toMatchObject({
        kind: 'markdown',
        content: '你好\n<qqbot-at-user id="OPENID_U" />',
      });
    }
  });

  it('rejects keyboard alone, keyboard with media, and markdown mixed with text/media', () => {
    const alone = segmentsToOfficialParts([{ type: 'noa_keyboard', data: keyboard as never }], { scope: 'group', noa });
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.reason).toContain('同现');

    const withMedia = segmentsToOfficialParts([
      { type: 'text', data: { text: 'x' } },
      { type: 'noa_keyboard', data: keyboard as never },
      { type: 'image', data: { file: 'u' } },
    ], { scope: 'group', noa });
    expect(withMedia.ok).toBe(false);

    const mixed = segmentsToOfficialParts([
      { type: 'noa_markdown', data: { content: 'x' } },
      { type: 'text', data: { text: 'y' } },
    ], { scope: 'group', noa });
    expect(mixed.ok).toBe(false);
  });

  it('validates keyboard and card fields before calling the platform', () => {
    const badLabel = segmentsToOfficialParts(
      [
        { type: 'noa_markdown', data: { content: 'x' } },
        { type: 'noa_keyboard', data: { content: { rows: [{ buttons: [{ render_data: { label: '12345678901' } }] }] } } },
      ],
      { scope: 'group', noa },
    );
    expect(badLabel.ok).toBe(false);
    if (!badLabel.ok) expect(badLabel.reason).toContain('label');

    const badCard = segmentsToOfficialParts(
      [{ type: 'noa_card', data: { type: 'tuwen', content: { title: 'x', description: 'y', url: 'http://x', pic_url: 'https://x' } } }],
      { scope: 'group', noa },
    );
    expect(badCard.ok).toBe(false);
    if (!badCard.ok) expect(badCard.reason).toContain('https');
  });

  it('sends a card alone and rejects mixing it', () => {
    const card = {
      type: 'tuwen',
      content: { title: '标题', description: '描述', url: 'https://example.com/a', pic_url: 'https://example.com/b.png' },
    };
    const alone = segmentsToOfficialParts([{ type: 'noa_card', data: card }], { scope: 'group', noa });
    expect(alone).toEqual({ ok: true, replyId: '', parts: [{ kind: 'card', card }] });

    const mixed = segmentsToOfficialParts(
      [{ type: 'text', data: { text: 'x' } }, { type: 'noa_card', data: card }],
      { scope: 'group', noa },
    );
    expect(mixed.ok).toBe(false);
  });

  it('fails noa segments when the extension is disabled and returns 1404 for ark/embed', () => {
    const disabled = segmentsToOfficialParts([{ type: 'noa_card', data: { type: 'tuwen', content: {} } }], { scope: 'group' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.reason).toContain('文档');

    const ark = segmentsToOfficialParts([{ type: 'noa_ark', data: { json: {} } }], { scope: 'group', noa });
    expect(ark.ok).toBe(false);
    if (!ark.ok) {
      expect(ark.retcode).toBe(1404);
      expect(ark.reason).toContain('noa_card');
    }
  });
});

describe('segmentsToOfficialParts', () => {
  it('splits text and media into ordered parts, maps group @all, and extracts reply ids', () => {
    const result = segmentsToOfficialParts(
      [
        { type: 'reply', data: { id: 'MSG_1' } },
        { type: 'text', data: { text: '看' } },
        { type: 'at', data: { qq: 'all' } },
        { type: 'image', data: { file: 'https://example.com/a.png' } },
        { type: 'record', data: { file: 'https://example.com/a.silk' } },
      ],
      { scope: 'group' },
    );
    expect(result).toEqual({
      ok: true,
      replyId: 'MSG_1',
      parts: [
        { kind: 'text', text: '看<qqbot-at-everyone />' },
        { kind: 'media', mediaType: 'image', file: 'https://example.com/a.png' },
        { kind: 'media', mediaType: 'record', file: 'https://example.com/a.silk' },
      ],
    });
  });

  it('rejects c2c @, group @user, face, unknown and noa segments explicitly', () => {
    const c2cAll = segmentsToOfficialParts([{ type: 'at', data: { qq: 'all' } }], { scope: 'c2c' });
    expect(c2cAll.ok).toBe(false);
    if (!c2cAll.ok) expect(c2cAll.reason).toContain('单聊不支持');

    const atUser = segmentsToOfficialParts([{ type: 'at', data: { qq: '123' } }], { scope: 'group' });
    expect(atUser.ok).toBe(false);
    if (!atUser.ok) expect(atUser.reason).toContain('markdown');

    const face = segmentsToOfficialParts([{ type: 'face', data: { id: '1' } }], { scope: 'group' });
    expect(face.ok).toBe(false);
    if (!face.ok) expect(face.reason).toContain('表情');

    const unknown = segmentsToOfficialParts([{ type: 'json', data: { data: '{}' } }], { scope: 'group' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain('json');

    const noa = segmentsToOfficialParts([{ type: 'noa_markdown', data: { content: 'x' } }], { scope: 'group' });
    expect(noa.ok).toBe(false);
    if (!noa.ok) expect(noa.reason).toContain('文档');
  });
});
