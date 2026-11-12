/**
 * noa/1 扩展动作路由（文档 §5 / §6）。
 *
 * 只处理 `noa_` 前缀的动作；非 noa 动作返回 null，由 OneBotActionRouter 继续处理。
 * 扩展未启用 / 场景不支持 → 1404；参数非法 / 平台调用失败 → 1400（message 带平台错误码）。
 */

import type { NoaConf, NoaExtConf } from '../config.js';
import type { IdMapper } from '../core/idmap.js';
import type { OneBotResponse } from '../onebot/actions.js';
import type { NoaExtensionService } from './service.js';

const RET_OK = 0;
const RET_BAD_REQUEST = 1400;
const RET_UNSUPPORTED = 1404;

export interface NoaRouterDeps {
  conf: NoaConf;
  service: NoaExtensionService | null;
  mapper: IdMapper;
  idMode: 'mapped' | 'passthrough';
  logger: { warn(message: string): void };
}

export class NoaActionRouter {
  constructor(private readonly deps: NoaRouterDeps) {}

  /** 非 noa 动作返回 null；noa 动作返回完整 OneBot 响应。 */
  async dispatch(
    action: string,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse | null> {
    if (!action.startsWith('noa_')) return null;
    const service = this.deps.service;
    if (service === null) {
      return this.fail(RET_UNSUPPORTED, '机器人尚未连接，noa 扩展不可用', echo);
    }
    switch (action) {
      case 'noa_send_typing':
        return this.sendTyping(service, params, echo);
      case 'noa_ack_interaction':
        return this.ackInteraction(service, params, echo);
      case 'noa_set_menu':
        return this.setMenu(service, params, echo);
      case 'noa_set_panel':
        return this.setPanel(service, params, echo);
      case 'noa_list_panels':
        return this.listPanels(service, params, echo);
      case 'noa_set_group_add_request_policy':
        return this.setJoinPolicy(service, params, echo);
      case 'noa_stream_begin':
        return this.streamBegin(service, params, echo);
      case 'noa_stream_append':
        return this.streamAppend(service, params, echo);
      case 'noa_stream_end':
        return this.streamEnd(service, params, echo);
      case 'noa_send_wakeup':
        return this.sendWakeup(service, params, echo);
      default:
        return this.fail(RET_UNSUPPORTED, `noa 扩展动作 ${action} 不存在或未实现（见 文档）`, echo);
    }
  }

  // —— 单聊正在输入 ——

  private async sendTyping(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('typing', echo);
    if (denied !== null) return denied;
    if (params.group_id !== undefined) {
      return this.fail(RET_UNSUPPORTED, 'noa_send_typing 仅支持单聊；官方群聊不支持「正在输入」', echo);
    }
    const userOpenid = this.resolveUser(params.user_id);
    if (userOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 user_id：${String(params.user_id ?? '')}`, echo);
    const seconds = typeof params.seconds === 'number' && Number.isFinite(params.seconds)
      ? params.seconds
      : 8;
    try {
      const result = await service.sendTyping('c2c', userOpenid, seconds);
      return this.ok(echo, { sent: true, passive: result.passive, seconds: result.seconds });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— 互动回应 ——

  private async ackInteraction(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('interaction', echo);
    if (denied !== null) return denied;
    const interactionId = stringOf(params.interaction_id);
    if (interactionId === '') return this.fail(RET_BAD_REQUEST, 'noa_ack_interaction 需要 interaction_id', echo);
    const rawCode = params.code;
    const code = rawCode === undefined ? 0 : Number(rawCode);
    if (!Number.isInteger(code) || code < 0 || code > 5) {
      return this.fail(RET_BAD_REQUEST, 'code 必须是 0–5 的整数（0 成功 / 1 失败 / 2 频繁 / 3 重复 / 4 无权限 / 5 仅管理员）', echo);
    }
    try {
      await service.ackInteraction(interactionId, code);
      return this.ok(echo, null);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— 菜单 / 面板 ——

  private async setMenu(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    if (!isRecord(params.menu)) return this.fail(RET_BAD_REQUEST, 'noa_set_menu 需要 menu 对象', echo);
    try {
      const result = await service.setMenu(params.menu);
      return this.ok(echo, { version: result.version ?? 0 });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async setPanel(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    if (!isRecord(params.panel)) return this.fail(RET_BAD_REQUEST, 'noa_set_panel 需要 panel 对象', echo);
    try {
      return this.ok(echo, await service.createPanel(params.panel));
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async listPanels(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    const scope = params.scope;
    if (scope !== 'c2c' && scope !== 'group') {
      return this.fail(RET_BAD_REQUEST, 'noa_list_panels 需要 scope=c2c 或 group（官方必填）', echo);
    }
    let limit: number | undefined;
    if (params.limit !== undefined) {
      if (typeof params.limit !== 'number' || !Number.isFinite(params.limit) || params.limit <= 0) {
        return this.fail(RET_BAD_REQUEST, 'limit 必须是正整数', echo);
      }
      limit = Math.floor(params.limit);
    }
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : undefined;
    try {
      return this.ok(echo, await service.listPanels(scope, cursor, limit));
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— 入群自动审批策略 ——

  private async setJoinPolicy(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('joinPolicy', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);

    const enable = typeof params.enable === 'boolean' ? params.enable : undefined;
    const expireAt = typeof params.expire_at === 'string' && params.expire_at !== '' ? params.expire_at : undefined;
    const remark = typeof params.remark === 'string' && params.remark !== '' ? params.remark : undefined;
    const whitelistUsers = Array.isArray(params.whitelist_users)
      ? params.whitelist_users.map((item) => stringOf(item)).filter((item) => item !== '')
      : undefined;
    const rawOp = params.whitelist_op;
    if (rawOp !== undefined && rawOp !== 'add' && rawOp !== 'del') {
      return this.fail(RET_BAD_REQUEST, 'whitelist_op 只能是 add 或 del', echo);
    }
    const execute = params.execute === true;
    if (
      enable === undefined
      && expireAt === undefined
      && remark === undefined
      && (whitelistUsers === undefined || whitelistUsers.length === 0)
      && !execute
    ) {
      return this.fail(
        RET_BAD_REQUEST,
        'noa_set_group_add_request_policy 至少需要 enable / expire_at / remark / whitelist_users / execute 之一',
        echo,
      );
    }

    try {
      const result = await service.setJoinPolicy({
        groupOpenid,
        enable,
        expireAt,
        remark,
        whitelistUsers,
        whitelistOp: rawOp === 'del' ? 'del' : 'add',
        execute,
      });
      return this.ok(echo, result);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— 单聊流式 ——

  private async streamBegin(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('stream', echo);
    if (denied !== null) return denied;
    if (params.group_id !== undefined) {
      return this.fail(RET_UNSUPPORTED, '官方群聊不支持流式消息（仅单聊）', echo);
    }
    const userOpenid = this.resolveUser(params.user_id);
    if (userOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 user_id：${String(params.user_id ?? '')}`, echo);
    const content = stringOf(params.content);
    if (content.trim() === '') return this.fail(RET_BAD_REQUEST, 'noa_stream_begin 需要非空 content', echo);

    const rawType = params.content_type;
    if (rawType !== undefined && rawType !== 'text' && rawType !== 'markdown') {
      return this.fail(RET_BAD_REQUEST, 'content_type 只能是 text 或 markdown', echo);
    }
    const rawMode = params.input_mode;
    if (rawMode !== undefined && rawMode !== 'append' && rawMode !== 'replace') {
      return this.fail(RET_BAD_REQUEST, 'input_mode 只能是 append 或 replace', echo);
    }
    if (params.ref_idx !== undefined && params.ref_idx !== '') {
      return this.fail(RET_BAD_REQUEST, '官方流式消息接口没有引用参数（ref_idx），请移除后重试', echo);
    }

    try {
      const result = await service.streamBegin(userOpenid, {
        content,
        contentType: rawType === 'text' ? 'text' : 'markdown',
        inputMode: rawMode === 'append' ? 'append' : 'replace',
        isWakeup: params.is_wakeup === true,
      });
      return this.ok(echo, {
        stream_id: result.streamId,
        index: result.index,
        remain_msg_len: result.remainMsgLen,
        passive: result.passive,
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async streamAppend(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('stream', echo);
    if (denied !== null) return denied;
    const streamId = stringOf(params.stream_id);
    if (streamId === '') return this.fail(RET_BAD_REQUEST, 'noa_stream_append 需要 stream_id', echo);
    const content = stringOf(params.content);
    if (content === '') return this.fail(RET_BAD_REQUEST, 'noa_stream_append 需要非空 content', echo);
    try {
      const result = await service.streamAppend(streamId, content);
      return this.ok(echo, {
        stream_id: result.streamId,
        index: result.index,
        remain_msg_len: result.remainMsgLen,
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async streamEnd(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('stream', echo);
    if (denied !== null) return denied;
    const streamId = stringOf(params.stream_id);
    if (streamId === '') return this.fail(RET_BAD_REQUEST, 'noa_stream_end 需要 stream_id', echo);
    const content = params.content === undefined ? undefined : stringOf(params.content);
    try {
      const result = await service.streamEnd(streamId, content);
      return this.ok(echo, {
        stream_id: result.streamId,
        remain_msg_len: result.remainMsgLen,
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— 互动召回 ——

  private async sendWakeup(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('wakeup', echo);
    if (denied !== null) return denied;
    if (params.group_id !== undefined) {
      return this.fail(RET_UNSUPPORTED, '官方群聊不支持互动召回（is_wakeup 仅单聊）', echo);
    }
    const userOpenid = this.resolveUser(params.user_id);
    if (userOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 user_id：${String(params.user_id ?? '')}`, echo);
    const message = stringOf(params.message);
    if (message.trim() === '') return this.fail(RET_BAD_REQUEST, 'noa_send_wakeup 需要非空 message', echo);
    try {
      await service.sendWakeup(userOpenid, message);
      return this.ok(echo, { sent: true });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— helpers ——

  private requireExt(key: keyof NoaExtConf, echo: unknown): OneBotResponse | null {
    if (this.deps.conf.ext[key]) return null;
    return this.fail(
      RET_UNSUPPORTED,
      `noa 扩展「${key}」未启用（见 文档；配置 noa.ext.${key}=true 后启用）`,
      echo,
    );
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

  private ok(echo: unknown, data: unknown): OneBotResponse {
    return { status: 'ok', retcode: RET_OK, data, message: '', echo };
  }

  private fail(retcode: number, message: string, echo: unknown): OneBotResponse {
    return { status: 'failed', retcode, data: null, message, echo };
  }
}

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const record = err as Error & { bizCode?: number };
    const code = record.bizCode;
    return code === undefined ? err.message : `${err.message}（平台错误码 ${code}）`;
  }
  return String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
