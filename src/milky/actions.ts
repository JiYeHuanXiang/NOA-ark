/**
 * Milky v1.3 Action 路由。
 *
 * 复用 OneBot 层的 MessageSender 抽象；响应结构：
 *   { status: 'ok' | 'failed', retcode, data, message? }
 * retcode 约定：0 成功 / -400 参数错误 / -403 未登录 / -404 API 不存在。
 */

import {
  onebotToMilkySegments,
  milkyToOnebotSegments,
  type AnyMilkySegment,
  type MilkySegment,
} from '../core/segments.js';
import type { MessageCacheLike, MessageSender } from '../onebot/actions.js';

export interface MilkyResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
}

export interface MilkyDeps {
  sender: MessageSender | null;
  messageCache: MessageCacheLike;
  idMode: 'mapped' | 'passthrough';
  mapper: { pseudoOf(openid: string): string; openidOf(pseudo: string): string | null; pseudoMsgOf(rawId: string): string; rawMsgOf(pseudo: string): string | null; selfPseudo(appId: string): string };
  selfOpenid: string;
  selfNickname: string;
}

const IMPL_INFO = {
  impl_name: 'noa-ark',
  impl_version: '0.1.0',
  qq_protocol_version: 'v2',
  qq_protocol_type: 'windows',
  milky_version: '1.3',
};

export class MilkyActionRouter {
  constructor(private readonly deps: MilkyDeps) {}

  async dispatch(api: string, params: Record<string, unknown>): Promise<MilkyResponse> {
    switch (api) {
      case 'send_private_message':
        return this.sendMessage('friend', params);
      case 'send_group_message':
        return this.sendMessage('group', params);
      case 'recall_private_message':
        return this.recall('friend', params);
      case 'recall_group_message':
        return this.recall('group', params);
      case 'get_message':
        return this.getMessage(params);
      case 'get_history_messages':
        return this.failed(-400, 'noa-ark 暂无历史消息回溯能力（官方平台无历史 API，本地缓存有限）');
      case 'get_resource_temp_url':
        return this.failed(-400, '资源临时链接暂无（二期）');
      case 'get_forwarded_messages':
        return this.failed(-404, '官方平台无合并转发 API');
      case 'mark_message_as_read':
        return this.ok({});
      case 'get_login_info':
        return this.ok({ uin: this.selfId(), nickname: this.deps.selfNickname });
      case 'get_impl_info':
        return this.ok(IMPL_INFO);
      case 'set_group_member_mute': {
        const sender = this.requireSender();
        if (sender === null) return this.failed(-403, '机器人尚未连接');
        const groupOpenid = this.resolveGroup(params.group_id);
        if (groupOpenid === null) return this.failed(-400, '未知 group_id');
        const memberOpenid = this.resolveUser(params.user_id);
        if (memberOpenid === null) {
          return this.failed(-400, '未知 user_id；无法定位成员时拒绝执行禁言（避免误伤全群）');
        }
        const duration = typeof params.duration === 'number' && Number.isFinite(params.duration)
          ? Math.max(0, Math.floor(params.duration))
          : 0;
        try {
          await sender.setGroupBan(groupOpenid, duration, memberOpenid);
          return this.ok({});
        } catch (err) {
          return this.failed(-400, err instanceof Error ? err.message : String(err));
        }
      }
      case 'set_group_whole_mute': {
        const sender = this.requireSender();
        if (sender === null) return this.failed(-403, '机器人尚未连接');
        const groupOpenid = this.resolveGroup(params.group_id);
        if (groupOpenid === null) return this.failed(-400, '未知 group_id');
        const isMute = params.is_mute !== false;
        try {
          await sender.setGroupBan(groupOpenid, isMute ? 86_400 : 0);
          return this.ok({});
        } catch (err) {
          return this.failed(-400, err instanceof Error ? err.message : String(err));
        }
      }
      case 'accept_group_request':
      case 'reject_group_request': {
        const sender = this.requireSender();
        if (sender === null) return this.failed(-403, '机器人尚未连接');
        const groupOpenid = this.resolveGroup(params.group_id);
        if (groupOpenid === null) return this.failed(-400, '未知 group_id');
        const seq = params.notification_seq;
        if (seq === undefined) return this.failed(-400, '缺少 notification_seq');
        try {
          await sender.approveGroupRequest(groupOpenid, String(seq), api === 'accept_group_request');
          return this.ok({});
        } catch (err) {
          return this.failed(-400, err instanceof Error ? err.message : String(err));
        }
      }
      default:
        return this.failed(-404, `Milky API ${api} 不存在或官方平台无对应能力`);
    }
  }

  private async sendMessage(scene: 'friend' | 'group', params: Record<string, unknown>): Promise<MilkyResponse> {
    const sender = this.requireSender();
    if (sender === null) return this.failed(-403, '机器人尚未连接');
    const rawSegments = Array.isArray(params.message) ? (params.message as AnyMilkySegment[]) : [];
    const converted = milkyToOnebotSegments(rawSegments);
    if (!converted.ok) return this.failed(-400, converted.reason);
    const segments = converted.segments;
    const text = segments
      .map((s) => (s.type === 'text' ? s.data.text : ''))
      .join('');
    if (text.trim() === '') return this.failed(-400, '一期仅支持纯文本消息（富媒体发送二期）');

    if (scene === 'group') {
      const groupOpenid = this.resolveGroup(params.group_id);
      if (groupOpenid === null) return this.failed(-400, '未知 group_id');
      try {
        const r = await sender.sendGroupText(groupOpenid, text);
        return this.ok({ message_seq: this.toSeq(r.messageId), time: Math.floor(Date.now() / 1000) });
      } catch (err) {
        return this.failed(-400, err instanceof Error ? err.message : String(err));
      }
    }
    const userOpenid = this.resolveUser(params.user_id);
    if (userOpenid === null) return this.failed(-400, '未知 user_id');
    try {
      const r = await sender.sendPrivateText(userOpenid, text);
      return this.ok({ message_seq: this.toSeq(r.messageId), time: Math.floor(Date.now() / 1000) });
    } catch (err) {
      return this.failed(-400, err instanceof Error ? err.message : String(err));
    }
  }

  private async recall(scene: 'friend' | 'group', params: Record<string, unknown>): Promise<MilkyResponse> {
    const sender = this.requireSender();
    if (sender === null) return this.failed(-403, '机器人尚未连接');
    const seq = params.message_seq;
    if (seq === undefined) return this.failed(-400, '缺少 message_seq');
    const record = this.deps.messageCache.get(String(seq));
    if (record === undefined) return this.failed(-400, '消息不在本地缓存中');
    try {
      await sender.recall(record.scope, record.peerOpenid, record.rawMsgId);
      return this.ok({});
    } catch (err) {
      return this.failed(-400, err instanceof Error ? err.message : String(err));
    }
  }

  private async getMessage(params: Record<string, unknown>): Promise<MilkyResponse> {
    const seq = params.message_seq;
    if (seq === undefined) return this.failed(-400, '缺少 message_seq');
    const record = this.deps.messageCache.get(String(seq));
    if (record === undefined) return this.failed(-400, '消息不在本地缓存中');
    const converted = onebotToMilkySegments(record.segments);
    const segments: MilkySegment[] = converted.ok
      ? converted.segments
      : [{ type: 'text', data: { text: record.rawMessage } }];
    return this.ok({
      message: {
        message_scene: record.scope === 'group' ? 'group' : 'friend',
        peer_id: this.expose(record.peerOpenid),
        message_seq: this.seqValue(seq),
        sender_id: this.expose(record.senderOpenid),
        time: Math.floor(record.tsMs / 1000),
        segments,
      },
    });
  }

  private requireSender(): MessageSender | null {
    return this.deps.sender;
  }

  private resolveGroup(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    const id = String(raw);
    if (id === '') return null;
    return this.deps.idMode === 'passthrough' ? id : this.deps.mapper.openidOf(id);
  }

  private resolveUser(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    const id = String(raw);
    if (id === '') return null;
    return this.deps.idMode === 'passthrough' ? id : this.deps.mapper.openidOf(id);
  }

  private expose(openid: string): number | string {
    if (openid === '') return 0;
    return this.deps.idMode === 'passthrough' ? openid : Number(this.deps.mapper.pseudoOf(openid));
  }

  private toSeq(rawMsgId: string): number | string {
    if (rawMsgId === '') return 0;
    return this.deps.idMode === 'passthrough' ? rawMsgId : Number(this.deps.mapper.pseudoMsgOf(rawMsgId));
  }

  /** 缓存键已经是暴露后的 message_seq，不能再走 pseudoMsgOf 二次映射。 */
  private seqValue(value: unknown): number | string {
    const raw = String(value);
    return this.deps.idMode === 'passthrough' ? raw : Number(raw);
  }

  private selfId(): number | string {
    const raw = this.deps.idMode === 'passthrough'
      ? this.deps.selfOpenid
      : this.deps.mapper.selfPseudo(this.deps.selfOpenid);
    return this.deps.idMode === 'passthrough' ? raw : Number(raw);
  }

  private ok(data: unknown): MilkyResponse {
    return { status: 'ok', retcode: 0, data };
  }

  private failed(retcode: number, message: string): MilkyResponse {
    return { status: 'failed', retcode, data: {}, message };
  }
}
