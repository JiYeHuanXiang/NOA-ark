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
