/**
 * 官方 qqbot v2 内容/附件 ↔ OneBot v11 / Milky v1.3 消息段的双向转换。
 *
 * 入站：官方 content（含 `<qqbot-at-user id="..."/>`）+ attachments → 段数组/CQ 串。
 * 出站：OneBot v11 段数组（或 CQ 串）/ Milky 段 → 官方文本与富媒体上传请求。
 *
 * 能力边界（文档 §3.4 / §4.4 / §5）：
 *   - 官方无原生 json/xml/markdown 接收，无合并转发（node/forward）；
 *   - noa_markdown / noa_keyboard / noa_ark / noa_embed 是 noa 私有扩展段，
 *     仅在 OneBot 侧 opt-in 使用，不参与跨协议转换；
 *   - 未知段类型在 CQ 层面原样保留为 `{type, data}`，跨协议转换则明确失败。
 */

/** 官方 v2 消息附件；兼容 snake_case 与 camelCase 字段。 */
export interface OfficialAttachment {
  content_type?: string;
  contentType?: string;
  filename?: string;
  url?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  /** 语音消息转换后的 WAV 地址（SILK 不可直接播放时优先使用）。 */
  voice_wav_url?: string;
  /** 语音消息 ASR 参考文本。 */
  asr_refer_text?: string;
}

/** 官方结构化卡片（ark_data）字段。 */
export interface OfficialArkData {
  prompt?: string;
  ark_type?: string;
  ark_name?: string;
  fields?: Record<string, unknown>;
}

/** 官方消息元素（msg_elements）；可递归嵌套。 */
export interface OfficialMsgElement {
  msg_idx?: string;
  message_type?: number;
  content?: string;
  attachments?: OfficialAttachment[];
  ark_data?: OfficialArkData;
  msg_elements?: OfficialMsgElement[];
  author?: Record<string, unknown>;
}

export interface ParsedOfficialTextPart {
  kind: 'text';
  text: string;
}

export interface ParsedOfficialAtPart {
  kind: 'at-user';
  openid: string;
}

export interface ParsedOfficialAtAllPart {
  kind: 'at-all';
}

export type ParsedOfficialPart = ParsedOfficialTextPart | ParsedOfficialAtPart | ParsedOfficialAtAllPart;

export interface OneBotTextSegment {
  type: 'text';
  data: { text: string };
}

export interface OneBotFaceSegment {
  type: 'face';
  data: { id: string };
}

export interface OneBotAtSegment {
  type: 'at';
  data: { qq: string };
}

export interface OneBotReplySegment {
  type: 'reply';
  data: { id: string };
}

export interface OneBotMediaData {
  file: string;
  url?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface OneBotImageSegment {
  type: 'image';
  data: OneBotMediaData;
}

export interface OneBotRecordSegment {
  type: 'record';
  data: OneBotMediaData;
}

export interface OneBotVideoSegment {
  type: 'video';
  data: OneBotMediaData;
}

/** 非标准 @全体；部分 OneBot 实现用 at(qq=all) 表示。 */
export interface OneBotMentionAllSegment {
  type: 'mention_all';
  data: Record<string, never>;
}

/** noa 扩展：官方 msg_type=2 markdown（opt-in）。 */
export interface OneBotNoaMarkdownSegment {
  type: 'noa_markdown';
  data: { content: string };
}

/** noa 扩展：官方 keyboard 按钮模板（opt-in）。 */
export interface OneBotNoaKeyboardSegment {
  type: 'noa_keyboard';
  data: { rows: string[][] };
}

/** noa 扩展：官方 msg_type=3 ark 卡片（opt-in）。 */
export interface OneBotNoaArkSegment {
  type: 'noa_ark';
  data: { json: unknown };
}

/** noa 扩展：官方 msg_type=4 embed 卡片（opt-in）。 */
export interface OneBotNoaEmbedSegment {
  type: 'noa_embed';
  data: { embed: unknown };
}

/** OneBot v11 已知段 + noa 扩展段（判别联合）。 */
export type OneBotSegment =
  | OneBotTextSegment
  | OneBotFaceSegment
  | OneBotAtSegment
  | OneBotReplySegment
  | OneBotImageSegment
  | OneBotRecordSegment
  | OneBotVideoSegment
  | OneBotMentionAllSegment
  | OneBotNoaMarkdownSegment
  | OneBotNoaKeyboardSegment
  | OneBotNoaArkSegment
  | OneBotNoaEmbedSegment;

/** CQ 解析中遇到的未知/第三方段：保留原始 type 与字符串化 data。 */
export interface RawSegment {
  type: string;
  data: Record<string, unknown>;
}

/** 已知段或未知段。 */
export type AnyOneBotSegment = OneBotSegment | RawSegment;
export type AnyMilkySegment = MilkySegment | RawSegment;

export interface MilkyTextSegment {
  type: 'text';
  data: { text: string };
}

export interface MilkyMentionSegment {
  type: 'mention';
  data: { user_id: number | string };
}

export interface MilkyMentionAllSegment {
  type: 'mention_all';
  data: Record<string, never>;
}

export interface MilkyFaceSegment {
  type: 'face';
  data: { face_id: number | string };
}

export interface MilkyReplySegment {
  type: 'reply';
  data: { message_seq: number | string };
}

export interface MilkyMediaData {
  /** OneBot 侧 file 的对应字段。 */
  uri?: string;
  resource_id?: string;
  temp_url?: string;
  summary?: string;
  sub_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  [key: string]: unknown;
}

export interface MilkyImageSegment {
  type: 'image';
  data: MilkyMediaData;
}

export interface MilkyRecordSegment {
  type: 'record';
  data: MilkyMediaData;
}

export interface MilkyVideoSegment {
  type: 'video';
  data: MilkyMediaData;
}

/** Milky 侧存在、但官方平台无法承载的段（file/forward/xml/...）。 */
export interface MilkyOpaqueSegment {
  type: 'file' | 'forward' | 'market_face' | 'light_app' | 'xml' | 'markdown';
  data: Record<string, unknown>;
}

/** Milky v1.3 段联合。 */
export type MilkySegment =
  | MilkyTextSegment
  | MilkyMentionSegment
  | MilkyMentionAllSegment
  | MilkyFaceSegment
  | MilkyReplySegment
  | MilkyImageSegment
  | MilkyRecordSegment
  | MilkyVideoSegment
  | MilkyOpaqueSegment;

/** 跨协议转换结果；失败时 reason 为可直接回给客户端的中文说明。 */
export type SegmentConversion<T> =
  | { ok: true; segments: T[] }
  | { ok: false; reason: string };

export interface OfficialToSegmentsOptions {
  /** 事件 attachments；没有则传空数组/省略。 */
  attachments?: readonly OfficialAttachment[];
  /** 无法反查 openid 时用于机器人自身的伪 self_id 兜底。 */
  selfPseudo?: string;
  /** openid → 暴露给协议的 ID（通常是 IdMapper.expose）。 */
  resolve: (openid: string) => string;
}

const AT_TAG =
  /<qqbot-at-user\s+id="([^"]*)"\s*\/?>|<qqbot-at-everyone\s*\/?>|<@!?([^<>\s]+)>/g;
const RICH_MEDIA_TYPES = new Set(['image', 'record', 'video']);

/** 元素递归深度上限，防御异常嵌套导致栈溢出。 */
const MAX_ELEMENT_DEPTH = 4;

/**
 * 把官方 content 拆成文本/@ 序列。
 *
 * 兼容两种 @ 标记：
 *   - 旧式 `<qqbot-at-user id="OPENID"/>` / `<qqbot-at-everyone/>`；
 *   - 2026 文档新式 `<@member_openid>` / `<@all>`（`<@!openid>` 也接受）。
 * 相邻标签不会产生空文本段。
 */
export function parseOfficialContent(content: string): ParsedOfficialPart[] {
  const input = String(content ?? '');
  if (input === '') return [];

  const parts: ParsedOfficialPart[] = [];
  let cursor = 0;
  for (const match of input.matchAll(AT_TAG)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: 'text', text: input.slice(cursor, index) });
    const legacyOpenid = match[1];
    const newOpenid = match[2];
    if (legacyOpenid !== undefined) {
      parts.push({ kind: 'at-user', openid: legacyOpenid });
    } else if (newOpenid !== undefined) {
      parts.push(newOpenid === 'all' ? { kind: 'at-all' } : { kind: 'at-user', openid: newOpenid });
    } else {
      // <qqbot-at-everyone/>
      parts.push({ kind: 'at-all' });
    }
    cursor = index + match[0].length;
  }
  if (cursor < input.length) parts.push({ kind: 'text', text: input.slice(cursor) });
  return parts;
}

/**
 * 官方 attachments → OneBot 富媒体段。
 *
 * image* → image，video* → video，audio 或 voice → record；
 * 其余类型降级为 `[附件:文件名]` 文本。
 */
export function attachmentsToSegments(
  attachments: readonly OfficialAttachment[] = [],
): OneBotSegment[] {
  const segments: OneBotSegment[] = [];
  for (const attachment of attachments) {
    const contentType = (attachment.content_type ?? attachment.contentType ?? '').toLowerCase();
    const url = attachment.voice_wav_url ?? attachment.url ?? '';
    const name = attachment.filename ?? '';

    if (contentType.startsWith('image')) {
      segments.push({ type: 'image', data: { file: url, url, summary: name } });
    } else if (contentType.startsWith('video')) {
      segments.push({ type: 'video', data: { file: url, url, summary: name } });
    } else if (contentType.startsWith('audio') || contentType.startsWith('voice')) {
      const summary = attachment.asr_refer_text ?? name;
      segments.push({ type: 'record', data: { file: url, url, summary } });
    } else {
      const label = name === '' ? contentType === '' ? '未知' : contentType : name;
      segments.push({ type: 'text', data: { text: `[附件:${label}]` } });
    }
  }
  return segments;
}

/**
 * 官方结构化卡片 → 可读文本降级。
 *
 * 优先 fields.title / desc / nickname / address，其次 ark_name / prompt；
 * 没有任何可读信息时输出 `[卡片消息]`。
 */
export function arkDataToText(ark: OfficialArkData | undefined): string {
  if (ark === undefined) return '';
  const fields = isRecord(ark.fields) ? ark.fields : {};
  const label =
    readString(fields, 'title') ||
    readString(fields, 'desc') ||
    readString(fields, 'nickname') ||
    readString(fields, 'address') ||
    readString(ark, 'ark_name') ||
    readString(ark, 'prompt');
  return label === '' ? '[卡片消息]' : `[卡片:${label}]`;
}

/**
 * 官方 msg_elements → OneBot 段。
 *
 * message_type 101/102/103（并行消息/聊天记录/引用消息）在官方事件里
 * 没有独立正文，实际内容在元素的 content / 嵌套 msg_elements 中；
 * message_type=3 的结构化卡片用 ark_data 降级为 `[卡片:标题]`。
 * 递归处理嵌套元素，深度上限 4。
 */
export function msgElementsToSegments(
  elements: readonly unknown[] = [],
  depth = 0,
): OneBotSegment[] {
  if (depth > MAX_ELEMENT_DEPTH) return [];
  const segments: OneBotSegment[] = [];

  for (const element of elements) {
    if (!isRecord(element)) continue;
    const content = readString(element, 'content');
    const attachments = Array.isArray(element.attachments)
      ? (element.attachments as OfficialAttachment[])
      : [];
    const ark = isRecord(element.ark_data) ? (element.ark_data as OfficialArkData) : undefined;

    if (content.trim() !== '') appendText(segments, content);
    else if (ark !== undefined) appendText(segments, arkDataToText(ark));
    segments.push(...attachmentsToSegments(attachments));

    const nested = Array.isArray(element.msg_elements) ? element.msg_elements : [];
    if (nested.length > 0) segments.push(...msgElementsToSegments(nested, depth + 1));
  }

  return segments;
}

/**
 * 官方 parts + attachments → OneBot 段数组。
 *
 * 相邻 text 合并；at-user 通过 resolve 转成伪号；附件追加在正文之后。
 */
export function officialPartsToSegments(
  parts: readonly ParsedOfficialPart[],
  options: OfficialToSegmentsOptions,
): OneBotSegment[] {
  const segments: OneBotSegment[] = [];

  for (const part of parts) {
    if (part.kind === 'text') {
      appendText(segments, part.text);
      continue;
    }
    if (part.kind === 'at-all') {
      segments.push({ type: 'at', data: { qq: 'all' } });
      continue;
    }
    const resolved = part.openid === '' ? '' : options.resolve(part.openid);
    const qq = resolved === '' ? (options.selfPseudo ?? part.openid) : resolved;
    segments.push({ type: 'at', data: { qq } });
  }

  segments.push(...attachmentsToSegments(options.attachments));
  return segments;
}

/**
 * OneBot 段数组 → CQ 串。
 *
 * text 段按 CQ 约定输出为转义后的裸文本，其余段输出 `[CQ:type,key=value]`；
 * 未知段原样序列化，保证 `cqToSegments` 可往返。
 */
export function segmentsToCQ(segments: readonly AnyOneBotSegment[]): string {
  let cq = '';
  for (const segment of segments) {
    if (segment.type === 'text') {
      cq += escapeCq(readString(segment.data, 'text'));
      continue;
    }

    const params: string[] = [];
    for (const [key, value] of Object.entries(dataOf(segment))) {
      if (value === undefined || value === null) continue;
      params.push(`${key}=${escapeCq(stringifyParam(value))}`);
    }
    cq += `[CQ:${segment.type}${params.length > 0 ? `,${params.join(',')}` : ''}]`;
  }
  return cq;
}

/**
 * CQ 串 → OneBot 段数组。
 *
 * 未知类型保留 `{type, data}`；`[CQ:text,text=...]` 也归并为 text 段。
 */
export function cqToSegments(cq: string): AnyOneBotSegment[] {
  const input = String(cq ?? '');
  const segments: AnyOneBotSegment[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf('[CQ:', cursor);
    if (open === -1) {
      appendText(segments, unescapeCq(input.slice(cursor)));
      break;
    }
    if (open > cursor) appendText(segments, unescapeCq(input.slice(cursor, open)));

    const close = input.indexOf(']', open + 4);
    if (close === -1) {
      // 没有闭合方括号：按普通文本处理，避免吞掉后半条消息。
      appendText(segments, unescapeCq(input.slice(open)));
      break;
    }

    const body = input.slice(open + 4, close);
    const comma = body.indexOf(',');
    const type = (comma === -1 ? body : body.slice(0, comma)).trim();
    if (type === '') {
      appendText(segments, unescapeCq(input.slice(open, close + 1)));
      cursor = close + 1;
      continue;
    }

    const data: Record<string, string> = {};
    if (comma !== -1) {
      for (const pair of body.slice(comma + 1).split(',')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq).trim();
        if (key === '') continue;
        data[key] = unescapeCq(pair.slice(eq + 1));
      }
    }

    if (type === 'text') appendText(segments, data.text ?? '');
    else segments.push({ type, data });

    cursor = close + 1;
  }

  return segments;
}

/**
 * 段数组 → 纯文本降级。
 *
 * at → `@qq` / `@全体成员`，face → `[表情id]`，
 * image/record/video → `[图片]/[语音]/[视频]`，reply → 空。
 */
export function segmentsToPlainText(segments: readonly AnyOneBotSegment[]): string {
  let text = '';
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        text += readString(segment.data, 'text');
        break;
      case 'at': {
        const qq = readString(segment.data, 'qq');
        text += qq === 'all' || qq === 'everyone' ? '@全体成员' : `@${qq}`;
        break;
      }
      case 'face':
        text += `[表情${readString(segment.data, 'id')}]`;
        break;
      case 'image':
        text += '[图片]';
        break;
      case 'record':
        text += '[语音]';
        break;
      case 'video':
        text += '[视频]';
        break;
      case 'reply':
        break;
      case 'noa_markdown':
        text += readString(segment.data, 'content');
        break;
      default:
        break;
    }
  }
  return text;
}

/** 是否含有需要上传/走 msg_type=7 的富媒体段。 */
export function needsRichMedia(segments: readonly AnyOneBotSegment[]): boolean {
  return segments.some((segment) => RICH_MEDIA_TYPES.has(segment.type));
}

/** 出站消息的一个有序分片；官方一条消息只能承载一种内容，故按段拆成多条发送。 */
export type OutboundPart =
  | { kind: 'text'; text: string }
  | { kind: 'media'; mediaType: 'image' | 'record' | 'video'; file: string };

export interface OfficialOutboundOptions {
  /** 消息场景；群聊与单聊的 @ 能力不同。 */
  scope: 'group' | 'c2c';
}

export type OfficialOutboundResult =
  | { ok: true; parts: OutboundPart[]; replyId: string }
  | { ok: false; reason: string };

const MEDIA_TYPE_BY_SEGMENT: Record<string, 'image' | 'record' | 'video'> = {
  image: 'image',
  record: 'record',
  video: 'video',
};

/**
 * OneBot 段数组 → 官方出站分片（文本 / 单条富媒体）。
 *
 * - text 合并为文本分片；群聊 `at(qq=all)` → `<qqbot-at-everyone />`（管理员、每群每天 1 次）；
 * - 群聊 @具体成员官方只支持 markdown 消息，标准文本通道无法真 @ → 明确失败（等 noa_markdown）；
 * - reply 只提取引用目标（replyId），由调用方解析 REFIDX；
 * - image/record/video 各成一个 media 分片（官方 msg_type=7 单条只带一个 file_info）；
 * - face 在群聊/单聊无官方能力，明确失败；
 * - noa_* 扩展段尚未启用（规划见 文档），同样明确失败。
 */
export function segmentsToOfficialParts(
  segments: readonly AnyOneBotSegment[],
  options: OfficialOutboundOptions,
): OfficialOutboundResult {
  const parts: OutboundPart[] = [];
  let replyId = '';

  const pushText = (text: string): void => {
    if (text === '') return;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.kind === 'text') {
      last.text += text;
      return;
    }
    parts.push({ kind: 'text', text });
  };

  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        pushText(readString(segment.data, 'text'));
        break;
      case 'at': {
        const qq = readString(segment.data, 'qq');
        if (qq === '') {
          return { ok: false, reason: 'at 段缺少 qq 目标' };
        }
        if (qq === 'all' || qq === 'everyone') {
          if (options.scope !== 'group') {
            return { ok: false, reason: '官方单聊不支持 @ 能力（@全体成员仅在群聊可用）' };
          }
          pushText('<qqbot-at-everyone />');
          break;
        }
        return {
          ok: false,
          reason: '官方群聊的 @用户 仅支持 markdown 消息（noa_markdown 尚未实现）；单聊不支持 @。请先发纯文本，或等待 文档 B1',
        };
      }
      case 'reply': {
        const id = readString(segment.data, 'id');
        if (replyId === '' && id !== '') replyId = id;
        break;
      }
      case 'mention_all':
        if (options.scope !== 'group') {
          return { ok: false, reason: '官方单聊不支持 @ 能力（@全体成员仅在群聊可用）' };
        }
        pushText('<qqbot-at-everyone />');
        break;
      case 'face':
        return { ok: false, reason: '官方群聊/单聊不支持发送系统表情（<emoji:id> 仅文字子频道可用）' };
      case 'image':
      case 'record':
      case 'video': {
        const file = oneBotMediaUri(segment.data);
        if (file === '') {
          return { ok: false, reason: `消息段「${segment.type}」缺少 file/url` };
        }
        parts.push({ kind: 'media', mediaType: MEDIA_TYPE_BY_SEGMENT[segment.type]!, file });
        break;
      }
      case 'noa_markdown':
      case 'noa_keyboard':
      case 'noa_ark':
      case 'noa_embed':
        return { ok: false, reason: `noa 扩展消息段「${segment.type}」尚未启用（规范见 文档）` };
      default:
        return { ok: false, reason: `消息段「${segment.type}」无法经 QQ 官方平台发送（无对应能力）` };
    }
  }

  return { ok: true, parts, replyId };
}

/**
 * OneBot v11 段 → Milky v1.3 段。
 *
 * 支持 text / at / mention_all / face / reply / image / record / video；
 * 其余（xml/json/markdown/node/forward、noa 扩展等）明确失败。
 */
export function onebotToMilkySegments(
  segments: readonly AnyOneBotSegment[],
): SegmentConversion<MilkySegment> {
  const converted: MilkySegment[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        converted.push({ type: 'text', data: { text: readString(segment.data, 'text') } });
        break;
      case 'mention_all':
        converted.push({ type: 'mention_all', data: {} });
        break;
      case 'at': {
        const qq = readString(segment.data, 'qq');
        if (qq === 'all' || qq === 'everyone') {
          converted.push({ type: 'mention_all', data: {} });
        } else {
          converted.push({ type: 'mention', data: { user_id: toMilkyId(qq) } });
        }
        break;
      }
      case 'face':
        converted.push({ type: 'face', data: { face_id: toMilkyId(readString(segment.data, 'id')) } });
        break;
      case 'reply':
        converted.push({
          type: 'reply',
          data: { message_seq: toMilkyId(readString(segment.data, 'id')) },
        });
        break;
      case 'image':
        converted.push({ type: 'image', data: { uri: oneBotMediaUri(segment.data) } });
        break;
      case 'record':
        converted.push({ type: 'record', data: { uri: oneBotMediaUri(segment.data) } });
        break;
      case 'video':
        converted.push({ type: 'video', data: { uri: oneBotMediaUri(segment.data) } });
        break;
      default:
        return { ok: false, reason: unsupportedReason('OneBot', segment.type, 'Milky') };
    }
  }

  return { ok: true, segments: converted };
}

/**
 * Milky v1.3 段 → OneBot v11 段。
 *
 * mention_all 转为 v11 惯例的 at(qq=all)；file/forward/xml/markdown 等
 * 官方承载不了的段明确失败。
 */
export function milkyToOnebotSegments(
  segments: readonly AnyMilkySegment[],
): SegmentConversion<OneBotSegment> {
  const converted: OneBotSegment[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        converted.push({ type: 'text', data: { text: readString(segment.data, 'text') } });
        break;
      case 'mention':
        converted.push({ type: 'at', data: { qq: idToString(dataOf(segment).user_id) } });
        break;
      case 'mention_all':
        converted.push({ type: 'at', data: { qq: 'all' } });
        break;
      case 'face':
        converted.push({ type: 'face', data: { id: idToString(dataOf(segment).face_id) } });
        break;
      case 'reply':
        converted.push({ type: 'reply', data: { id: idToString(dataOf(segment).message_seq) } });
        break;
      case 'image':
        converted.push({ type: 'image', data: { file: milkyMediaUri(segment.data) } });
        break;
      case 'record':
        converted.push({ type: 'record', data: { file: milkyMediaUri(segment.data) } });
        break;
      case 'video':
        converted.push({ type: 'video', data: { file: milkyMediaUri(segment.data) } });
        break;
      default:
        return { ok: false, reason: unsupportedReason('Milky', segment.type, 'OneBot') };
    }
  }

  return { ok: true, segments: converted };
}

function appendText(segments: AnyOneBotSegment[], text: string): void {
  if (text === '') return;
  const last = segments[segments.length - 1];
  if (last !== undefined && last.type === 'text') {
    const data = dataOf(last);
    if (typeof data.text === 'string') {
      data.text += text;
      return;
    }
  }
  segments.push({ type: 'text', data: { text } });
}

function escapeCq(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

function unescapeCq(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function stringifyParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function oneBotMediaUri(data: unknown): string {
  return readString(data, 'file') || readString(data, 'url');
}

function milkyMediaUri(data: unknown): string {
  return readString(data, 'uri') || readString(data, 'temp_url') || readString(data, 'resource_id');
}

function toMilkyId(value: string): number | string {
  if (value === '') return '';
  if (!/^-?\d+$/.test(value)) return value;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function idToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function unsupportedReason(from: string, type: string, to: string): string {
  return `${from} 段「${type}」无法映射为 ${to} 段：QQ 官方平台无对应能力`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(segment: { data: unknown }): Record<string, unknown> {
  return isRecord(segment.data) ? segment.data : {};
}

function readString(data: unknown, key: string): string {
  if (!isRecord(data)) return '';
  const value = data[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
