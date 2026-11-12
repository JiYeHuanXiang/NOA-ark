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
import { cqToSegments, segmentsToPlainText, type AnyOneBotSegment } from '../core/segments.js';
import type { OfficialScope } from '../types.js';

export interface OneBotResponse {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: unknown;
  message: string;
  echo?: unknown;
}

/** 发送/管理能力抽象：由桥接层实现（官方 REST + 被动窗口 + 配额）。 */
export interface MessageSender {
  sendGroupText(groupOpenid: string, text: string): Promise<{ messageId: string; passive: boolean }>;
  sendPrivateText(userOpenid: string, text: string): Promise<{ messageId: string; passive: boolean }>;
  recall(scope: OfficialScope, targetOpenid: string, rawMsgId: string): Promise<void>;
  setGroupBan(groupOpenid: string, muteSeconds: number, memberOpenid?: string): Promise<void>;
  approveGroupRequest(groupOpenid: string, requestId: string, approve: boolean): Promise<void>;
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
}

const RET_OK = 0;
const RET_ASYNC = 1;
const RET_BAD_REQUEST = 1400;
const RET_UNSUPPORTED = 1404;

const UNSUPPORTED_ACTIONS: Record<string, string> = {
  get_friend_list: '官方平台无好友列表 API',
  get_stranger_info: '官方平台无陌生人信息 API',
  get_group_member_list: '官方平台无群成员列表 API',
  set_group_kick: '官方群机器人无踢人 API',
  set_group_admin: '官方群机器人无管理员任免 API',
  set_group_card: '官方群机器人无群名片 API',
  set_group_special_title: '官方群机器人无专属头衔 API',
  set_group_anonymous: '官方群机器人无匿名消息能力',
  set_group_anonymous_ban: '官方群机器人无匿名成员禁言 API',
  set_group_leave: '官方群机器人无主动退群 API',
  set_group_whole_ban: '官方群机器人无全员禁言 API（一期未对齐）',
  set_group_name: '官方群机器人无改群名 API',
  send_like: '官方平台无名片点赞 API',
  get_group_honor_info: '官方平台无群荣誉 API',
  get_cookies: '官方开放平台无 Cookie 体系',
  get_csrf_token: '官方开放平台无 CSRF Token',
  get_credentials: '官方开放平台无 Cookie/CSRF 体系',
  get_forward_msg: '官方平台无合并转发消息获取 API',
  get_image: '本地图片缓存代理未实现（二期）',
  get_record: '本地语音缓存代理未实现（二期）',
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
      case 'get_status':
        return this.ok(echoValue, { online: this.deps.sender !== null, good: this.deps.sender !== null });
      case 'get_version_info':
        return this.ok(echoValue, {
          app_name: 'noa-ark',
          app_version: '0.1.0',
          protocol_version: 'v11',
          id_mode: this.deps.idMode,
        });
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
      case 'get_group_member_info':
        return this.getGroupMemberInfo(params, echoValue);
      case 'set_group_ban':
        return this.setGroupBan(params, echoValue);
      case 'set_group_add_request':
        return this.setGroupAddRequest(params, echoValue);
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
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法发送', echo);
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) {
      return this.badRequest(`未知 group_id：${String(params.group_id ?? '')}（官方无全量群列表，请先让机器人收到该群消息）`, echo);
    }
    const segments = normalizeMessage(paramMessage(params));
    const rejection = rejectUnsupportedSegments(segments);
    if (rejection !== null) return this.badRequest(rejection, echo);
    const text = segmentsToPlainText(segments);
    if (text.trim() === '') return this.badRequest('消息内容为空', echo);
    try {
      const result = await sender.sendGroupText(groupOpenid, text);
      return this.ok(echo, { message_id: this.exposeMsg(result.messageId), passive: result.passive });
    } catch (err) {
      return this.badRequest(errText(err), echo);
    }
  }

  private async sendPrivateMsg(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法发送', echo);
    const userOpenid = this.resolveUser(params.user_id);
    if (userOpenid === null) {
      return this.badRequest(`未知 user_id：${String(params.user_id ?? '')}（官方无好友列表；需先收到该用户消息）`, echo);
    }
    const segments = normalizeMessage(paramMessage(params));
    const rejection = rejectUnsupportedSegments(segments);
    if (rejection !== null) return this.badRequest(rejection, echo);
    const text = segmentsToPlainText(segments);
    if (text.trim() === '') return this.badRequest('消息内容为空', echo);
    try {
      const result = await sender.sendPrivateText(userOpenid, text);
      return this.ok(echo, { message_id: this.exposeMsg(result.messageId), passive: result.passive });
    } catch (err) {
      return this.badRequest(errText(err), echo);
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
    if (entry === undefined) return this.badRequest('群不在目录中', echo);
    return this.ok(echo, {
      group_id: params.group_id,
      group_name: entry.alias ?? entry.name ?? '',
      member_count: 0,
      max_member_count: 0,
    });
  }

  private async getGroupMemberInfo(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const userId = String(params.user_id ?? '');
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
    return {
      status: 'failed',
      retcode: RET_UNSUPPORTED,
      data: null,
      message: '官方平台无群成员信息 API（仅能返回机器人自身）',
      echo,
    };
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

  private async setGroupAddRequest(params: Record<string, unknown>, echo: unknown): Promise<OneBotResponse> {
    const sender = this.deps.sender;
    if (sender === null) return this.badRequest('机器人尚未连接，无法审批', echo);
    const flag = String(params.flag ?? '');
    const sep = flag.indexOf(':');
    if (sep <= 0) return this.badRequest('flag 无效或已过期', echo);
    const groupOpenid = flag.slice(0, sep);
    const requestId = flag.slice(sep + 1);
    const approve = params.approve !== false;
    try {
      await sender.approveGroupRequest(groupOpenid, requestId, approve);
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
    return { status: 'failed', retcode: RET_BAD_REQUEST, data: null, message, echo };
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

function needsRichMedia(segments: AnyOneBotSegment[]): boolean {
  return segments.some((s) => s.type === 'image' || s.type === 'record' || s.type === 'video');
}

const UNSUPPORTED_SEND_TYPES = new Set([
  'json', 'xml', 'music', 'share', 'contact', 'location',
  'rps', 'dice', 'poke', 'shake', 'anonymous', 'forward', 'node',
  'noa_keyboard', 'noa_ark', 'noa_embed',
]);

/**
 * 一期发送能力边界（明确拒绝，不静默降级）：
 *   - 富媒体（图片/语音/视频）需要官方 file_info 上传，二期实现；
 *   - json/xml/卡片/合并转发等官方无对应能力。
 */
function rejectUnsupportedSegments(segments: AnyOneBotSegment[]): string | null {
  for (const segment of segments) {
    if (needsRichMedia([segment])) {
      return '富媒体发送（图片/语音/视频）暂未开放：需要先上传获取官方 file_info（二期）';
    }
    if (UNSUPPORTED_SEND_TYPES.has(segment.type)) {
      return `消息段「${segment.type}」无法经 QQ 官方平台发送（无对应能力）`;
    }
  }
  return null;
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
