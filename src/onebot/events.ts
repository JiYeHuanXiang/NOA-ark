/**
 * OneBot v11 事件构造：官方事件 → OneBot v11 事件对象。
 *
 * 依据 文档 §3.2：message / notice / request / meta_event 四类。
 * 字段补齐：sender（user_id/nickname/card/role/title）、anonymous=null、
 * font=0、message（段数组）、raw_message（CQ 串）。
 * ID 经 IdMapper 暴露（mapped=伪 int64 数值，passthrough=透传字符串）。
 */

import type { IdMapper } from '../core/idmap.js';
import {
  type OfficialArkData,
  type OfficialAttachment,
  type ParsedOfficialPart,
  type AnyOneBotSegment,
  type OneBotSegment,
  arkDataToText,
  attachmentsToSegments,
  msgElementsToSegments,
  officialPartsToSegments,
  parseOfficialContent,
  segmentsToCQ,
} from '../core/segments.js';
import type { OfficialScope } from '../types.js';

/** 官方原始事件（字段兼容 snake_case 与 camelCase）。 */
export interface OfficialEvent {
  eventType: string;
  data: Record<string, unknown>;
}

export interface OneBotEventContext {
  mapper: IdMapper;
  idMode: 'mapped' | 'passthrough';
  /** 机器人自身 openid（用于把 @机器人 还原成 self_id；未知时用 AppID）。 */
  selfOpenid: string;
  /** 时间戳缺失时的兜底（毫秒）。 */
  now: () => number;
}

export type AnyOneBotEvent =
  | OneBotMessageEvent
  | OneBotGroupIncreaseEvent
  | OneBotGroupDecreaseEvent
  | OneBotFriendAddEvent
  | OneBotGroupRecallEvent
  | OneBotFriendRecallEvent
  | OneBotGroupRequestEvent
  | OneBotFriendRequestEvent
  | OneBotLifecycleEvent
  | OneBotHeartbeatEvent;

export interface OneBotEventBase {
  time: number;
  self_id: number | string;
  post_type: 'message' | 'notice' | 'request' | 'meta_event';
}

export interface OneBotMessageEvent extends OneBotEventBase {
  post_type: 'message';
  message_type: 'group' | 'private';
  sub_type: 'normal' | 'friend' | 'group' | 'other';
  message_id: number | string;
  user_id: number | string;
  group_id?: number | string;
  message: AnyOneBotSegment[];
  raw_message: string;
  font: number;
  sender: {
    user_id: number | string;
    nickname: string;
    card?: string;
    role?: string;
    title?: string;
  };
  anonymous: null;
  /** noa 扩展：本消息是否显式 @ 了机器人（群聊按事件类型/mentions/content 判定）。 */
  at_me: boolean;
  /** noa 扩展：本消息是否发给机器人（群聊=被 @；私聊恒为 true）。 */
  to_me: boolean;
}

export interface OneBotGroupIncreaseEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'group_increase';
  sub_type: 'approve' | 'invite';
  group_id: number | string;
  user_id: number | string;
  operator_id: number | string;
}

export interface OneBotGroupDecreaseEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'group_decrease';
  sub_type: 'leave' | 'kick' | 'kick_me';
  group_id: number | string;
  user_id: number | string;
  operator_id: number | string;
}

export interface OneBotFriendAddEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'friend_add';
  user_id: number | string;
}

export interface OneBotGroupRecallEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'group_recall';
  group_id: number | string;
  user_id: number | string;
  operator_id: number | string;
  message_id: number | string;
}

export interface OneBotFriendRecallEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'friend_recall';
  user_id: number | string;
  message_id: number | string;
}

export interface OneBotGroupRequestEvent extends OneBotEventBase {
  post_type: 'request';
  request_type: 'group';
  sub_type: 'add' | 'invite';
  group_id: number | string;
  user_id: number | string;
  comment: string;
  flag: string;
}

export interface OneBotFriendRequestEvent extends OneBotEventBase {
  post_type: 'request';
  request_type: 'friend';
  user_id: number | string;
  comment: string;
  flag: string;
}

export interface OneBotLifecycleEvent extends OneBotEventBase {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle';
  sub_type: 'connect' | 'enable';
}

export interface OneBotHeartbeatEvent extends OneBotEventBase {
  post_type: 'meta_event';
  meta_event_type: 'heartbeat';
  interval: number;
}

function readString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function readNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTimestamp(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * 官方事件 → OneBot v11 事件。
 *
 * 返回 null 表示该官方事件类型无 v11 对应语义（适配器仅记录日志）。
 */
export function officialEventToOneBotEvent(
  event: OfficialEvent,
  ctx: OneBotEventContext,
): AnyOneBotEvent | null {
  const { mapper, idMode } = ctx;
  const expose = (openid: string): number | string =>
    idMode === 'passthrough' ? openid : Number(mapper.pseudoOf(openid));
  const exposeMsg = (rawMsgId: string): number | string =>
    idMode === 'passthrough' ? rawMsgId : Number(mapper.pseudoMsgOf(rawMsgId));
  const selfId = idMode === 'passthrough' ? ctx.selfOpenid : Number(mapper.selfPseudo(ctx.selfOpenid));
  const now = ctx.now();
  const data = event.data ?? {};

  const tsMs = parseTimestamp(readString(data, 'timestamp', 'time'), now);
  const time = Math.floor(tsMs / 1000);

  const resolveMention = (openid: string): string =>
    ctx.selfOpenid !== '' && openid === ctx.selfOpenid
      ? String(selfId)
      : idMode === 'passthrough'
        ? openid
        : mapper.pseudoOf(openid);

  switch (event.eventType) {
    case 'GROUP_AT_MESSAGE_CREATE':
    case 'GROUP_MESSAGE_CREATE': {
      const senderOpenid = readString(data, 'user_openid', 'sender_openid');
      const groupOpenid = readString(data, 'group_openid');
      const author = (data.author ?? {}) as Record<string, unknown>;
      const senderOpenidFromAuthor = readString(author, 'user_openid', 'id');
      const finalSender = senderOpenid || senderOpenidFromAuthor;
      const nickname = readString(author, 'username', 'nickname') || finalSender.slice(0, 12);
      const attachments = Array.isArray(data.attachments)
        ? (data.attachments as OfficialAttachment[])
        : [];
      const content = readString(data, 'content');
      const parts = parseOfficialContent(content);
      const segments = officialPartsToSegments(parts, {
        attachments,
        selfPseudo: String(selfId),
        resolve: resolveMention,
      });

      // 全量模式下引用/聊天记录/并行消息的正文在 msg_elements 里，content 可能是空白。
      const elements = Array.isArray(data.msg_elements) ? data.msg_elements : [];
      if (content.trim() === '') {
        dropBlankText(segments);
      }
      if (content.trim() === '' && elements.length > 0) {
        segments.push(...msgElementsToSegments(elements));
      }
      // 结构化卡片：正文为空且没有元素可展开时，降级为 [卡片:标题]。
      if (content.trim() === '' && elements.length === 0 && isRecord(data.ark_data)) {
        const cardText = arkDataToText(data.ark_data as OfficialArkData);
        if (cardText !== '') segments.push({ type: 'text', data: { text: cardText } });
      }

      const atMe = isGroupMessageAtMe(event.eventType, data, parts, ctx.selfOpenid);
      // GROUP_AT_MESSAGE_CREATE 的 content 已被平台去掉 @ 前缀；补回 at 段，
      // 保证按「被 @ 才响应」判断的旧程序行为一致。
      if (atMe && !hasAtSelf(segments, selfId)) {
        segments.unshift({ type: 'at', data: { qq: String(selfId) } });
      }

      return {
        time,
        self_id: selfId,
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        message_id: exposeMsg(readString(data, 'id', 'message_id')),
        user_id: expose(finalSender),
        group_id: expose(groupOpenid),
        message: segments,
        raw_message: segmentsToCQ(segments),
        font: 0,
        sender: {
          user_id: expose(finalSender),
          nickname,
          card: nickname,
          role: 'member',
          title: '',
        },
        anonymous: null,
        at_me: atMe,
        to_me: atMe,
      };
    }

    case 'C2C_MESSAGE_CREATE': {
      const author = (data.author ?? {}) as Record<string, unknown>;
      const senderOpenid = readString(data, 'user_openid', 'sender_openid') || readString(author, 'user_openid', 'id');
      const nickname = readString(author, 'username', 'nickname') || senderOpenid.slice(0, 12);
      const attachments = Array.isArray(data.attachments)
        ? (data.attachments as OfficialAttachment[])
        : [];
      const parts = parseOfficialContent(readString(data, 'content'));
      const segments = officialPartsToSegments(parts, {
        attachments,
        selfPseudo: String(selfId),
        resolve: resolveMention,
      });
      return {
        time,
        self_id: selfId,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: exposeMsg(readString(data, 'id', 'message_id')),
        user_id: expose(senderOpenid),
        message: segments,
        raw_message: segmentsToCQ(segments),
        font: 0,
        sender: {
          user_id: expose(senderOpenid),
          nickname,
        },
        anonymous: null,
        at_me: false,
        to_me: true,
      };
    }

    case 'GROUP_ADD_ROBOT':
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_increase',
        sub_type: 'approve',
        group_id: expose(readString(data, 'group_openid')),
        user_id: selfId,
        operator_id: expose(readString(data, 'op_user_id', 'operator_id')),
      };

    case 'GROUP_DEL_ROBOT':
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_decrease',
        sub_type: 'kick_me',
        group_id: expose(readString(data, 'group_openid')),
        user_id: selfId,
        operator_id: expose(readString(data, 'op_user_id', 'operator_id')),
      };

    case 'GROUP_MEMBER_ADD':
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_increase',
        sub_type: 'approve',
        group_id: expose(readString(data, 'group_openid')),
        user_id: expose(readString(data, 'user_openid', 'openid', 'member_openid')),
      operator_id: 0,
      };

    case 'GROUP_MEMBER_QUIT':
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_decrease',
        sub_type: 'leave',
        group_id: expose(readString(data, 'group_openid')),
        user_id: expose(readString(data, 'user_openid', 'openid', 'member_openid')),
        operator_id: expose(readString(data, 'op_user_id', 'operator_id')),
      };

    case 'GROUP_JOIN_REQUEST': {
      const initiator = readString(data, 'user_openid', 'initiator_openid', 'openid');
      const groupOpenid = readString(data, 'group_openid');
      const requestId = readString(data, 'request_id', 'id', 'notification_seq')
        || String(readNumber(data, 'notification_seq'));
      return {
        time,
        self_id: selfId,
        post_type: 'request',
        request_type: 'group',
        sub_type: 'add',
        group_id: expose(groupOpenid),
        user_id: expose(initiator),
        comment: readString(data, 'comment', 'msg'),
        // flag 对应用端不透明：内部编码 group openid + 请求序列号，供 set_group_add_request 使用。
        flag: `${groupOpenid}:${requestId}`,
      };
    }

    case 'FRIEND_ADD':
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'friend_add',
        user_id: expose(readString(data, 'user_openid', 'openid')),
      };

    case 'FRIEND_VERIFY':
      return {
        time,
        self_id: selfId,
        post_type: 'request',
        request_type: 'friend',
        user_id: expose(readString(data, 'user_openid', 'initiator_openid')),
        comment: readString(data, 'comment', 'msg'),
        flag: readString(data, 'request_id', 'id'),
      };

    default:
      return null;
  }
}

/**
 * 群消息是否 @ 了机器人。
 *
 * 判定来源（任一成立）：
 *   1. GROUP_AT_MESSAGE_CREATE 事件类型本身（官方会去掉 content 里的 @ 前缀，
 *      且 mentions 不含机器人自身）；
 *   2. content 里的 `<@self>` / `<qqbot-at-user id="self"/>` 标记；
 *   3. mentions 条目的 `is_you=true`，或 id / user_openid / member_openid 等于机器人 openid。
 */
function isGroupMessageAtMe(
  eventType: string,
  data: Record<string, unknown>,
  parts: readonly ParsedOfficialPart[],
  selfOpenid: string,
): boolean {
  if (eventType === 'GROUP_AT_MESSAGE_CREATE') return true;

  if (selfOpenid !== '') {
    for (const part of parts) {
      if (part.kind === 'at-user' && part.openid === selfOpenid) return true;
    }
  }

  const mentions = Array.isArray(data.mentions) ? data.mentions : [];
  for (const mention of mentions) {
    if (!isRecord(mention)) continue;
    if (mention.is_you === true) return true;
    if (selfOpenid === '') continue;
    for (const key of ['id', 'user_openid', 'member_openid']) {
      if (mention[key] === selfOpenid) return true;
    }
  }
  return false;
}

/** 段数组里是否已有指向机器人自身的 at 段（避免重复补 @）。 */
function hasAtSelf(segments: readonly OneBotSegment[], selfId: number | string): boolean {
  const self = String(selfId);
  return segments.some(
    (segment) => segment.type === 'at' && String(segment.data.qq) === self,
  );
}

/** 去掉纯空白文本段（官方元素类消息的 content 常为 " "）。 */
function dropBlankText(segments: OneBotSegment[]): void {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment.type === 'text' && segment.data.text.trim() === '') segments.splice(i, 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 心跳 / 生命周期 meta 事件（由连接层定期与连接时构造）。 */
export function buildHeartbeatEvent(
  selfId: number | string,
  intervalMs: number,
  now: () => number,
): OneBotHeartbeatEvent {
  return {
    time: Math.floor(now() / 1000),
    self_id: selfId,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    interval: intervalMs,
  };
}

export function buildLifecycleEvent(selfId: number | string, now: () => number): OneBotLifecycleEvent {
  return {
    time: Math.floor(now() / 1000),
    self_id: selfId,
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: 'connect',
  };
}
