import type { OfficialScope } from '../types.js';

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_BASE_URL = 'https://api.bot.qq.com';

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

export class RestApiError extends Error {
  readonly httpStatus?: number;
  readonly bizCode?: number;
  readonly bizMessage?: string;
  readonly traceId?: string;

  constructor(
    message: string,
    opts?: { httpStatus?: number; bizCode?: number; bizMessage?: string; traceId?: string },
  ) {
    super(message);
    this.name = 'RestApiError';
    this.httpStatus = opts?.httpStatus;
    this.bizCode = opts?.bizCode;
    this.bizMessage = opts?.bizMessage;
    this.traceId = opts?.traceId;
  }
}

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

  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  message?: string;
  code?: number | string;
  err_code?: number | string;
}

interface SendTextPayload {
  content?: string;
  markdown?: MarkdownPayload;
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

export interface MarkdownPayload {
  content?: string;
  custom_template_id?: string;
  params?: unknown[];

  force_verify_image_resource?: boolean;
}

interface SendResponse {
  id?: string;
  message_ids?: string[];
  ext_info?: { ref_idx?: string };
}

export interface SendTextOptions {

  msgId?: string;

  eventId?: string;
  msgSeq?: number;

  refIdx?: string;

  keyboard?: Record<string, unknown>;

  isWakeup?: boolean;
}

export interface OfficialGroupInfo {
  groupOpenid: string;
  groupName: string;
  memberCount: number;
  fingerMemo?: string;
}

export interface UploadOptions {
  fileType: 1 | 2 | 3 | 4;
  fileName?: string;

  content?: string;
}

export interface OfficialGroupMember {
  memberOpenid: string;
  username: string;

  role: string;
  bot: boolean;
  joinedAt: string;
  unionOpenid?: string;
}

export interface StreamFrameOptions {

  streamMsgId?: string;

  index: number;

  inputState: 1 | 10;
  contentType: 'text' | 'markdown';
  inputMode: 'append' | 'replace';
  content: string;
  msgId?: string;
  eventId?: string;
  msgSeq?: number;

  isWakeup?: boolean;
}

export interface StreamFrameResponse {
  streamMsgId: string;
  remainMsgLen?: number;
  refIdx?: string;
}

export interface OfficialJoinRequest {
  joinRequestId: string;
  riskTips: string;
  unionOpenid?: string;
  memberOpenid: string;
  username: string;
  applyAt: string;
  applySource: string;
  invitedBy: string;
  bot: boolean;
  verifyInfo: Record<string, unknown>;
}

export interface OfficialMuteState {
  globalRule: Record<string, unknown>;
  members: Array<{
    memberOpenid: string;
    muteExpireAt: string;
    username: string;
    unionOpenid?: string;
  }>;
}

export interface OfficialBlacklistUser {
  unionOpenid?: string;
  memberOpenid: string;
  username: string;
  bannedAt: string;
  bot: boolean;
}

export interface OfficialMediaImage {
  imageId: string;
  url: string;
  ttl?: number;
  previewUrl?: string;
}

interface UploadPrepareResponse {
  upload_id?: string;
  block_size?: string | number;
  parts?: Array<{ index?: number; presigned_url?: string; block_size?: string | number }>;
  upload_config?: { concurrency?: number; retry_timeout?: number; retry_delay?: number };
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

    }

    const record = (payload ?? {}) as {
      message?: string;
      err_code?: number | string;
      code?: number | string;
      trace_id?: string;
      id?: string;
    };

    const bizCode = numericCode(record.err_code) ?? numericCode(record.code);
    const bizMessage = typeof record.message === 'string' ? record.message : undefined;

    if (!response.ok || (bizCode !== undefined && bizCode !== 0)) {
      throw new RestApiError(
        bizMessage ?? (response.ok ? `平台返回错误码 ${bizCode ?? '未知'}` : `HTTP ${response.status}`),
        {
          httpStatus: response.status,
          bizCode,
          bizMessage,
          traceId: typeof record.trace_id === 'string' ? record.trace_id : undefined,
        },
      );
    }

    return payload as T;
  }

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
      const bizCode = numericCode(payload?.err_code) ?? numericCode(payload?.code);
      const detail = typeof payload?.message === 'string' && payload.message !== ''
        ? payload.message
        : `HTTP ${response.status}`;
      throw new RestApiError(`获取 access_token 失败：${detail}`, {
        httpStatus: response.status,
        bizCode,
        bizMessage: typeof payload?.message === 'string' ? payload.message : undefined,
      });
    }
    const ttl = (payload.expires_in ?? 0) > 0 ? payload.expires_in! * 1000 : undefined;
    this.token.set(payload.access_token, ttl);
    return payload.access_token;
  }

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

    if (content !== '') payload.content = content;
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages`, payload);
  }

  async sendMarkdown(
    target: { scope: OfficialScope; targetId: string },
    markdown: MarkdownPayload,
    options?: SendTextOptions,
  ): Promise<SendResponse> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const payload: SendTextPayload = { msg_type: 2, markdown };
    applySendOptions(payload, options);
    return this.request<SendResponse>('POST', `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages`, payload);
  }

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

  async sendWakeup(userOpenid: string, content: string): Promise<SendResponse> {
    return this.request<SendResponse>(
      'POST',
      `/v2/users/${encodeURIComponent(userOpenid)}/messages`,
      { msg_type: 0, content, is_wakeup: true },
    );
  }

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

  async ackInteraction(interactionId: string, code: number): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/interactions/${encodeURIComponent(interactionId)}`,
      { code },
    );
  }

  async setMenu(menu: Record<string, unknown>): Promise<{ version?: number }> {
    return this.request<{ version?: number }>('PUT', '/v2/menu', { menu });
  }

  async getMenu(): Promise<{ version?: number; menu?: Record<string, unknown> }> {
    return this.request<{ version?: number; menu?: Record<string, unknown> }>('GET', '/v2/menu');
  }

  async createPanel(panel: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/v2/panels', panel);
  }

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

  async getPanel(panelId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/v2/panels/${encodeURIComponent(panelId)}`);
  }

  async updatePanel(panelId: string, panel: Record<string, unknown>): Promise<{ version?: number }> {
    return this.request<{ version?: number }>(
      'PUT',
      `/v2/panels/${encodeURIComponent(panelId)}`,
      { panel },
    );
  }

  async deletePanel(panelId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/v2/panels/${encodeURIComponent(panelId)}`);
  }

  async updatePanelTarget(
    panelId: string,
    op: 'add' | 'del',
    target: { userOpenids?: readonly string[]; groupOpenids?: readonly string[] },
  ): Promise<void> {
    const body: Record<string, unknown> = { op };
    if (target.userOpenids !== undefined) body.user_openids = [...target.userOpenids];
    if (target.groupOpenids !== undefined) body.group_openids = [...target.groupOpenids];
    await this.request<unknown>(
      'PUT',
      `/v2/panels/${encodeURIComponent(panelId)}/target`,
      body,
    );
  }

  async createJoinApprovalStrategy(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/v2/groups/join_approval_strategy', body);
  }

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

  async executeJoinApprovalStrategy(strategyId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}/execute`,
      {},
    );
  }

  async listJoinApprovalStrategies(
    cursor?: string,
    limit?: number,
  ): Promise<{ strategies: Array<Record<string, unknown>>; nextCursor: string }> {
    const query = new URLSearchParams();
    if (cursor !== undefined && cursor !== '') query.set('cursor', cursor);
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    const resp = await this.request<{ strategies?: unknown; next_cursor?: unknown }>(
      'GET',
      `/v2/groups/join_approval_strategy${suffix}`,
    );
    return {
      strategies: Array.isArray(resp.strategies)
        ? resp.strategies.filter(isRecord)
        : [],
      nextCursor: stringOf(resp.next_cursor),
    };
  }

  async deleteJoinApprovalStrategy(strategyId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/v2/groups/join_approval_strategy/${encodeURIComponent(strategyId)}`,
    );
  }

  async listJoinRequests(
    groupOpenid: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ list: OfficialJoinRequest[]; nextCursor: string }> {
    const query = new URLSearchParams();
    if (cursor !== undefined && cursor !== '') query.set('cursor', cursor);
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    const resp = await this.request<{ list?: unknown; next_cursor?: unknown }>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/join_request_list${suffix}`,
    );
    return {
      list: Array.isArray(resp.list) ? resp.list.filter(isRecord).map(toJoinRequest) : [],
      nextCursor: stringOf(resp.next_cursor),
    };
  }

  async approveJoinRequest(
    groupOpenid: string,
    memberOpenid: string,
    body: {
      op: 'approve' | 'decline';
      joinRequestId?: string;
      rejectReason?: string;
      addToMemberBlacklist?: boolean;
    },
  ): Promise<void> {
    const payload: Record<string, unknown> = { op: body.op };
    if (body.joinRequestId !== undefined && body.joinRequestId !== '') {
      payload.join_request_id = body.joinRequestId;
    }
    if (body.rejectReason !== undefined && body.rejectReason !== '') {
      payload.reject_reason = body.rejectReason;
    }
    if (body.addToMemberBlacklist === true) payload.add_to_member_blacklist = true;
    await this.request<unknown>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/approval_join_request/${encodeURIComponent(memberOpenid)}`,
      payload,
    );
  }

  async getMuteState(groupOpenid: string): Promise<OfficialMuteState> {
    const resp = await this.request<Record<string, unknown>>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/restrict_chat_setting`,
    );
    const members = Array.isArray(resp.members) ? resp.members.filter(isRecord) : [];
    return {
      globalRule: isRecord(resp.global_rule) ? resp.global_rule : {},
      members: members.map((item) => ({
        memberOpenid: stringOf(item.member_openid),
        muteExpireAt: stringOf(item.mute_expire_at),
        username: stringOf(item.username),
        unionOpenid: stringOf(item.union_openid) || undefined,
      })),
    };
  }

  async setMemberMutes(
    groupOpenid: string,
    members: ReadonlyArray<{ op: 'add' | 'update' | 'del'; memberOpenid: string; muteExpireAt?: string }>,
  ): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/restrict_chat_setting`,
      {
        members: members.map((member) => ({
          op: member.op,
          member_openid: member.memberOpenid,
          ...(member.muteExpireAt === undefined ? {} : { mute_expire_at: member.muteExpireAt }),
        })),
      },
    );
  }

  async listMemberBlacklist(
    groupOpenid: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ users: OfficialBlacklistUser[]; nextCursor: string }> {
    const query = new URLSearchParams();
    if (cursor !== undefined && cursor !== '') query.set('cursor', cursor);
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    const resp = await this.request<{ users?: unknown; next_cursor?: unknown }>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/member_blacklist${suffix}`,
    );
    return {
      users: Array.isArray(resp.users)
        ? resp.users.filter(isRecord).map((item) => ({
          unionOpenid: stringOf(item.union_openid) || undefined,
          memberOpenid: stringOf(item.member_openid),
          username: stringOf(item.username),
          bannedAt: stringOf(item.banned_at),
          bot: item.bot === true,
        }))
        : [],
      nextCursor: stringOf(resp.next_cursor),
    };
  }

  async updateMemberBlacklist(
    groupOpenid: string,
    op: 'add' | 'del',
    memberOpenids: readonly string[],
  ): Promise<{ failedOpenids: string[] }> {
    const resp = await this.request<{ fail_openids?: unknown }>(
      'POST',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/member_blacklist`,
      { op, member_openids: [...memberOpenids] },
    );
    return {
      failedOpenids: Array.isArray(resp.fail_openids)
        ? resp.fail_openids.map((item) => stringOf(item)).filter((item) => item !== '')
        : [],
    };
  }

  async getGroupBotState(groupOpenid: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/bot_state`,
    );
  }

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

  async getGroupMember(groupOpenid: string, memberOpenid: string): Promise<OfficialGroupMember> {
    const resp = await this.request<Record<string, unknown>>(
      'GET',
      `/v2/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}`,
    );
    return toGroupMember(resp);
  }

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

  async recallMessage(
    target: { scope: OfficialScope; targetId: string; msgId: string },
  ): Promise<void> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    await this.request<unknown>(
      'DELETE',
      `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/messages/${encodeURIComponent(target.msgId)}`,
    );
  }

  async uploadMedia(
    target: { scope: OfficialScope; targetId: string },
    fileData: string | Buffer,
    options?: UploadOptions,
  ): Promise<{ fileInfo: string; ttl?: number }> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const apiPath = `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}/files`;
    const fileType = (options?.fileType ?? guessFileType(options?.fileName)) as 1 | 2 | 3 | 4;

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

    const buffer = typeof fileData === 'string'
      ? (fileData.startsWith('base64://')
        ? Buffer.from(fileData.slice('base64://'.length), 'base64')
        : await readLocalFile(fileData))
      : fileData;
    const fileName = options?.fileName ?? `file-${Date.now()}.${extOf(fileType)}`;
    if (buffer.length > BINARY_UPLOAD_LIMIT) {
      return this.uploadMediaChunked(target, buffer, fileType, fileName);
    }

    const resp = await this.request<{ file_info?: string; ttl?: number }>('POST', apiPath, {
      file_type: fileType,
      file_name: fileName,
      file_data: buffer.toString('base64'),
      srv_send_msg: false,
    });
    if (!resp.file_info) throw new RestApiError('富媒体上传未返回 file_info');
    return { fileInfo: resp.file_info, ttl: resp.ttl };
  }

  private async uploadMediaChunked(
    target: { scope: OfficialScope; targetId: string },
    buffer: Buffer,
    fileType: 1 | 2 | 3 | 4,
    fileName: string,
  ): Promise<{ fileInfo: string; ttl?: number }> {
    const pathPrefix = target.scope === 'group' ? 'groups' : 'users';
    const base = `/v2/${pathPrefix}/${encodeURIComponent(target.targetId)}`;
    const prepared = await this.request<UploadPrepareResponse>('POST', `${base}/upload_prepare`, {
      file_type: fileType,
      file_size: String(buffer.length),
      file_name: fileName,
      md5: md5Hex(buffer),
      sha1: sha1Hex(buffer),
      md5_10m: md5Hex(buffer.subarray(0, 10_002_432)),
    });
    const uploadId = stringOf(prepared.upload_id);
    if (uploadId === '') throw new RestApiError('分片上传 prepare 未返回 upload_id');
    const parts = (Array.isArray(prepared.parts) ? prepared.parts : [])
      .slice()
      .sort((a, b) => numberOf(a.index) - numberOf(b.index));
    if (parts.length === 0) throw new RestApiError('分片上传 prepare 未返回分片列表');

    const retryDelayMs = Math.max(1, numberOf(prepared.upload_config?.retry_delay) || 1) * 1000;
    const retryAttempts = 5;
    let offset = 0;
    for (const part of parts) {
      const presignedUrl = stringOf(part.presigned_url);
      if (presignedUrl === '') throw new RestApiError('分片上传缺少 presigned_url');
      const size = numberOf(part.block_size) || numberOf(prepared.block_size)
        || Math.ceil(buffer.length / parts.length);
      const chunk = buffer.subarray(offset, Math.min(offset + size, buffer.length));
      offset += chunk.length;
      if (chunk.length === 0) continue;

      let lastError: unknown;
      for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
        try {
          await this.putPresigned(presignedUrl, chunk);
          await this.request<unknown>('POST', `${base}/upload_part_finish`, {
            upload_id: uploadId,
            part_index: numberOf(part.index),
            block_size: String(chunk.length),
            md5: md5Hex(chunk),
          });
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          const retryable = err instanceof RestApiError && err.bizCode === 40093001;
          if (!retryable || attempt === retryAttempts) break;
          this.logger?.warn(`[rest] 分片 ${numberOf(part.index)} 上传失败（40093001），${retryDelayMs}ms 后重试`);
          await sleep(retryDelayMs);
        }
      }
      if (lastError !== undefined) throw lastError;
    }

    const resp = await this.request<{ file_info?: string; ttl?: number }>('POST', `${base}/files`, {
      file_type: fileType,
      file_name: fileName,
      upload_id: uploadId,
      srv_send_msg: false,
    });
    if (!resp.file_info) throw new RestApiError('分片上传合并未返回 file_info');
    return { fileInfo: resp.file_info, ttl: resp.ttl };
  }

  async setGroupBan(groupOpenid: string, muteSeconds: number, memberOpenid?: string): Promise<void> {
    const memberPath = memberOpenid === undefined ? '' : `/members/${encodeURIComponent(memberOpenid)}`;
    await this.request<unknown>(
      'PATCH',
      `/v2/groups/${encodeURIComponent(groupOpenid)}${memberPath}/mute`,
      { mute_seconds: muteSeconds },
    );
  }

  async uploadMediaImage(
    fileData: string | Buffer,
    options?: { fileName?: string; contentType?: string },
  ): Promise<OfficialMediaImage> {
    const buffer = typeof fileData === 'string'
      ? (/^https?:\/\//.test(fileData) ? await this.downloadFile(fileData) : await resolveBinary(fileData))
      : fileData;
    if (buffer.length > MEDIA_IMAGE_LIMIT) {
      throw new RestApiError(`素材图片 ${buffer.length} 字节超过 10MB 上限`);
    }

    const fileName = options?.fileName ?? guessMediaImageName(fileData);
    const contentType = options?.contentType ?? guessImageContentType(fileName);
    if (!MEDIA_IMAGE_TYPES.has(contentType)) {
      throw new RestApiError(`素材图片类型「${contentType}」不支持（仅 png/jpeg/gif/webp）`);
    }

    const prepared = await this.request<{
      upload_id?: string;
      presigned_url?: string;
      expires_in?: number;
    }>('POST', '/v2/media-images/prepare', {
      file_name: fileName,
      file_size: buffer.length,
      content_type: contentType,
      md5: md5Hex(buffer),
      sha1: sha1Hex(buffer),
    });
    const uploadId = stringOf(prepared.upload_id);
    const presignedUrl = stringOf(prepared.presigned_url);
    if (uploadId === '' || presignedUrl === '') {
      throw new RestApiError('素材上传 prepare 未返回 upload_id / presigned_url');
    }

    const etag = await this.putPresigned(presignedUrl, buffer, contentType);
    const completed = await this.request<{
      image_id?: string;
      url?: string;
      ttl?: number;
      preview_url?: string;
    }>('POST', '/v2/media-images/complete', {
      upload_id: uploadId,
      md5: etag === '' ? md5Hex(buffer) : etag,
    });
    const imageId = stringOf(completed.image_id);
    const url = stringOf(completed.url);
    if (imageId === '' || url === '') {
      throw new RestApiError('素材上传 complete 未返回 image_id / url');
    }
    return {
      imageId,
      url,
      ttl: typeof completed.ttl === 'number' ? completed.ttl : undefined,
      previewUrl: stringOf(completed.preview_url) || undefined,
    };
  }

  async listMediaImages(cursor?: string): Promise<Record<string, unknown>> {
    const suffix = cursor === undefined || cursor === '' ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return this.request<Record<string, unknown>>('GET', `/v2/media-images${suffix}`);
  }

  async deleteMediaImage(imageId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/v2/media-images/${encodeURIComponent(imageId)}/delete`,
    );
  }

  async generateUrlLink(callbackData?: string): Promise<{ url: string }> {
    const body = callbackData === undefined || callbackData === '' ? {} : { callback_data: callbackData };
    const resp = await this.request<{ data?: { url?: string } }>('POST', '/v2/generate_url_link', body);
    const url = stringOf(resp.data?.url);
    if (url === '') throw new RestApiError('生成分享链接未返回 url');
    return { url };
  }

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

  async getBotInfo(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/users/@me');
  }

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

  private async putPresigned(
    presignedUrl: string,
    data: Buffer,
    contentType?: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(presignedUrl, {
        method: 'PUT',
        headers: contentType === undefined ? {} : { 'Content-Type': contentType },
        body: data,
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 30_000)),
      });
    } catch (err) {
      throw new RestApiError(`预签名上传失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new RestApiError(`预签名上传失败：HTTP ${response.status}`, { httpStatus: response.status });
    }

    return (response.headers.get('etag') ?? '').replace(/"/g, '').trim().toLowerCase();
  }

  private async downloadFile(url: string): Promise<Buffer> {
    await assertPublicHttpUrl(url);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new RestApiError(`下载素材图片失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new RestApiError(`下载素材图片失败：HTTP ${response.status}`, { httpStatus: response.status });
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MEDIA_IMAGE_LIMIT) {
      throw new RestApiError(`素材图片 ${declared} 字节超过 10MB 上限`);
    }
    if (response.body === null) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done === true) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MEDIA_IMAGE_LIMIT) {
          await reader.cancel().catch(() => undefined);
          throw new RestApiError('素材图片超过 10MB 上限');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof RestApiError) throw err;
      throw new RestApiError(`读取素材图片失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return Buffer.concat(chunks);
  }
}

const BINARY_UPLOAD_LIMIT = 5 * 1024 * 1024;

const MEDIA_IMAGE_LIMIT = 10 * 1024 * 1024;
const MEDIA_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function toJoinRequest(value: Record<string, unknown>): OfficialJoinRequest {
  return {
    joinRequestId: stringOf(value.join_request_id),
    riskTips: stringOf(value.risk_tips),
    unionOpenid: stringOf(value.union_openid) || undefined,
    memberOpenid: stringOf(value.member_openid),
    username: stringOf(value.username),
    applyAt: stringOf(value.apply_at),
    applySource: stringOf(value.apply_source),
    invitedBy: stringOf(value.invited_by),
    bot: value.bot === true,
    verifyInfo: isRecord(value.verify_info) ? value.verify_info : {},
  };
}

function md5Hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

async function resolveBinary(fileData: string): Promise<Buffer> {
  if (fileData.startsWith('base64://')) {
    return Buffer.from(fileData.slice('base64://'.length), 'base64');
  }
  if (/^https?:\/\//.test(fileData)) {
    throw new RestApiError('公网 URL 由上传方法单独处理');
  }
  return readLocalFile(fileData);
}

function guessMediaImageName(fileData: string | Buffer): string {
  if (typeof fileData === 'string' && !fileData.startsWith('base64://')) {
    const cleaned = fileData.startsWith('file://') ? fileURLToPath(fileData) : fileData;
    const base = cleaned.split(/[\\/]/).pop() ?? '';
    if (base !== '' && /\.[a-z0-9]+$/i.test(base)) return base;
  }
  return `image-${Date.now()}.png`;
}

function guessImageContentType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return '';
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

async function assertPublicHttpUrl(raw: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RestApiError(`素材图片 URL 无效：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RestApiError(`素材图片 URL 仅支持 http/https：${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new RestApiError('素材图片 URL 指向本机，已拒绝（SSRF 防护）');
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new RestApiError('素材图片 URL 指向内网地址，已拒绝（SSRF 防护）');
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new RestApiError(`素材图片 URL 主机无法解析：${host}`);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new RestApiError('素材图片 URL 解析到内网地址，已拒绝（SSRF 防护）');
  }
}

function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped !== null) return isPrivateIpv4(mapped[1]!);
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] ?? '', 16);
    if (!Number.isFinite(first)) return true;
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    return false;
  }
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

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
