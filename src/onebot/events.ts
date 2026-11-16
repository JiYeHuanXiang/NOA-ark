import type { IdMapper } from '../core/idmap.js';
import {
  type OfficialArkData,
  type OfficialAttachment,
  type ParsedOfficialPart,
  type AnyOneBotSegment,
  type OneBotSegment,
  arkDataToText,
  msgElementsToSegments,
  officialPartsToSegments,
  parseOfficialContent,
  segmentsToCQ,
} from '../core/segments.js';

export interface OfficialEvent {
  eventType: string;
  data: Record<string, unknown>;
}

export interface OneBotEventContext {
  mapper: IdMapper;
  idMode: 'mapped' | 'passthrough';

  selfOpenid: string;

  now: () => number;

  noaEvents?: boolean;
}

export type AnyOneBotEvent =
  | OneBotMessageEvent
  | OneBotGroupIncreaseEvent
  | OneBotGroupDecreaseEvent
  | OneBotFriendAddEvent
  | OneBotFriendDelEvent
  | OneBotGroupMsgSettingEvent
  | OneBotC2cMsgSettingEvent
  | OneBotSubscribeStatusEvent
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

  at_me: boolean;

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

export interface OneBotFriendDelEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'noa_friend_del';
  user_id: number | string;
}

export interface OneBotGroupMsgSettingEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'noa_group_msg_setting';
  group_id: number | string;
  operator_id: number | string;
  enabled: boolean;
}

export interface OneBotC2cMsgSettingEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'noa_c2c_msg_setting';
  user_id: number | string;
  enabled: boolean;
}

export interface OneBotSubscribeStatusEvent extends OneBotEventBase {
  post_type: 'notice';
  notice_type: 'noa_subscribe_status';
  user_id: number | string;
  group_id?: number | string;
  result: unknown[];
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

  join_request_id?: string;

  member_openid?: string;

  verify_info?: Record<string, unknown>;

  auto_approved?: boolean;
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

      const elements = Array.isArray(data.msg_elements) ? data.msg_elements : [];
      if (content.trim() === '') {
        dropBlankText(segments);
      }
      if (content.trim() === '' && elements.length > 0) {
        segments.push(...msgElementsToSegments(elements));
      }

      if (content.trim() === '' && elements.length === 0 && isRecord(data.ark_data)) {
        const cardText = arkDataToText(data.ark_data as OfficialArkData);
        if (cardText !== '') segments.push({ type: 'text', data: { text: cardText } });
      }

      const atMe = isGroupMessageAtMe(event.eventType, data, parts, ctx.selfOpenid);

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
    case 'GROUP_MEMBER_REMOVE':
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_decrease',
        sub_type: event.eventType === 'GROUP_MEMBER_REMOVE' ? 'kick' : 'leave',
        group_id: expose(readString(data, 'group_openid')),
        user_id: expose(readString(data, 'user_openid', 'openid', 'member_openid')),
        operator_id: expose(readString(data, 'op_user_id', 'operator_id')),
      };

    case 'GROUP_JOIN_REQUEST': {
      const initiator = readString(data, 'user_openid', 'initiator_openid', 'openid', 'member_openid');
      const groupOpenid = readString(data, 'group_openid');
      const joinRequestId = readString(data, 'join_request_id');
      const legacySeqRaw = readString(data, 'request_id', 'id', 'notification_seq');
      const legacySeqNumber = readNumber(data, 'notification_seq');
      const legacyRequestId = legacySeqRaw !== '' && legacySeqRaw !== '0'
        ? legacySeqRaw
        : (legacySeqNumber > 0 ? String(legacySeqNumber) : '');
      const verifyInfo = isRecord(data.verify_info) ? data.verify_info : undefined;
      const comment = readString(data, 'comment', 'msg')
        || (verifyInfo === undefined ? '' : readString(verifyInfo, 'verify_message'));

      const canUseNewEndpoint = joinRequestId !== '' && initiator !== '';
      const canUseLegacyEndpoint = !canUseNewEndpoint && joinRequestId === '' && legacyRequestId !== '';
      return {
        time,
        self_id: selfId,
        post_type: 'request',
        request_type: 'group',
        sub_type: 'add',
        group_id: expose(groupOpenid),
        user_id: expose(initiator),
        comment,
        flag: canUseNewEndpoint
          ? `${groupOpenid}:${initiator}:${joinRequestId}`
          : canUseLegacyEndpoint
            ? `${groupOpenid}:${legacyRequestId}`
            : '',
        ...(joinRequestId === '' ? {} : { join_request_id: joinRequestId }),
        ...(initiator === '' ? {} : { member_openid: initiator }),
        ...(verifyInfo === undefined ? {} : { verify_info: verifyInfo }),
        ...(typeof data.auto_approved === 'boolean' ? { auto_approved: data.auto_approved } : {}),
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

    case 'FRIEND_DEL':
      if (ctx.noaEvents !== true) return null;
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'noa_friend_del',
        user_id: expose(readString(data, 'user_openid', 'openid')),
      };

    case 'GROUP_MSG_RECEIVE':
    case 'GROUP_MSG_REJECT':
      if (ctx.noaEvents !== true) return null;
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'noa_group_msg_setting',
        group_id: expose(readString(data, 'group_openid')),
        operator_id: expose(readString(data, 'op_user_id', 'operator_id')),
        enabled: event.eventType === 'GROUP_MSG_RECEIVE',
      };

    case 'C2C_MSG_RECEIVE':
    case 'C2C_MSG_REJECT':
      if (ctx.noaEvents !== true) return null;
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'noa_c2c_msg_setting',
        user_id: expose(readString(data, 'user_openid', 'openid')),
        enabled: event.eventType === 'C2C_MSG_RECEIVE',
      };

    case 'SUBSCRIBE_MESSAGE_STATUS': {
      if (ctx.noaEvents !== true) return null;
      const openid = readString(data, 'openid', 'user_openid');
      const groupOpenid = readString(data, 'group_openid');
      return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'noa_subscribe_status',
        user_id: expose(openid),
        ...(groupOpenid === '' ? {} : { group_id: expose(groupOpenid) }),
        result: Array.isArray(data.result) ? data.result : [],
      };
    }

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

function hasAtSelf(segments: readonly OneBotSegment[], selfId: number | string): boolean {
  const self = String(selfId);
  return segments.some(
    (segment) => segment.type === 'at' && String(segment.data.qq) === self,
  );
}

function dropBlankText(segments: OneBotSegment[]): void {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment.type === 'text' && segment.data.text.trim() === '') segments.splice(i, 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
