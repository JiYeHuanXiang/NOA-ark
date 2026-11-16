export interface OfficialAttachment {
  content_type?: string;
  contentType?: string;
  filename?: string;
  url?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;

  voice_wav_url?: string;

  asr_refer_text?: string;
}

export interface OfficialArkData {
  prompt?: string;
  ark_type?: string;
  ark_name?: string;
  fields?: Record<string, unknown>;
}

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

export interface OneBotMentionAllSegment {
  type: 'mention_all';
  data: Record<string, never>;
}

export interface NoaMarkdownParams {
  key: string;
  values: string[];
}

export interface OneBotNoaMarkdownSegment {
  type: 'noa_markdown';
  data: {
    content?: string;
    custom_template_id?: string;
    params?: NoaMarkdownParams[];
    force_verify_image_resource?: boolean;
  };
}

export type NoaKeyboardStyle = 0 | 1 | 3 | 4;

export type NoaKeyboardActionType = 0 | 1 | 2;

export interface NoaKeyboardButton {
  id?: string;
  render_data?: {
    label?: string;
    visited_label?: string;
    style?: NoaKeyboardStyle;
    [key: string]: unknown;
  };
  action?: {
    type?: NoaKeyboardActionType;
    permission?: { type?: 0 | 1 | 2; [key: string]: unknown };
    data?: string;
    enter?: boolean;
    reply?: boolean;
    modal?: { content?: string; confirm_text?: string; cancel_text?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NoaKeyboardRow {
  buttons: NoaKeyboardButton[];
}

export type NoaKeyboardPayload =
  | { id: string }
  | { content: { rows: NoaKeyboardRow[] } };

export interface OneBotNoaKeyboardSegment {
  type: 'noa_keyboard';
  data: NoaKeyboardPayload;
}

export interface NoaCardPayload {
  type: 'tuwen';
  content: {
    title: string;
    description: string;
    url: string;
    pic_url: string;
    [key: string]: unknown;
  };
}

export interface OneBotNoaCardSegment {
  type: 'noa_card';
  data: NoaCardPayload;
}

export interface OneBotNoaArkSegment {
  type: 'noa_ark';
  data: { json: unknown };
}

export interface OneBotNoaEmbedSegment {
  type: 'noa_embed';
  data: { embed: unknown };
}

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
  | OneBotNoaCardSegment
  | OneBotNoaArkSegment
  | OneBotNoaEmbedSegment;

export interface RawSegment {
  type: string;
  data: Record<string, unknown>;
}

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

export interface MilkyOpaqueSegment {
  type: 'file' | 'forward' | 'market_face' | 'light_app' | 'xml' | 'markdown';
  data: Record<string, unknown>;
}

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

export type SegmentConversion<T> =
  | { ok: true; segments: T[] }
  | { ok: false; reason: string };

export interface OfficialToSegmentsOptions {

  attachments?: readonly OfficialAttachment[];

  selfPseudo?: string;

  resolve: (openid: string) => string;
}

const AT_TAG =
  /<qqbot-at-user\s+id="([^"]*)"\s*\/?>|<qqbot-at-everyone\s*\/?>|<@!?([^<>\s]+)>/g;
const RICH_MEDIA_TYPES = new Set(['image', 'record', 'video']);

const MAX_ELEMENT_DEPTH = 4;

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

      parts.push({ kind: 'at-all' });
    }
    cursor = index + match[0].length;
  }
  if (cursor < input.length) parts.push({ kind: 'text', text: input.slice(cursor) });
  return parts;
}

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

export function needsRichMedia(segments: readonly AnyOneBotSegment[]): boolean {
  return segments.some((segment) => RICH_MEDIA_TYPES.has(segment.type));
}

export interface OutboundMarkdown {
  content?: string;
  custom_template_id?: string;
  params?: NoaMarkdownParams[];
  force_verify_image_resource?: boolean;
}

export type OutboundPart =
  | { kind: 'text'; text: string; keyboard?: NoaKeyboardPayload }
  | { kind: 'markdown'; markdown: OutboundMarkdown; keyboard?: NoaKeyboardPayload }
  | { kind: 'media'; mediaType: 'image' | 'record' | 'video'; file: string }
  | { kind: 'card'; card: NoaCardPayload };

export interface NoaOutboundCapabilities {
  markdown: boolean;
  keyboard: boolean;
  card: boolean;
}

export interface OfficialOutboundOptions {

  scope: 'group' | 'c2c';

  noa?: NoaOutboundCapabilities;

  resolveAt?: (qq: string) => string | null;
}

export type OfficialOutboundResult =
  | { ok: true; parts: OutboundPart[]; replyId: string }
  | { ok: false; reason: string; retcode?: number };

const MEDIA_TYPE_BY_SEGMENT: Record<string, 'image' | 'record' | 'video'> = {
  image: 'image',
  record: 'record',
  video: 'video',
};

const MAX_KEYBOARD_ROWS = 5;
const MAX_KEYBOARD_BUTTONS_PER_ROW = 5;

export function segmentsToOfficialParts(
  segments: readonly AnyOneBotSegment[],
  options: OfficialOutboundOptions,
): OfficialOutboundResult {
  const noa = options.noa;
  const markdownMode = noa?.markdown === true && segments.some((segment) => segment.type === 'noa_markdown');
  const parts: OutboundPart[] = [];
  const markdownAtTags: string[] = [];
  let replyId = '';
  let textBody = '';
  let mediaCount = 0;
  let markdown: OutboundMarkdown | null = null;
  let keyboard: NoaKeyboardPayload | null = null;
  let card: NoaCardPayload | null = null;

  const pushText = (text: string): void => {
    if (text === '') return;
    textBody += text;
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
          const tag = '<qqbot-at-everyone />';
          if (markdownMode) markdownAtTags.push(tag);
          else pushText(tag);
          break;
        }
        if (options.scope !== 'group') {
          return { ok: false, reason: '官方单聊不支持 @ 能力' };
        }
        if (!markdownMode) {
          return {
            ok: false,
            reason: '官方群聊的 @用户 仅支持 markdown 消息；请在同一消息里使用 noa_markdown 段',
          };
        }
        const openid = options.resolveAt?.(qq) ?? '';
        if (openid === '') {
          return { ok: false, reason: `at 目标 ${qq} 不在本地映射中，无法转换为官方 openid` };
        }
        markdownAtTags.push(`<qqbot-at-user id="${escapeXmlAttr(openid)}" />`);
        break;
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
        if (markdownMode) markdownAtTags.push('<qqbot-at-everyone />');
        else pushText('<qqbot-at-everyone />');
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
        mediaCount += 1;
        break;
      }
      case 'noa_markdown': {
        if (noa?.markdown !== true) {
          return { ok: false, reason: 'noa 扩展消息段「noa_markdown」未启用（配置 noa.ext.markdown=true 后启用）' };
        }
        if (markdown !== null) {
          return { ok: false, reason: '同一消息只能有一个 noa_markdown 段' };
        }
        const validated = validateMarkdownPayload(segment.data);
        if (!validated.ok) return { ok: false, reason: validated.reason };
        markdown = validated.markdown;
        break;
      }
      case 'noa_keyboard': {
        if (noa?.keyboard !== true) {
          return { ok: false, reason: 'noa 扩展消息段「noa_keyboard」未启用（配置 noa.ext.keyboard=true 后启用）' };
        }
        if (keyboard !== null) {
          return { ok: false, reason: '同一消息只能有一个 noa_keyboard 段' };
        }
        const validated = validateKeyboardPayload(segment.data);
        if (!validated.ok) return { ok: false, reason: validated.reason };
        keyboard = validated.keyboard;
        break;
      }
      case 'noa_card': {
        if (noa?.card !== true) {
          return { ok: false, reason: 'noa 扩展消息段「noa_card」未启用（配置 noa.ext.card=true 后启用）' };
        }
        if (card !== null) {
          return { ok: false, reason: '同一消息只能有一个 noa_card 段' };
        }
        const validated = validateCardPayload(segment.data);
        if (!validated.ok) return { ok: false, reason: validated.reason };
        card = validated.card;
        break;
      }
      case 'noa_ark':
      case 'noa_embed':
        return {
          ok: false,
          retcode: 1404,
          reason: '官方群聊/单聊不支持发送结构化卡片（入站可用 / 出站不可用）；图文卡片请用 noa_card',
        };
      default:
        return { ok: false, reason: `消息段「${segment.type}」无法经 QQ 官方平台发送（无对应能力）` };
    }
  }

  if (card !== null) {
    if (markdown !== null || textBody.trim() !== '' || mediaCount > 0 || keyboard !== null) {
      return { ok: false, reason: 'noa_card 必须单独发送，不能与 text / noa_markdown / noa_keyboard / 富媒体混排' };
    }
    return { ok: true, parts: [{ kind: 'card', card }], replyId };
  }

  if (markdown !== null) {
    if (textBody.trim() !== '') {
      return { ok: false, reason: 'noa_markdown 不能与 text 混排（官方一条消息只能一种内容类型）' };
    }
    if (mediaCount > 0) {
      return { ok: false, reason: 'noa_markdown 不能与富媒体混排（官方一条消息只能一种内容类型）' };
    }
    if (markdown.content === undefined) {
      if (markdownAtTags.length > 0) {
        return { ok: false, reason: '模板 markdown（custom_template_id）不支持 at 段；@ 只能写在自定义 content 中' };
      }
      const part: OutboundPart = keyboard === null
        ? { kind: 'markdown', markdown }
        : { kind: 'markdown', markdown, keyboard };
      return { ok: true, parts: [part], replyId };
    }
    const content = markdownAtTags.length === 0
      ? markdown.content
      : `${markdown.content}${markdown.content.endsWith('\n') ? '' : '\n'}${markdownAtTags.join(' ')}`;
    const payload: OutboundMarkdown = { ...markdown, content };
    const part: OutboundPart = keyboard === null
      ? { kind: 'markdown', markdown: payload }
      : { kind: 'markdown', markdown: payload, keyboard };
    return { ok: true, parts: [part], replyId };
  }

  if (keyboard !== null) {
    if (mediaCount > 0) {
      return { ok: false, reason: 'noa_keyboard 不能挂在富媒体消息上' };
    }
    const first = parts[0];
    if (first === undefined || first.kind !== 'text' || textBody.trim() === '') {
      return { ok: false, reason: 'noa_keyboard 必须与同一个消息里的 text 或 noa_markdown 同现' };
    }
    parts[0] = { kind: 'text', text: first.text, keyboard };
  }

  return { ok: true, parts, replyId };
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function validateMarkdownPayload(
  data: unknown,
): { ok: true; markdown: OutboundMarkdown } | { ok: false; reason: string } {
  if (!isRecord(data)) return { ok: false, reason: 'noa_markdown.data 必须是对象' };
  const content = typeof data.content === 'string' ? data.content : '';
  const templateId = typeof data.custom_template_id === 'string' ? data.custom_template_id : '';
  const hasContent = content.trim() !== '';
  const hasTemplate = templateId !== '';

  if (hasContent && hasTemplate) {
    return { ok: false, reason: 'noa_markdown 的 content 与 custom_template_id 互斥，只能二选一' };
  }
  if (!hasContent && !hasTemplate) {
    return { ok: false, reason: 'noa_markdown 需要 content 或 custom_template_id + params' };
  }

  const forceVerify = data.force_verify_image_resource;
  if (forceVerify !== undefined && typeof forceVerify !== 'boolean') {
    return { ok: false, reason: 'noa_markdown.force_verify_image_resource 必须是布尔值' };
  }

  if (hasContent) {
    if (data.params !== undefined) {
      return { ok: false, reason: 'noa_markdown.params 只在模板模式（custom_template_id）下可用' };
    }
    const markdown: OutboundMarkdown = { content };
    if (forceVerify === true) markdown.force_verify_image_resource = true;
    return { ok: true, markdown };
  }

  if (forceVerify === true) {
    return { ok: false, reason: 'force_verify_image_resource 仅适用于自定义 content 模式' };
  }
  if (!Array.isArray(data.params)) {
    return { ok: false, reason: 'noa_markdown 模板模式需要 params 数组' };
  }
  const params: NoaMarkdownParams[] = [];
  for (const [index, raw] of data.params.entries()) {
    if (!isRecord(raw)) return { ok: false, reason: `noa_markdown.params 第 ${index + 1} 项必须是对象` };
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (key === '') return { ok: false, reason: `noa_markdown.params 第 ${index + 1} 项缺少 key` };
    if (!Array.isArray(raw.values) || raw.values.length === 0) {
      return { ok: false, reason: `noa_markdown.params 第 ${index + 1} 项缺少 values 数组` };
    }
    const values = raw.values.map((item) => (typeof item === 'string' ? item : ''));
    if (values.some((item) => item === '')) {
      return { ok: false, reason: `noa_markdown.params 第 ${index + 1} 项的 values 必须是非空字符串` };
    }
    params.push({ key, values });
  }
  return { ok: true, markdown: { custom_template_id: templateId, params } };
}

function validateKeyboardPayload(
  data: unknown,
): { ok: true; keyboard: NoaKeyboardPayload } | { ok: false; reason: string } {
  const payload = isRecord(data) ? data : {};
  const hasId = typeof payload.id === 'string' && payload.id !== '';
  const hasContent = isRecord(payload.content);
  if (hasId && hasContent) {
    return { ok: false, reason: 'noa_keyboard 的 id 与 content 互斥，只能二选一' };
  }
  if (hasId) return { ok: true, keyboard: { id: payload.id as string } };
  if (!hasContent) {
    return { ok: false, reason: 'noa_keyboard 需要 id（模板）或 content.rows（自定义按钮）' };
  }

  const rows = (payload.content as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: 'noa_keyboard.content.rows 必须是非空数组' };
  }
  if (rows.length > MAX_KEYBOARD_ROWS) {
    return { ok: false, reason: `noa_keyboard 最多 ${MAX_KEYBOARD_ROWS} 行按钮（官方超限返回 40034029）` };
  }
  for (const [rowIndex, row] of rows.entries()) {
    if (!isRecord(row) || !Array.isArray(row.buttons) || row.buttons.length === 0) {
      return { ok: false, reason: `noa_keyboard 第 ${rowIndex + 1} 行缺少 buttons` };
    }
    if (row.buttons.length > MAX_KEYBOARD_BUTTONS_PER_ROW) {
      return {
        ok: false,
        reason: `noa_keyboard 每行最多 ${MAX_KEYBOARD_BUTTONS_PER_ROW} 个按钮（官方超限返回 40034029）`,
      };
    }
    for (const [buttonIndex, rawButton] of row.buttons.entries()) {
      const prefix = `noa_keyboard 第 ${rowIndex + 1} 行第 ${buttonIndex + 1} 个按钮`;
      if (!isRecord(rawButton)) return { ok: false, reason: `${prefix} 必须是对象` };
      const renderData = rawButton.render_data;
      if (isRecord(renderData)) {
        const label = renderData.label;
        if (label !== undefined && (typeof label !== 'string' || [...label].length > 10)) {
          return { ok: false, reason: `${prefix} 的 label 必须是不超过 10 字符的字符串` };
        }
        const style = renderData.style;
        if (style !== undefined && style !== 0 && style !== 1 && style !== 3 && style !== 4) {
          return { ok: false, reason: `${prefix} 的 style 只能是 0/1/3/4` };
        }
      }
      const action = rawButton.action;
      if (isRecord(action)) {
        const type = action.type;
        if (type !== undefined && type !== 0 && type !== 1 && type !== 2) {
          return { ok: false, reason: `${prefix} 的 action.type 只能是 0/1/2` };
        }
        if ((type === 1 || type === 2) && (typeof action.data !== 'string' || action.data === '')) {
          return { ok: false, reason: `${prefix} 的 action.type=${String(type)} 需要非空 action.data` };
        }
        const permission = action.permission;
        if (isRecord(permission)) {
          const permissionType = permission.type;
          if (permissionType !== undefined && permissionType !== 0 && permissionType !== 1 && permissionType !== 2) {
            return { ok: false, reason: `${prefix} 的 action.permission.type 只能是 0/1/2` };
          }
        }
        const modal = action.modal;
        if (isRecord(modal)) {
          const content = modal.content;
          if (content !== undefined) {
            if (typeof content !== 'string' || [...content].length > 40) {
              return { ok: false, reason: `${prefix} 的 modal.content 必须是不超过 40 字符的字符串` };
            }
            if (/https?:\/\//i.test(content)) {
              return { ok: false, reason: `${prefix} 的 modal.content 不能包含 URL` };
            }
          }
          for (const key of ['confirm_text', 'cancel_text'] as const) {
            const value = modal[key];
            if (value !== undefined && (typeof value !== 'string' || [...value].length > 4)) {
              return { ok: false, reason: `${prefix} 的 modal.${key} 必须是不超过 4 字符的字符串` };
            }
          }
        }
      }
    }
  }

  return { ok: true, keyboard: { content: { rows: rows as NoaKeyboardRow[] } } };
}

function validateCardPayload(
  data: unknown,
): { ok: true; card: NoaCardPayload } | { ok: false; reason: string } {
  if (!isRecord(data)) return { ok: false, reason: 'noa_card.data 必须是对象' };
  if (data.type !== 'tuwen') return { ok: false, reason: 'noa_card.type 仅支持 tuwen（图文卡片）' };
  const content = data.content;
  if (!isRecord(content)) return { ok: false, reason: 'noa_card.content 必须是对象' };

  const title = content.title;
  if (typeof title !== 'string' || [...title].length < 1 || [...title].length > 50) {
    return { ok: false, reason: 'noa_card.content.title 必须是 1–50 字符的字符串' };
  }
  const description = content.description;
  if (typeof description !== 'string' || [...description].length < 1 || [...description].length > 200) {
    return { ok: false, reason: 'noa_card.content.description 必须是 1–200 字符的字符串' };
  }
  for (const key of ['url', 'pic_url'] as const) {
    const value = content[key];
    if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 1024) {
      return { ok: false, reason: `noa_card.content.${key} 必须是 https 链接且不超过 1024 字符` };
    }
  }

  return {
    ok: true,
    card: {
      type: 'tuwen',
      content: {
        title,
        description,
        url: content.url as string,
        pic_url: content.pic_url as string,
      },
    },
  };
}

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
