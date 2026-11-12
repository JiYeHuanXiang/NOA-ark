/**
 * Rest — QQ 官方开放平台 v2 REST 封装（noa-ark 自研，替代对官方 SDK HTTP 面的依赖）。
 *
 * 能力对齐 文档 §1.2：
 *   - getAppAccessToken（appId + clientSecret）→ access_token，缓存 / 401 自动刷新
 *   - v2 群 / 单聊消息发送（msg_type 0 文本 / 7 富媒体；引用回复 message_reference）
 *   - 富媒体：URL 直传 + ≤5MB 二进制直传（分片上传暂未实现），返回 file_info（含 TTL）
 *   - 群管理：单成员 / 全员禁言、入群审批、群基本信息（需平台白名单）
 *   - 撤回等轻接口
 *
 * 统一域名 https://api.bot.qq.com；沙箱 / 代理可通过 baseUrl 覆盖。
 * 所有方法抛 RestApiError（携带 bizCode 供适配器转译为 OneBot / Milky 响应）。
 */

import type { OfficialScope } from '../types.js';

const DEFAULT_BASE_URL = 'https://api.bot.qq.com';
/** 官方 token 有效期较长；这里保守取 5 分钟提前刷新，避免临界过期。 */
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

export class RestApiError extends Error {
  readonly httpStatus?: number;
  readonly bizCode?: number;
  readonly bizMessage?: string;

  constructor(message: string, opts?: { httpStatus?: number; bizCode?: number; bizMessage?: string }) {
    super(message);
    this.name = 'RestApiError';
    this.httpStatus = opts?.httpStatus;
    this.bizCode = opts?.bizCode;
    this.bizMessage = opts?.bizMessage;
  }
}

/** access_token 缓存：提前 TTL 刷新，避免临界过期。 */
export class TokenCache {
  private accessToken = '';
  private expiresAt = 0;
  private readonly ttlMs: number;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  }

  get valid(): boolean {
    return this.accessToken !== '' && Date.now() < this.expiresAt;
  }

  get token(): string {
    if (!this.valid) throw new RestApiError('access_token 不存在或已过期');
    return this.accessToken;
  }

  set(token: string, ttlMs?: number): void {
    this.accessToken = token;
    this.expiresAt = Date.now() + (ttlMs ?? this.ttlMs);
  }

  invalidate(): void {
    this.accessToken = '';
    this.expiresAt = 0;
  }
}

export interface RestOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  tokenBaseUrl?: string;
  timeoutMs?: number;
  logger?: { debug(message: string): void; warn(message: string): void };
  /** 测试注入：替换全局 fetch。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface SendTextPayload {
  content?: string;
  markdown?: { content: string };
  card?: { type: string; content: Record<string, unknown> };
  keyboard?: Record<string, unknown>;
  msg_type: 0 | 2 | 6 | 7 | 8;
  media?: { file_info: string };
  input_notify?: { input_type: number; input_second: number };
  is_wakeup?: boolean;
  msg_id?: string;
  event_id?: string;
  msg_seq?: number;
  message_reference?: { message_id: string };
}

interface SendResponse {
  id?: string;
  message_ids?: string[];
  ext_info?: { ref_idx?: string };
}

export interface SendTextOptions {
  /** 被动回复：携带消息 id 与序号；省略则为主动消息。 */
  msgId?: string;
  /** 被动回复事件 id（INTERACTION_CREATE / GROUP_ADD_ROBOT 等），与 msgId 二选一。 */
  eventId?: string;
  msgSeq?: number;
  /** 引用回复：被引用消息的 REFIDX（非机器人消息取 message_scene.ext 的 msg_idx）。 */
  refIdx?: string;
  /** 内嵌键盘（keyboard 短形式 {id} 或长形式 {content:{rows}}）。 */
  keyboard?: Record<string, unknown>;
  /** 互动召回（仅单聊；不校验 msg_id/event_id 有效期）。 */
  isWakeup?: boolean;
}

/** 官方群基本信息（/v2/groups/{group_openid}/info）。 */
export interface OfficialGroupInfo {
  groupOpenid: string;
  groupName: string;
  memberCount: number;
  fingerMemo?: string;
}

export interface UploadOptions {
  fileType: 1 | 2 | 3 | 4; // 1 图片 2 视频 3 语音 4 文件
  fileName?: string;
  /** 富媒体总发送内容（可选文本说明）。 */
  content?: string;
}

/** 官方群成员（2026-09-03 白名单接口）。 */
export interface OfficialGroupMember {
  memberOpenid: string;
  username: string;
  /** member / admin / owner */
  role: string;
  bot: boolean;
  joinedAt: string;
  unionOpenid?: string;
}

export interface StreamFrameOptions {
  /** 首帧省略；后续帧携带首帧响应 id。 */
  streamMsgId?: string;
  /** 从 0 开始严格递增。 */
  index: number;
  /** 1 生成中 / 10 结束。 */
  inputState: 1 | 10;
  contentType: 'text' | 'markdown';
  inputMode: 'append' | 'replace';
  content: string;
  msgId?: string;
  eventId?: string;
  msgSeq?: number;
  /** 互动召回：不校验 msg_id/event_id 有效期。 */
  isWakeup?: boolean;
}

export interface StreamFrameResponse {
  streamMsgId: string;
  remainMsgLen?: number;
  refIdx?: string;
}


export class Rest {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly tokenBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger?: { debug(message: string): void; warn(message: string): void };
  private readonly fetchImpl: typeof fetch;
  private readonly token = new TokenCache();

  constructor(options: RestOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.tokenBaseUrl = (options.tokenBaseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 统一请求入口：自动携带 token，401 时刷新后重试一次。 */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    apiPath: string,
    body?: unknown,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.ensureToken();
    const url = `${this.baseUrl}${apiPath}`;
    this.logger?.debug?.(`[rest] ${method} ${apiPath}`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RestApiError(`请求官方 API 失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 401 && retryOn401) {
      this.token.invalidate();
      this.logger?.debug?.('[rest] 401，刷新 access_token 后重试');
      return this.request<T>(method, apiPath, body, false);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // 非 JSON 响应按空对象处理
    }

    const record = (payload ?? {}) as {
      message?: string;
      code?: number | string;
      id?: string;
    };

    if (!response.ok) {
      const bizCode = typeof record.code === 'number' ? record.code : undefined;
      throw new RestApiError(record.message ?? `HTTP ${response.status}`, {
        httpStatus: response.status,
        bizCode,
        bizMessage: record.message,
      });
    }

    return payload as T;
  }

  /** 供网关复用同一 access_token 缓存。 */
  async tokenForGateway(): Promise<string> {
    return this.ensureToken();
  }

  private async ensureToken(): Promise<string> {
    if (this.token.valid) return this.token.token;
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    const url = `${this.tokenBaseUrl}/app/getAppAccessToken`;
    this.logger?.debug?.('[rest] 刷新 access_token');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.appSecret,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RestApiError(`获取 access_token 失败：${err instanceof Error ? err.message : String(err)}`);
    }

    let payload: TokenResponse | null = null;
    try {
      payload = (await response.json()) as TokenResponse;
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.access_token) {
      throw new RestApiError(`获取 access_token 失败：HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }
    const ttl = (payload.expires_in ?? 0) > 0 ? payload.expires_in! * 1000 : undefined;
    this.token.set(payload.access_token, ttl);
    return payload.access_token;
  }

  /** 发送文本或富媒体消息；msgId 省略时为主动消息。 */
  async sendText(
    target: { scope: OfficialScope; targetId: string },
    content: string,
    options?: SendTextOptions,
  ): Promise<SendResponse> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const payload: SendTextPayload = { content, msg_type: 0 };
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages`, payload);
  }

  /** 发送富媒体消息（msg_type=7）；fileInfo 来自 uploadMedia。 */
  async sendRichMedia(
    target: { scope: OfficialScope; targetId: string },
    fileInfo: string,
    content = '',
    options?: SendTextOptions,
  ): Promise<SendResponse> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const payload: SendTextPayload = {
      msg_type: 7,
      media: { file_info: fileInfo },
    };
    // 官方 msg_type=7 示例不带 content；空串省略，避免 22006「消息类型与内容不匹配」。
    if (content !== '') payload.content = content;
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages`, payload);
  }

  /** 发送 markdown 消息（msg_type=2），可附带 keyboard。 */
  async sendMarkdown(
    target: { scope: OfficialScope; targetId: string },
    content: string,
    options?: SendTextOptions,
  ): Promise<SendResponse> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const payload: SendTextPayload = { msg_type: 2, markdown: { content } };
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages`, payload);
  }

  /** 发送图文卡片（msg_type=8，type=tuwen）。 */
  async sendCard(
    target: { scope: OfficialScope; targetId: string },
    card: { type: string; content: Record<string, unknown> },
    options?: SendTextOptions,
  ): Promise<SendResponse> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const payload: SendTextPayload = { msg_type: 8, card };
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages`, payload);
  }

  /** 单聊「正在输入」（msg_type=6）；群聊平台不支持。 */
  async sendTyping(
    userOpenid: string,
    seconds: number,
    options?: SendTextOptions,
  ): Promise<SendResponse> {
    const payload: SendTextPayload = {
      msg_type: 6,
      input_notify: { input_type: 1, input_second: seconds },
    };
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/users/${encodeURIComponent(userOpenid)}/messages`, payload);
  }

  /** 单聊互动召回（is_wakeup=true）；不携带被动参数。 */
  async sendWakeup(userOpenid: string, content: string): Promise<SendResponse> {
    return this.request<SendResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(userOpenid)}/messages`,
      { msg_type: 0, content, is_wakeup: true },
    );
  }

  /** 流式单聊消息（首帧 index=0；后续帧携带 stream_msg_id）。 */
  async sendStreamFrame(userOpenid: string, options: StreamFrameOptions): Promise<StreamFrameResponse> {
    const payload: Record<string, unknown> = {
      input_mode: options.inputMode,
      input_state: options.inputState,
      index: options.index,
      content_type: options.contentType,
      content_raw: options.content,
    };
    if (options.streamMsgId !== undefined && options.streamMsgId !== '') {
      payload.stream_msg_id = options.streamMsgId;
    }
    if (options.msgId !== undefined && options.msgId !== '') {
      payload.msg_id = options.msgId;
      payload.msg_seq = options.msgSeq ?? 1;
    } else if (options.eventId !== undefined && options.eventId !== '') {
      payload.event_id = options.eventId;
      payload.msg_seq = options.msgSeq ?? 1;
    }
    if (options.isWakeup === true) payload.is_wakeup = true;
    const resp = await this.request<{
      id?: string;
      remain_msg_len?: number;
      ext_info?: { ref_idx?: string };
    }>('POST', `/v2/users/${encodeURIComponent(userOpenid)}/stream_messages`, payload);
    return {
      streamMsgId: stringOf(resp.id),
      remainMsgLen: typeof resp.remain_msg_len === 'number' ? resp.remain_msg_len : undefined,
      refIdx: resp.ext_info?.ref_idx,
    };
  }

  /** 回应互动事件（INTERACTION_CREATE）；同一 id 只能回应一次。 */
  async ackInteraction(interactionId: string, code: number): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/interactions/${encodeURIComponent(interactionId)}`,
      { code },
    );
  }

  /** 修改全局自定义菜单（仅 C2C）。 */
  async setMenu(menu: Record<string, unknown>): Promise<{ version?: number }> {
    return this.request<{ version?: number }>('PUT', '/v2/menu', { menu });
  }

  /** 创建指令面板；返回 {panel_id}。 */
  async createPanel(panel: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/v2/panels', panel);
  }

  /** 查询指令面板列表；scope 为官方必填（c2c / group）。 */
  async listPanels(
    scope: 'c2c' | 'group',
    cursor?: string,
    limit?: number,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ scope });
    if (cursor !== undefined && cursor !== '') query.set('cursor', cursor);
    if (limit !== undefined) query.set('limit', String(limit));
    return this.request<Record<string, unknown>>('GET', `/v2/panels?${query.toString()}`);
  }

  /** 创建入群自动审批策略。 */
  async createJoinApprovalStrategy(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/v2/groups/join_approval_strategy', body);
  }

  /** 修改入群自动审批策略。 */
  async updateJoinApprovalStrategy(
    strategyId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'PATCH',
      `/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}`,
      body,
    );
  }

  /** 增删策略白名单 QQ 号。 */
  async updateJoinApprovalWhitelist(
    strategyId: string,
    op: 'add' | 'del',
    whitelistUsers: readonly string[],
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}/whitelist_users`,
      { op, whitelist_users: [...whitelistUsers] },
    );
  }

  /** 对关联群执行全量扫描。 */
  async executeJoinApprovalStrategy(strategyId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}/execute`,
      {},
    );
  }

  /** 获取群成员列表（白名单，30 条/页）。 */
  async listGroupMembers(
    groupOpenid: string,
    cursor?: string,
  ): Promise<{ members: OfficialGroupMember[]; nextCursor: string }> {
    const query = cursor === undefined || cursor === '' ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const resp = await this.request<{ members?: Array<Record<string, unknown>>; next_cursor?: unknown }>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/members${query}`,
    );
    return {
      members: Array.isArray(resp.members) ? resp.members.map(toGroupMember) : [],
      nextCursor: stringOf(resp.next_cursor),
    };
  }

  /** 获取单个群成员信息（白名单）。 */
  async getGroupMember(groupOpenid: string, memberOpenid: string): Promise<OfficialGroupMember> {
    const resp = await this.request<Record<string, unknown>>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}`,
    );
    return toGroupMember(resp);
  }

  /** 批量移除群成员（单次最多 20 个，可选择同时拉黑；白名单）。 */
  async batchRemoveGroupMembers(
    groupOpenid: string,
    memberOpenids: readonly string[],
    addToBlacklist = false,
  ): Promise<{ result: string; failedBlacklistOpenids: string[] }> {
    const resp = await this.request<{
      remove_members_result?: unknown;
      add_to_member_blacklist_fail_openids?: unknown;
    }>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/batch_remove_members`,
      {
        member_openids: [...memberOpenids],
        add_to_member_blacklist: addToBlacklist,
      },
    );
    return {
      result: stringOf(resp.remove_members_result),
      failedBlacklistOpenids: Array.isArray(resp.add_to_member_blacklist_fail_openids)
        ? resp.add_to_member_blacklist_fail_openids.map((item) => stringOf(item)).filter((item) => item !== '')
        : [],
    };
  }

  /** 撤回消息（群 / 单聊通用；官方仅支持 2 分钟内的自身消息）。 */
  async recallMessage(
    target: { scope: OfficialScope; targetId: string; msgId: string },
  ): Promise<void> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    await this.request<unknown>(
      'DELETE',
      `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages/${encodeURIComponent(target.msgId)}`,
    );
  }

  /**
   * 上传富媒体：URL 直传（平台转存）或本地 / base64 / Buffer 直传（≤5MB）。
   * 返回 file_info（含 ttl）。群/单聊上传结果不互通，端点按目标作用域选择。
   */
  async uploadMedia(
    target: { scope: OfficialScope; targetId: string },
    fileData: string | Buffer,
    options?: UploadOptions,
  ): Promise<{ fileInfo: string; ttl?: number }> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const apiPath = `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/files`;
    const fileType = (options?.fileType ?? guessFileType(options?.fileName)) as 1 | 2 | 3 | 4;

    // URL 直传：交给平台下载转存。
    if (typeof fileData === 'string' && /^https?:\/\//.test(fileData)) {
      const resp = await this.request<{ file_info?: string; ttl?: number }>('POST', apiPath, {
        file_type: fileType,
        url: fileData,
        srv_send_msg: false,
        ...(options?.fileName === undefined ? {} : { file_name: options.fileName }),
      });
      if (!resp.file_info) throw new RestApiError('富媒体上传未返回 file_info');
      return { fileInfo: resp.file_info, ttl: resp.ttl };
    }

    // 本地 / base64 / Buffer → 二进制直传（官方上限 5MB；分片上传暂未实现）。
    const buffer = typeof fileData === 'string'
      ? (fileData.startsWith('base64://')
        ? Buffer.from(fileData.slice('base64://'.length), 'base64')
        : await readLocalFile(fileData))
      : fileData;
    if (buffer.length > BINARY_UPLOAD_LIMIT) {
      throw new RestApiError(
        `富媒体 ${buffer.length} 字节超过 5MB 直传上限；请改用公网 URL（分片上传暂未实现）`,
      );
    }

    const resp = await this.request<{ file_info?: string; ttl?: number }>('POST', apiPath, {
      file_type: fileType,
      file_name: options?.fileName ?? `file-${Date.now()}.${extOf(fileType)}`,
      file_data: buffer.toString('base64'),
      srv_send_msg: false,
    });
    if (!resp.file_info) throw new RestApiError('富媒体上传未返回 file_info');
    return { fileInfo: resp.file_info, ttl: resp.ttl };
  }

  /** 群禁言（duration 秒，0 取消）；memberOpenid 省略时为全员禁言。 */
  async setGroupBan(groupOpenid: string, muteSeconds: number, memberOpenid?: string): Promise<void> {
    const memberPath = memberOpenid === undefined ? '' : `/members/${encodeURIComponent(memberOpenid)}`;
    await this.request<unknown>(
      'PATCH',
      `/v2/groups/${encodeURIComponent(groupOpenid)}${memberPath}/mute`,
      { mute_seconds: muteSeconds },
    );
  }

  /** 群基本信息（需平台白名单权限；无权限时抛 RestApiError）。 */
  async getGroupInfo(groupOpenid: string): Promise<OfficialGroupInfo> {
    const resp = await this.request<Record<string, unknown>>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/info`,
    );
    return {
      groupOpenid: stringOf(resp.group_openid),
      groupName: stringOf(resp.group_name),
      memberCount: numberOf(resp.group_member_num),
      fingerMemo: stringOf(resp.group_finger_memo) || undefined,
    };
  }

  /** botinfo：机器人基础信息。 */
  async getBotInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/users/@me');
  }

  /** 入群审批。 */
  async setGroupAddRequest(
    params: { eventSeq: string; groupId: string; approve: boolean },
  ): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/v2/groups/${encodeURIComponent(params.groupId)}/add_request`,
      {
        approve: params.approve,
        event_seq: params.eventSeq,
      },
    );
  }
}

/** 官方二进制直传上限：5MB；更大的文件需分片上传（暂未实现）。 */
const BINARY_UPLOAD_LIMIT = 5 * 1024 * 1024;

/** 被动参数 / 引用 / 键盘 / 召回 统一写入请求体。 */
function applySendOptions(payload: SendTextPayload, options?: SendTextOptions): void {
  if (options === undefined) return;
  if (options.msgId !== undefined && options.msgId !== '') {
    payload.msg_id = options.msgId;
    payload.msg_seq = options.msgSeq ?? 1;
  } else if (options.eventId !== undefined && options.eventId !== '') {
    payload.event_id = options.eventId;
    payload.msg_seq = options.msgSeq ?? 1;
  }
  if (options.refIdx !== undefined && options.refIdx !== '') {
    payload.message_reference = { message_id: options.refIdx };
  }
  if (options.keyboard !== undefined) payload.keyboard = options.keyboard;
  if (options.isWakeup === true) payload.is_wakeup = true;
}

function toGroupMember(value: Record<string, unknown>): OfficialGroupMember {
  return {
    memberOpenid: stringOf(value.member_openid ?? value.memberOpenid),
    username: stringOf(value.username),
    role: stringOf(value.member_role ?? value.memberRole) || 'member',
    bot: value.bot === true,
    joinedAt: stringOf(value.joined_at ?? value.joinedAt),
    unionOpenid: stringOf(value.union_openid ?? value.unionOpenid) || undefined,
  };
}

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function numberOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return 0;
}

function extOf(fileType: 1 | 2 | 3 | 4): string {
  switch (fileType) {
    case 1: return 'png';
    case 2: return 'mp4';
    case 3: return 'silk';
    case 4: return 'dat';
  }
}

function guessFileType(fileName?: string): 1 | 2 | 3 | 4 {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  if (ext === 'mp4' || ext === 'mov') return 2;
  if (ext === 'silk' || ext === 'amr' || ext === 'mp3') return 3;
  return 1;
}

async function readLocalFile(filePath: string): Promise<Buffer> {
  const fs = await import('node:fs/promises');
  const realPath = filePath.startsWith('file://') ? fileURLToPath(filePath) : filePath;
  return fs.readFile(realPath);
}

import { fileURLToPath } from 'node:url';
