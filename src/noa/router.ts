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
      case 'noa_get_menu':
        return this.getMenu(service, echo);
      case 'noa_set_panel':
        return this.setPanel(service, params, echo);
      case 'noa_list_panels':
        return this.listPanels(service, params, echo);
      case 'noa_get_panel':
        return this.getPanel(service, params, echo);
      case 'noa_update_panel':
        return this.updatePanel(service, params, echo);
      case 'noa_delete_panel':
        return this.deletePanel(service, params, echo);
      case 'noa_set_panel_target':
        return this.setPanelTarget(service, params, echo);
      case 'noa_set_group_add_request_policy':
        return this.setJoinPolicy(service, params, echo);
      case 'noa_list_join_requests':
        return this.listJoinRequests(service, params, echo);
      case 'noa_handle_join_request':
        return this.handleJoinRequest(service, params, echo);
      case 'noa_list_join_policies':
        return this.listJoinPolicies(service, params, echo);
      case 'noa_delete_join_policy':
        return this.deleteJoinPolicy(service, params, echo);
      case 'noa_get_mute_state':
        return this.getMuteState(service, params, echo);
      case 'noa_set_member_mutes':
        return this.setMemberMutes(service, params, echo);
      case 'noa_list_blacklist':
        return this.listBlacklist(service, params, echo);
      case 'noa_update_blacklist':
        return this.updateBlacklist(service, params, echo);
      case 'noa_get_group_bot_state':
        return this.getGroupBotState(service, params, echo);
      case 'noa_upload_media_image':
        return this.uploadMediaImage(service, params, echo);
      case 'noa_list_media_images':
        return this.listMediaImages(service, params, echo);
      case 'noa_delete_media_image':
        return this.deleteMediaImage(service, params, echo);
      case 'noa_generate_url_link':
        return this.generateUrlLink(service, params, echo);
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
      if (limit > 50) return this.fail(RET_BAD_REQUEST, 'limit 不能超过 50（官方上限）', echo);
    }
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : undefined;
    try {
      return this.ok(echo, await service.listPanels(scope, cursor, limit));
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async getMenu(service: NoaExtensionService, echo: unknown): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    try {
      return this.ok(echo, await service.getMenu());
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async getPanel(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    const panelId = stringOf(params.panel_id);
    if (panelId === '') return this.fail(RET_BAD_REQUEST, 'noa_get_panel 需要 panel_id', echo);
    try {
      return this.ok(echo, await service.getPanel(panelId));
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async updatePanel(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    const panelId = stringOf(params.panel_id);
    if (panelId === '') return this.fail(RET_BAD_REQUEST, 'noa_update_panel 需要 panel_id', echo);
    if (!isRecord(params.panel)) return this.fail(RET_BAD_REQUEST, 'noa_update_panel 需要 panel 对象', echo);
    try {
      const result = await service.updatePanel(panelId, params.panel);
      return this.ok(echo, { version: result.version ?? 0 });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async deletePanel(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    const panelId = stringOf(params.panel_id);
    if (panelId === '') return this.fail(RET_BAD_REQUEST, 'noa_delete_panel 需要 panel_id', echo);
    try {
      await service.deletePanel(panelId);
      return this.ok(echo, null);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async setPanelTarget(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('menu', echo);
    if (denied !== null) return denied;
    const panelId = stringOf(params.panel_id);
    if (panelId === '') return this.fail(RET_BAD_REQUEST, 'noa_set_panel_target 需要 panel_id', echo);
    if (params.op !== 'add' && params.op !== 'del') {
      return this.fail(RET_BAD_REQUEST, 'op 只能是 add 或 del', echo);
    }

    const userOpenids = stringList(params.user_openids);
    const groupOpenids = stringList(params.group_openids);
    const mappedUserIds = stringList(params.user_ids);
    const resolvedUsers: string[] = [...userOpenids];
    for (const raw of mappedUserIds) {
      const openid = this.resolveUser(raw);
      if (openid === null) return this.fail(RET_BAD_REQUEST, `未知 user_id：${raw}`, echo);
      resolvedUsers.push(openid);
    }
    const hasUsers = resolvedUsers.length > 0;
    const hasGroups = groupOpenids.length > 0;
    if (hasUsers === hasGroups) {
      return this.fail(RET_BAD_REQUEST, 'noa_set_panel_target 需要 user_openids/user_ids 或 group_openids 之一', echo);
    }
    if (resolvedUsers.length > 20 || groupOpenids.length > 20) {
      return this.fail(RET_BAD_REQUEST, '关联对象单次最多 20 个（官方上限）', echo);
    }
    try {
      await service.setPanelTarget(panelId, params.op, {
        ...(hasUsers ? { userOpenids: resolvedUsers } : {}),
        ...(hasGroups ? { groupOpenids } : {}),
      });
      return this.ok(echo, null);
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

  // —— 群管理：入群申请 / 禁言 / 黑名单 / 策略（P7.2）——

  private async listJoinRequests(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('joinPolicy', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    const page = this.parsePage(params, 50, echo);
    if (typeof page === 'string') return this.fail(RET_BAD_REQUEST, page, echo);
    try {
      const result = await service.listJoinRequests(groupOpenid, page.cursor, page.limit);
      return this.ok(echo, {
        list: result.list.map((item) => ({
          ...item,
          user_id: this.exposeId(stringOf(item.member_openid)),
        })),
        next_cursor: result.nextCursor,
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async handleJoinRequest(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('joinPolicy', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    const memberOpenid = this.resolveMember(params.member_openid ?? params.user_id);
    if (memberOpenid === null) return this.fail(RET_BAD_REQUEST, 'noa_handle_join_request 需要 member_openid 或 user_id', echo);
    const op = params.op;
    if (op !== 'approve' && op !== 'decline') {
      return this.fail(RET_BAD_REQUEST, 'op 只能是 approve 或 decline', echo);
    }
    const rejectReason = typeof params.reject_reason === 'string' ? params.reject_reason : '';
    const addToBlacklist = params.add_to_member_blacklist === true;
    if (op === 'approve' && (rejectReason !== '' || addToBlacklist)) {
      return this.fail(RET_BAD_REQUEST, 'reject_reason / add_to_member_blacklist 仅 op=decline 时可用', echo);
    }
    const joinRequestId = stringOf(params.join_request_id);
    try {
      await service.handleJoinRequest(groupOpenid, memberOpenid, {
        op,
        joinRequestId,
        rejectReason,
        addToMemberBlacklist: addToBlacklist,
      });
      return this.ok(echo, null);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async listJoinPolicies(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('joinPolicy', echo);
    if (denied !== null) return denied;
    const page = this.parsePage(params, 50, echo);
    if (typeof page === 'string') return this.fail(RET_BAD_REQUEST, page, echo);
    try {
      const result = await service.listJoinPolicies(page.cursor, page.limit);
      return this.ok(echo, { strategies: result.strategies, next_cursor: result.nextCursor });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async deleteJoinPolicy(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('joinPolicy', echo);
    if (denied !== null) return denied;
    const strategyId = stringOf(params.strategy_id);
    if (strategyId === '') return this.fail(RET_BAD_REQUEST, 'noa_delete_join_policy 需要 strategy_id', echo);
    try {
      await service.deleteJoinPolicy(strategyId);
      return this.ok(echo, null);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async getMuteState(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('groupAdmin', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    try {
      const result = await service.getMuteState(groupOpenid);
      const members = Array.isArray(result.members) ? result.members : [];
      return this.ok(echo, {
        global_rule: result.global_rule,
        members: members.map((member) => {
          const record = isRecord(member) ? member : {};
          return {
            ...record,
            user_id: this.exposeId(stringOf(record.member_openid)),
          };
        }),
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async setMemberMutes(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('groupAdmin', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    const rawMembers = params.members;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      return this.fail(RET_BAD_REQUEST, 'noa_set_member_mutes 需要非空 members 数组', echo);
    }
    if (rawMembers.length > 20) {
      return this.fail(RET_BAD_REQUEST, 'members 单次最多 20 个（官方上限）', echo);
    }

    const members: Array<{ op: 'add' | 'update' | 'del'; memberOpenid: string; muteExpireAt?: string }> = [];
    for (const [index, raw] of rawMembers.entries()) {
      const prefix = `members 第 ${index + 1} 项`;
      if (!isRecord(raw)) return this.fail(RET_BAD_REQUEST, `${prefix}必须是对象`, echo);
      const op = raw.op;
      if (op !== 'add' && op !== 'update' && op !== 'del') {
        return this.fail(RET_BAD_REQUEST, `${prefix} op 只能是 add / update / del`, echo);
      }
      const memberOpenid = this.resolveMember(raw.member_openid ?? raw.user_id);
      if (memberOpenid === null) return this.fail(RET_BAD_REQUEST, `${prefix}缺少 member_openid 或 user_id`, echo);
      const expireAt = typeof raw.mute_expire_at === 'string' ? raw.mute_expire_at : '';
      if (op !== 'del' && expireAt === '') {
        return this.fail(RET_BAD_REQUEST, `${prefix} add/update 需要 mute_expire_at（RFC3339）`, echo);
      }
      members.push({
        op,
        memberOpenid,
        ...(expireAt === '' ? {} : { muteExpireAt: expireAt }),
      });
    }

    try {
      await service.setMemberMutes(groupOpenid, members);
      return this.ok(echo, null);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async listBlacklist(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('groupAdmin', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    const page = this.parsePage(params, 100, echo);
    if (typeof page === 'string') return this.fail(RET_BAD_REQUEST, page, echo);
    try {
      const result = await service.listBlacklist(groupOpenid, page.cursor, page.limit);
      return this.ok(echo, {
        users: result.users.map((user) => ({
          ...user,
          user_id: this.exposeId(stringOf(user.member_openid)),
        })),
        next_cursor: result.nextCursor,
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async updateBlacklist(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('groupAdmin', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    if (params.op !== 'add' && params.op !== 'del') {
      return this.fail(RET_BAD_REQUEST, 'op 只能是 add 或 del', echo);
    }

    const rawOpenids = stringList(params.member_openids);
    const mappedIds = stringList(params.user_ids);
    const openids: string[] = [...rawOpenids];
    const exposedByOpenid = new Map<string, number | string>();
    for (const raw of rawOpenids) exposedByOpenid.set(raw, raw);
    for (const raw of mappedIds) {
      const openid = this.resolveUser(raw);
      if (openid === null) return this.fail(RET_BAD_REQUEST, `未知 user_id：${raw}`, echo);
      openids.push(openid);
      exposedByOpenid.set(openid, Number.isNaN(Number(raw)) ? raw : Number(raw));
    }
    if (openids.length === 0) {
      return this.fail(RET_BAD_REQUEST, 'noa_update_blacklist 需要 member_openids 或 user_ids', echo);
    }
    if (openids.length > 20) {
      return this.fail(RET_BAD_REQUEST, 'member_openids 单次最多 20 个（官方上限）', echo);
    }

    try {
      const result = await service.updateBlacklist(groupOpenid, params.op, openids);
      return this.ok(echo, {
        fail_openids: result.failedOpenids,
        fail_user_ids: result.failedOpenids.map((openid) => exposedByOpenid.get(openid) ?? openid),
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async getGroupBotState(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('groupAdmin', echo);
    if (denied !== null) return denied;
    const groupOpenid = this.resolveGroup(params.group_id);
    if (groupOpenid === null) return this.fail(RET_BAD_REQUEST, `未知 group_id：${String(params.group_id ?? '')}`, echo);
    try {
      const result = await service.getGroupBotState(groupOpenid);
      const memberOpenid = stringOf(result.member_openid);
      return this.ok(echo, {
        ...result,
        ...(memberOpenid === '' ? {} : { user_id: this.exposeId(memberOpenid) }),
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  // —— 素材 / 分享（P7.3）——

  private async uploadMediaImage(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('material', echo);
    if (denied !== null) return denied;
    const file = typeof params.file === 'string' ? params.file : '';
    if (file === '') return this.fail(RET_BAD_REQUEST, 'noa_upload_media_image 需要 file（URL / 本地路径 / base64://）', echo);
    const fileName = typeof params.file_name === 'string' && params.file_name !== '' ? params.file_name : undefined;
    const contentType = typeof params.content_type === 'string' && params.content_type !== ''
      ? params.content_type
      : undefined;
    try {
      const result = await service.uploadMediaImage(file, { fileName, contentType });
      return this.ok(echo, {
        image_id: result.imageId,
        url: result.url,
        ...(result.ttl === undefined ? {} : { ttl: result.ttl }),
        ...(result.previewUrl === undefined ? {} : { preview_url: result.previewUrl }),
      });
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async listMediaImages(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('material', echo);
    if (denied !== null) return denied;
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : undefined;
    try {
      return this.ok(echo, await service.listMediaImages(cursor));
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async deleteMediaImage(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('material', echo);
    if (denied !== null) return denied;
    const imageId = stringOf(params.image_id);
    if (imageId === '') return this.fail(RET_BAD_REQUEST, 'noa_delete_media_image 需要 image_id', echo);
    try {
      await service.deleteMediaImage(imageId);
      return this.ok(echo, null);
    } catch (err) {
      return this.fail(RET_BAD_REQUEST, errText(err), echo);
    }
  }

  private async generateUrlLink(
    service: NoaExtensionService,
    params: Record<string, unknown>,
    echo: unknown,
  ): Promise<OneBotResponse> {
    const denied = this.requireExt('share', echo);
    if (denied !== null) return denied;
    const callbackData = typeof params.callback_data === 'string' ? params.callback_data : '';
    if (callbackData.length > 32) {
      return this.fail(RET_BAD_REQUEST, 'callback_data 最长 32 字符（官方限制）', echo);
    }
    try {
      return this.ok(echo, await service.generateUrlLink(callbackData));
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

  /**
   * 群成员标识：既接受伪号 user_id，也接受原始 member_openid。
   * mapped 模式下纯数字但不在映射表中的值视为无效伪号。
   */
  private resolveMember(raw: unknown): string | null {
    const id = stringOf(raw);
    if (id === '') return null;
    if (this.deps.idMode === 'passthrough') return id;
    const openid = this.deps.mapper.openidOf(id);
    if (openid !== null) return openid;
    return /^\d+$/.test(id) ? null : id;
  }

  /** openid → OneBot 可见 ID（mapped 伪号 / passthrough 原串）。 */
  private exposeId(openid: string): number | string {
    if (openid === '') return 0;
    return this.deps.idMode === 'passthrough' ? openid : Number(this.deps.mapper.pseudoOf(openid));
  }

  private parsePage(
    params: Record<string, unknown>,
    maxLimit: number,
    _echo: unknown,
  ): { cursor?: string; limit?: number } | string {
    let limit: number | undefined;
    if (params.limit !== undefined) {
      if (typeof params.limit !== 'number' || !Number.isFinite(params.limit) || params.limit <= 0) {
        return 'limit 必须是正整数';
      }
      limit = Math.floor(params.limit);
      if (limit > maxLimit) return `limit 不能超过 ${maxLimit}（官方上限）`;
    }
    const cursor = typeof params.cursor === 'string' && params.cursor !== '' ? params.cursor : undefined;
    return { cursor, limit };
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringOf(item)).filter((item) => item !== '');
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
