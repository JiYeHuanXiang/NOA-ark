/**
 * OneBot v11 Action 路由（文档 §3.3 三档口径）。
 *
 * ✅ 直接实现：官方 REST 或适配器本地能力
 * ⚠️ 降级实现：群目录合成 / 本地消息缓存
 * ❌ 明确拒绝：retcode=1404 + 原因（官方平台无此能力）
 *
 * 发送类动作不直接依赖 Rest，而依赖注入的 MessageSender ——
 * 被动窗口（msg_id + msg_seq）与主动配额由桥接层统一处理。
 */

import type { IdMapper } from '../core/idmap.js';
import type { MediaCache } from '../core/media-cache.js';
import {
  cqToSegments,
  officialPartsToSegments,
  parseOfficialContent,
  segmentsToCQ,
  segmentsToOfficialParts,
  type AnyOneBotSegment,
  type OutboundPart,
} from '../core/segments.js';
import { enabledNoaExt, type NoaConf } from '../config.js';
import type { NoaActionRouter } from '../noa/router.js';
import type { OfficialScope } from '../types.js';

export interface OneBotResponse {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: unknown;
  message: string;
  echo?: unknown;
}

/** 单条官方消息的发送结果；refIdx 供后续引用回复使用。 */
export interface SentMessagePart {
  messageId: string;
  refIdx?: string;
}

export interface SendPartsOptions {
  /** 被引用消息的 REFIDX；只附加到本次发送的第一条消息。 */
  refIdx?: string;
  /** 被动回复事件 id（与 msg_id 二选一；官方按事件类型校验场景）。 */
  eventId?: string;
}

export interface SendPartsResult {
  parts: SentMessagePart[];
  passive: boolean;
}

export interface GroupInfoSnapshot {
  groupName?: string;
  memberCount?: number;
}

/** 官方群成员（2026-09-03 白名单接口）。 */
export interface GroupMemberSnapshot {
  memberOpenid: string;
  username: string;
  /** member / admin / owner */
  role: string;
  bot?: boolean;
  joinedAt?: string;
}

/** 发送/管理能力抽象：由桥接层实现（官方 REST + 被动窗口 + 配额）。 */
export interface MessageSender {
  sendGroupText(groupOpenid: string, text: string): Promise<{ messageId: string; passive: boolean }>;
  sendPrivateText(userOpenid: string, text: string): Promise<{ messageId: string; passive: boolean }>;
  /** 按顺序发送文本/富媒体分片；每条分片各占一次被动槽。 */
  sendGroupParts(
    groupOpenid: string,
    parts: readonly OutboundPart[],
    options?: SendPartsOptions,
  ): Promise<SendPartsResult>;
  sendPrivateParts(
    userOpenid: string,
    parts: readonly OutboundPart[],
    options?: SendPartsOptions,
  ): Promise<SendPartsResult>;
  /** 官方群信息；无权限或失败时返回 null（由调用方回退本地目录）。 */
  getGroupInfo(groupOpenid: string): Promise<GroupInfoSnapshot | null>;
  recall(scope: OfficialScope, targetOpenid: string, rawMsgId: string): Promise<void>;
  setGroupBan(groupOpenid: string, muteSeconds: number, memberOpenid?: string): Promise<void>;
  approveGroupRequest(groupOpenid: string, requestId: string, approve: boolean): Promise<void>;
  /** 新审批端点（approval_join_request）：支持拒绝理由与同时拉黑。 */
  approveJoinRequest(
    groupOpenid: string,
    memberOpenid: string,
    body: {
      op: 'approve' | 'decline';
      joinRequestId?: string;
      rejectReason?: string;
      addToMemberBlacklist?: boolean;
    },
  ): Promise<void>;
  /** 群成员列表（白名单；30 条/页，cursor 为空表示第一页）。 */
  listGroupMembers(groupOpenid: string, cursor?: string): Promise<{ members: GroupMemberSnapshot[]; nextCursor: string }>;
  /** 单个群成员信息（白名单）；平台返回错误时抛错。 */
  getGroupMember(groupOpenid: string, memberOpenid: string): Promise<GroupMemberSnapshot>;
  /** 批量移除群成员（单次最多 20 个；可选同时拉黑）。 */
  batchRemoveGroupMembers(
    groupOpenid: string,
    memberOpenids: readonly string[],
    addToBlacklist: boolean,
  ): Promise<{ failedBlacklistOpenids: string[] }>;
}

export interface CachedMessage {
  rawMsgId: string;
  scope: OfficialScope;
  peerOpenid: string;
  senderOpenid: string;
  senderName: string;
  segments: AnyOneBotSegment[];
  rawMessage: string;
  tsMs: number;
  /** 官方 REFIDX：引用回复时作为 message_reference.message_id。 */
  refIdx?: string;
}

export interface MessageCacheLike {
  put(pseudoId: string, record: CachedMessage): void;
  get(pseudoId: string): CachedMessage | undefined;
}

export interface GroupDirectoryLike {
  list(): Array<{ openid: string; name?: string; alias?: string }>;
  get(openid: string): { openid: string; name?: string; alias?: string } | undefined;
}

export interface ActionDeps {
  idMode: 'mapped' | 'passthrough';
  mapper: IdMapper;
  sender: MessageSender | null;
  messageCache: MessageCacheLike;
  groupDirectory: GroupDirectoryLike;
  selfOpenid: string;
  selfNickname: string;
  logger: { warn(message: string): void };
  /** 网关真实在线状态（缺省时退化为 sender 是否存在）。 */
  isOnline?: () => boolean;
  /** get_image / get_record 的本地媒体缓存；未配置时明确失败。 */
  mediaCache?: MediaCache | null;
  /** noa/1 扩展能力开关（缺省视为全部关闭）。 */
  noaConf?: NoaConf;
  /** noa_* 动作路由器；未接入时 noa_* 动作统一 1404。 */
  noa?: NoaActionRouter | null;
  /** 发送成功后向上游投递 message_sent 事件。 */
  emitEvent?: (event: unknown) => void;
}

const RET_OK = 0;
const RET_ASYNC = 1;
const RET_BAD_REQUEST = 1400;
const RET_UNSUPPORTED = 1404;

const UNSUPPORTED_ACTIONS: Record<string, string> = {
  get_friend_list: '官方平台无好友列表 API',
  get_stranger_info: '官方平台无陌生人信息 API',
  set_group_admin: '官方群机器人无管理员任免 API',
  set_group_card: '官方群机器人无群名片 API',
  set_group_special_title: '官方群机器人无专属头衔 API',
  set_group_anonymous: '官方群机器人无匿名消息能力',
  set_group_anonymous_ban: '官方群机器人无匿名成员禁言 API',
  set_group_leave: '官方群机器人无主动退群 API',
  set_group_name: '官方群机器人无改群名 API',
  send_like: '官方平台无名片点赞 API',
  get_group_honor_info: '官方平台无群荣誉 API',
  get_cookies: '官方开放平台无 Cookie 体系',
  get_csrf_token: '官方开放平台无 CSRF Token',
  get_credentials: '官方开放平台无 Cookie/CSRF 体系',
  get_forward_msg: '官方平台无合并转发消息获取 API',
  set_friend_add_request: '官方平台未开放好友审批能力',
};

export const ACTION_NAMES = [
  'send_msg', 'send_private_msg', 'send_group_msg', 'delete_msg', 'get_msg', 'get_forward_msg',
  'get_login_info', 'get_stranger_info', 'get_friend_list', 'get_group_info', 'get_group_list',
  'get_group_member_info', 'get_group_member_list', 'get_group_honor_info',
  'set_group_kick', 'set_group_ban', 'set_group_anonymous_ban', 'set_group_whole_ban',
  'set_group_admin', 'set_group_anonymous', 'set_group_card', 'set_group_name', 'set_group_leave',
  'set_group_special_title', 'set_group_add_request', 'set_friend_add_request',
  'get_cookies', 'get_csrf_token', 'get_credentials', 'get_record', 'get_image',
  'can_send_image', 'can_send_record', 'get_status', 'get_version_info', 'set_restart', 'clean_cache',
  'send_like',
] as const;

export class OneBotActionRouter {
  constructor(private readonly deps: ActionDeps) {}

  /** 动作入口；未知动作与非公开动作统一 1404。 */
  async dispatch(action: string, params: Record<string, unknown>, echo?: unknown): Promise<OneBotResponse> {
    const echoValue = echo ?? params?.echo;
    if (action.startsWith('noa_')) {
      const noaResponse = this.deps.noa === undefined || this.deps.noa === null
        ? null
        : await this.deps.noa.dispatch(action, params, echoValue);
      if (noaResponse !== null) return noaResponse;
      return {
        status: 'failed',
        retcode: RET_UNSUPPORTED,
        data: null,
        message: `noa 扩展动作 ${action} 未接入（见 文档）`,
        echo: echoValue,
      };
    }
    const unsupported = UNSUPPORTED_ACTIONS[action];
    if (unsupported !== undefined) {
      return { status: 'failed', retcode: RET_UNSUPPORTED, data: null, message: unsupported, echo: echoValue };
    }
    switch (action) {
      case 'send_msg':
        return this.sendMsg(params, echoValue);
      case 'send_group_msg':
        return this.sendGroupMsg(params, echoValue);
      case 'send_private_msg':
        return this.sendPrivateMsg(params, echoValue);
      case 'delete_msg':
        return this.deleteMsg(params, echoValue);
      case 'get_msg':
        return this.getMsg(params, echoValue);
      case 'get_login_info':
        return this.ok(echoValue, { user_id: this.selfId(), nickname: this.deps.selfNickname });
      case 'get_status': {
        const online = this.deps.isOnline !== undefined
          ? this.deps.isOnline()
          : this.deps.sender !== null;
        return this.ok(echoValue, { online, good: online });
      }
      case 'get_version_info': {
        const noaExt = this.deps.noaConf === undefined ? [] : enabledNoaExt(this.deps.noaConf.ext);
        return this.ok(echoValue, {
          app_name: 'noa-ark',
          app_version: '0.1.0',
          protocol_version: 'v11',
          id_mode: this.deps.idMode,
          noa_ext_version: 'noa/1',
          noa_ext: noaExt,
        });
      }
      case 'can_send_image':
      case 'can_send_record':
        return this.ok(echoValue, { yes: true });
      case 'get_group_info':
        return this.getGroupInfo(params, echoValue);
      case 'get_group_list': {
        const groups = this.deps.groupDirectory.list().map((entry) => ({
          group_id: this.expose(entry.openid),
          group_name: entry.alias ?? entry.name ?? '',
          member_count: 0,
          max_member_count: 0,
        }));
        return this.ok(echoValue, groups);
      }
      case 'get_group_member_list':
        return this.getGroupMemberList(params, echoValue);
      case 'get_group_member_info':
        return this.getGroupMemberInfo(params, echoValue);
      case 'set_group_kick':
        return this.setGroupKick(params, echoValue);
      case 'set_group_ban':
        return this.setGroupBan(params, echoValue);
      case 'set_group_whole_ban':
        return this.setGroupWholeBan(params, echoValue);
      case 'set_group_add_request':
        return this.setGroupAddRequest(params, echoValue);
      case 'get_image':
        return this.getCachedMedia(params, echoValue, '图片');
      case 'get_record':
        return this.getCachedMedia(params, echoValue, '语音');
      case 'set_restart':
        return { status: 'async', retcode: RET_ASYNC, data: null, message: '', echo: echoValue };
      case 'clean_cache':
        return this.ok(echoValue, null);
      default:
        return {
          status: 'failed',
          retcode: RET_UNSUPPORTED,
          data: null,
          message: `动作 ${action} 不存在或未实现（官方平台无对应能力）`,
          echo: echoValue,
        };
    }
  }

  // —— 发送 ——

  private async sendMsg(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const type = typeof params.message_type === 'string' ? params.message_type : '';
    if (type === 'group' || (type === '' && params.group_id !== undefined)) {
      return this.sendGroupMsg(params, echo);
    }
    if (type === 'private' || (type === '' && params.user_id !== undefined)) {
      return this.sendPrivateMsg(params, echo);
    }
    return this.badRequest('send_msg 需要 message_type 或 user_id/group_id', echo);
  }

  private async sendGroupMsg(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) {
      return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}（官方无全量群列表，请先让机器人收到该群消息）`, echo);
    }
    return this.sendSegments('group', groupOpenid, params, echo);
  }

  private async sendPrivateMsg(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const userOpenid = this.resolveUser(params.user_id);
    if (userOpenid === null) {
      return this.badRequest(`未知 user_id：${String(params.user_id ?? '')}（官方无好友列表；需先收到该用户消息）`, echo);
    }
    return this.sendSegments('c2c', userOpenid, params, echo);
  }

  /**
   * 统一发送：段 → 官方有序分片（文本 / 富媒体），回复段解析为 REFIDX。
   * 文本与图片混排会拆成多条消息，各自消耗一次被动槽。
   */
  private async sendSegments(
    scope: OfficialScope,
    targetOpenid: string,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法发送', echo);

    const ext = this.deps.noaConf?.ext;
    const conversion = segmentsToOfficialParts(normalizeMessage(paramMessage(params)), {
      scope,
      noa: ext === undefined
        ? undefined
        : { markdown: ext.markdown, keyboard: ext.keyboard, card: ext.card },
      resolveAt: (qq) => this.resolveUser(qq),
    });
    if (!conversion.ok) {
      return this.fail(conversion.retcode ?? RET_BAD_REQUEST, conversion.reason, echo);
    }
    const parts = conversion.parts.filter((part) => part.kind !== 'text' || part.text.trim() !== '');
    if (parts.length === 0) return this.badRequest('消息内容为空', echo);

    const reply = this.replyReference(conversion.replyId);
    const eventId = typeof params.event_id === 'string' ? params.event_id : '';
    const sendOptions = { refIdx: reply.refIdx, ...(eventId === '' ? {} : { eventId }) };
    try {
      const result = scope === 'group'
        ? await sender.sendGroupParts(targetOpenid, parts, sendOptions)
        : await sender.sendPrivateParts(targetOpenid, parts, sendOptions);
      this.cacheOutbound(scope, targetOpenid, parts, result);
      this.emitMessageSent(scope, targetOpenid, parts, result);
      const data: Record<string, unknown> = {
        message_id: this.exposeMsg(result.parts[0]?.messageId ?? ''),
        message_ids: result.parts.map((part) => this.exposeMsg(part.messageId)),
        passive: result.passive,
        quoted: reply.refIdx !== '',
      };
      if (reply.warning !== undefined) data.warning = reply.warning;
      return this.ok(echo, data);
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  /**
   * 回复段 → REFIDX。
   *
   * 官方 message_reference 只接受 REFIDX：非机器人消息取事件的 msg_idx，
   * 机器人自己的消息取发送响应的 ext_info.ref_idx；两者都缓存在消息记录里。
   * 取不到时按普通被动回复发送并回报 warning，不阻塞消息投递。
   */
  private replyReference(replyId: string): { refIdx: string; warning?: string } {
    if (replyId === '') return { refIdx: '' };
    if (replyId.startsWith('REFIDX_')) return { refIdx: replyId };
    const record = this.deps.messageCache.get(replyId);
    if (record === undefined) {
      return { refIdx: '', warning: '引用目标不在本地消息缓存中，已按普通被动回复发送（无引用气泡）' };
    }
    if (record.refIdx === undefined || record.refIdx === '') {
      return { refIdx: '', warning: '该消息未携带官方 REFIDX，已按普通被动回复发送（无引用气泡）' };
    }
    return { refIdx: record.refIdx };
  }

  /** 机器人自己发出的消息也写入缓存：供 delete_msg 撤回与后续引用回复使用。 */
  private cacheOutbound(
    scope: OfficialScope,
    peerOpenid: string,
    parts: readonly OutboundPart[],
    result: SendPartsResult,
  ): void {
    for (let i = 0; i < result.parts.length && i < parts.length; i += 1) {
      const sent = result.parts[i]!;
      const part = parts[i]!;
      if (sent.messageId === '') continue;
      const pseudoId = this.deps.idMode === 'passthrough'
        ? sent.messageId
        : this.deps.mapper.pseudoMsgOf(sent.messageId);
      const segments = this.outboundPartToSegments(part);
      this.deps.messageCache.put(pseudoId, {
        rawMsgId: sent.messageId,
        refIdx: sent.refIdx,
        scope,
        peerOpenid,
        senderOpenid: this.deps.selfOpenid,
        senderName: this.deps.selfNickname,
        segments,
        rawMessage: segmentsToCQ(segments),
        tsMs: Date.now(),
      });
    }
  }

  /** 出站分片 → 可缓存的 OneBot 段（message_sent 事件与 get_msg 共用）。 */
  private outboundPartToSegments(part: OutboundPart): AnyOneBotSegment[] {
    switch (part.kind) {
      case 'media':
        return [{ type: part.mediaType, data: { file: part.file } }];
      case 'markdown': {
        const segments: AnyOneBotSegment[] = [{ type: 'noa_markdown', data: { ...part.markdown } }];
        if (part.keyboard !== undefined) segments.push({ type: 'noa_keyboard', data: part.keyboard });
        return segments;
      }
      case 'card':
        return [{ type: 'noa_card', data: part.card }];
      case 'text': {
        const segments = officialPartsToSegments(parseOfficialContent(part.text), {
          resolve: (openid) => (this.deps.idMode === 'passthrough' ? openid : this.deps.mapper.pseudoOf(openid)),
        });
        if (part.keyboard !== undefined) segments.push({ type: 'noa_keyboard', data: part.keyboard });
        return segments;
      }
    }
  }

  /** OneBot v11 message_sent：机器人发出的消息也向上游广播。 */
  private emitMessageSent(
    scope: OfficialScope,
    targetOpenid: string,
    parts: readonly OutboundPart[],
    result: SendPartsResult,
  ): void {
    const emit = this.deps.emitEvent;
    if (emit === undefined || result.parts.length === 0) return;
    try {
      const segments = parts.flatMap((part) => this.outboundPartToSegments(part));
      const event: Record<string, unknown> = {
        time: Math.floor(Date.now() / 1000),
        self_id: this.selfId(),
        post_type: 'message_sent',
        message_type: scope === 'group' ? 'group' : 'private',
        sub_type: scope === 'group' ? 'normal' : 'friend',
        message_id: this.exposeMsg(result.parts[0]?.messageId ?? ''),
        user_id: this.selfId(),
        target_id: this.expose(targetOpenid),
        message: segments,
        raw_message: segmentsToCQ(segments),
        font: 0,
        sender: { user_id: this.selfId(), nickname: this.deps.selfNickname },
      };
      if (scope === 'group') event.group_id = this.expose(targetOpenid);
      emit(event);
    } catch (err) {
      this.deps.logger.warn(
        `[actions] 投递 message_sent 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // —— 撤回 / 消息缓存 ——

  private async deleteMsg(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法撤回', echo);
    const messageId = String(params.message_id ?? '');
    const record = this.deps.messageCache.get(messageId);
    if (record === undefined) {
      return this.badRequest('消息不在本地缓存中；官方撤回仅支持 2 分钟内的自身消息', echo);
    }
    try {
      await sender.recall(record.scope, record.peerOpenid, record.rawMsgId);
      return this.ok(echo, null);
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  private async getMsg(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const messageId = String(params.message_id ?? '');
    const record = this.deps.messageCache.get(messageId);
    if (record === undefined) return this.badRequest('本地消息缓存中未找到该消息', echo);
    return this.ok(echo, {
      time: Math.floor(record.tsMs / 1000),
      message_type: record.scope === 'group' ? 'group' : 'private',
      message_id: messageId,
      real_id: messageId,
      sender: {
        user_id: this.expose(record.senderOpenid),
        nickname: record.senderName,
        card: record.senderName,
      },
      message: record.segments,
      raw_message: record.rawMessage,
    });
  }

  // —— 信息 ——

  private async getGroupInfo(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}`, echo);
    const entry = this.deps.groupDirectory.get(groupOpenid);
    const official = this.deps.sender === null
      ? null
      : await this.deps.sender.getGroupInfo(groupOpenid);
    if (official === null && entry === undefined) {
      return this.badRequest('群不在本地目录中，且官方群信息接口不可用（需平台白名单权限）', echo);
    }
    return this.ok(echo, {
      group_id: params.group_id,
      group_name: official?.groupName || entry?.alias || entry?.name || '',
      member_count: official?.memberCount ?? 0,
      max_member_count: 0,
      source: official !== null ? 'official' : 'registry',
    });
  }

  private async getGroupMemberInfo(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接', echo);
    const userId = String(params.user_id ?? '');
    if (userId === '') return this.badRequest('get_group_member_info 需要 user_id', echo);
    if (userId === this.selfIdString()) {
      return this.ok(echo, {
        group_id: params.group_id,
        user_id: userId,
        nickname: this.deps.selfNickname,
        card: '',
        role: 'member',
        level: 0,
        title: '',
        join_time: 0,
      });
    }

    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}`, echo);
    const memberOpenid = this.resolveUser(userId);
    if (memberOpenid === null) {
      return this.badRequest(`未知 user_id：${userId}（官方只接受已知 openid）`, echo);
    }
    try {
      const member = await sender.getGroupMember(groupOpenid, memberOpenid);
      return this.ok(echo, {
        group_id: params.group_id,
        user_id: this.expose(member.memberOpenid),
        nickname: member.username,
        card: '',
        role: normalizeRole(member.role),
        level: 0,
        title: '',
        join_time: parseRfc3339Seconds(member.joinedAt),
        is_robot: member.bot === true,
      });
    } catch (err) {
      return this.badRequest(`官方群成员接口不可用（需平台白名单权限）：${errText(err)}`, echo);
    }
  }

  /** 群成员列表：白名单接口，30 条/页；最多拉 20 页（600 人）并告警截断。 */
  private async getGroupMemberList(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接', echo);
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}`, echo);

    const members: GroupMemberSnapshot[] = [];
    const maxPages = 20;
    let cursor: string | undefined;
    let pages = 0;
    try {
      while (true) {
        const page = await sender.listGroupMembers(groupOpenid, cursor);
        members.push(...page.members);
        pages += 1;
        if (page.nextCursor === '') break;
        if (pages >= maxPages) {
          this.deps.logger.warn(
            `[actions] get_group_member_list 超过 ${maxPages * 30} 人，仅返回前 ${members.length} 人（白名单接口 30 条/页）`,
          );
          break;
        }
        cursor = page.nextCursor;
      }
    } catch (err) {
      return this.badRequest(`官方群成员列表接口不可用（需平台白名单权限）：${errText(err)}`, echo);
    }

    return this.ok(echo, members.map((member) => ({
      group_id: params.group_id,
      user_id: this.expose(member.memberOpenid),
      nickname: member.username,
      card: '',
      role: normalizeRole(member.role),
      join_time: parseRfc3339Seconds(member.joinedAt),
      last_sent_time: 0,
      is_robot: member.bot === true,
    })));
  }

  /** 群成员批量移除（白名单）；reject_add_request → 同时加入群黑名单。 */
  private async setGroupKick(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接', echo);
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}`, echo);
    const userId = String(params.user_id ?? '');
    if (userId === '') return this.badRequest('set_group_kick 需要 user_id', echo);
    if (userId === this.selfIdString()) return this.badRequest('不能移除机器人自身', echo);
    const memberOpenid = this.resolveUser(userId);
    if (memberOpenid === null) {
      return this.badRequest(`未知 user_id：${userId}（官方只接受已知 openid）`, echo);
    }
    const addToBlacklist = params.reject_add_request === true;
    try {
      const result = await sender.batchRemoveGroupMembers(groupOpenid, [memberOpenid], addToBlacklist);
      const data: Record<string, unknown> = { removed: true };
      if (addToBlacklist && result.failedBlacklistOpenids.includes(memberOpenid)) {
        data.blacklist_failed = true;
      }
      return this.ok(echo, data);
    } catch (err) {
      return this.badRequest(`官方群成员移除接口不可用（需平台白名单权限）：${errText(err)}`, echo);
    }
  }

  /** get_image / get_record：把官方附件 URL 落到本地缓存并返回路径。 */
  private async getCachedMedia(
    params: Record<string, unknown>,
    echo: unknown,
    label: string,
  ): Promise<OneBotResponse> {
    const cache = this.deps.mediaCache;
    if (cache === undefined || cache === null) {
      return this.badRequest(`${label}本地缓存代理未启用`, echo);
    }
    const file = String(params.file ?? '');
    if (file === '') return this.badRequest(`get_image/get_record 需要 file 参数（附件 URL）`, echo);
    try {
      const result = await cache.fetch(file);
      return this.ok(echo, {
        file: result.path,
        url: file,
        size: result.size,
        cached: result.cached,
      });
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  // —— 群管理（降级/对齐官方 2026.08）——

  private async setGroupBan(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法禁言', echo);
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}`, echo);
    const rawDuration = params.duration;
    const duration = typeof rawDuration === 'number' && Number.isFinite(rawDuration) ? Math.max(0, Math.floor(rawDuration)) : 1800;
    const memberOpenid = this.resolveUser(params.user_id) ?? undefined;
    if (memberOpenid === undefined && params.user_id !== undefined && String(params.user_id) !== '0') {
      return this.badRequest('官方平台只允许对已知成员禁言；该 user_id 不在本地映射中', echo);
    }
    try {
      await sender.setGroupBan(groupOpenid, duration, memberOpenid);
      return this.ok(echo, null);
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  /**
   * 全员禁言：官方禁言接口省略 member_openid 即全群路径。
   * OneBot 标准只有 enable；enable=true 固定 24 小时。
   */
  private async setGroupWholeBan(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法禁言', echo);
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}`, echo);
    if (typeof params.enable !== 'boolean') {
      return this.badRequest('set_group_whole_ban 需要布尔参数 enable', echo);
    }
    try {
      await sender.setGroupBan(groupOpenid, params.enable ? 86_400 : 0);
      return this.ok(echo, null);
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  private async setGroupAddRequest(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法审批', echo);
    const flag = String(params.flag ?? '');
    const parts = flag.split(':');
    if (parts.length < 2 || parts[0] === '') {
      return this.badRequest('flag 无效（缺少必要信息，无法审批入群申请）', echo);
    }
    const groupOpenid = parts[0];
    const approve = params.approve !== false;
    const reason = typeof params.reason === 'string' ? params.reason : '';
    try {
      if (parts.length >= 3) {
        // 新事件/新 flag：group_openid:member_openid:join_request_id（join_request_id 可能含冒号）。
        const memberOpenid = parts[1];
        const joinRequestId = parts.slice(2).join(':');
        if (memberOpenid === '' || joinRequestId === '') {
          return this.badRequest('flag 无效（缺少必要信息，无法审批入群申请）', echo);
        }
        await sender.approveJoinRequest(groupOpenid, memberOpenid, {
          op: approve ? 'approve' : 'decline',
          joinRequestId,
          rejectReason: reason,
        });
      } else {
        // 旧 flag：group_openid:event_seq，保留旧端点兼容；序号不可用时明确失败。
        const eventSeq = parts[1];
        if (!/^\d+$/.test(eventSeq) || eventSeq === '0') {
          return this.badRequest('flag 无效（缺少 join_request_id/member_openid 且事件序号不可用，无法审批）', echo);
        }
        await sender.approveGroupRequest(groupOpenid, eventSeq, approve);
      }
      return this.ok(echo, null);
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  // —— helpers ——

  private ok(echo: unknown, data: unknown): OneBotResponse {
    return { status: 'ok', retcode: RET_OK, data, message: '', echo };
  }

  private badRequest(message: string, echo: unknown): OneBotResponse {
    return this.fail(RET_BAD_REQUEST, message, echo);
  }

  private fail(retcode: number, message: string, echo: unknown): OneBotResponse {
    return { status: 'failed', retcode, data: null, message, echo };
  }

  private selfIdString(): string {
    return this.deps.idMode === 'passthrough'
      ? this.deps.selfOpenid
      : this.deps.mapper.selfPseudo(this.deps.selfOpenid);
  }

  private selfId(): number | string {
    const raw = this.selfIdString();
    return this.deps.idMode === 'passthrough' ? raw : Number(raw);
  }

  private expose(openid: string): number | string {
    if (openid === '') return 0;
    return this.deps.idMode === 'passthrough' ? openid : Number(this.deps.mapper.pseudoOf(openid));
  }

  private exposeMsg(rawMsgId: string): number | string {
    if (rawMsgId === '') return 0;
    return this.deps.idMode === 'passthrough' ? rawMsgId : Number(this.deps.mapper.pseudoMsgOf(rawMsgId));
  }

  private resolveGroup(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    const id = String(raw);
    if (id === '') return null;
    if (this.deps.idMode === 'passthrough') return id;
    return this.deps.mapper.openidOf(id);
  }

  private resolveUser(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    const id = String(raw);
    if (id === '') return null;
    if (this.deps.idMode === 'passthrough') return id;
    return this.deps.mapper.openidOf(id);
  }
}

function paramMessage(params: Record<string, unknown>): unknown {
  return params.message;
}

function normalizeMessage(message: unknown): AnyOneBotSegment[] {
  if (typeof message === 'string') return cqToSegments(message);
  if (Array.isArray(message)) return message as AnyOneBotSegment[];
  if (typeof message === 'object' && message !== null) return [message as AnyOneBotSegment];
  return [];
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const record = err as Error & { bizCode?: number; bizMessage?: string };
    const code = record.bizCode;
    return code === undefined ? err.message : `${err.message}（平台错误码 ${code}）`;
  }
  return String(err);
}

/** 官方 member_role → OneBot role。 */
function normalizeRole(role: string): 'owner' | 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? role : 'member';
}

/** 官方 RFC3339 入群时间 → Unix 秒；缺失或非法返回 0。 */
function parseRfc3339Seconds(value?: string): number {
  if (value === undefined || value === '') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}
