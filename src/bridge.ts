/**
 * Bridge — 把官方网关事件 fan-out 到 OneBot v11 / Milky 两端，
 * 并为两端的发送动作提供统一实现（被动窗口 + 主动配额 + 官方 REST）。
 */

import path from 'node:path';
import { readJson, writeJsonAtomic, safeSegment } from './store/json-store.js';
import type { NoaConfig } from './config.js';
import type { Logger, OfficialScope } from './types.js';
import { IdMapper } from './core/idmap.js';
import { MsgSeqManager } from './core/msgseq.js';
import { Quota } from './core/quota.js';
import { MediaCache } from './core/media-cache.js';
import {
  onebotToMilkySegments,
  segmentsToCQ,
  type AnyOneBotSegment,
  type MilkySegment,
  type OutboundPart,
} from './core/segments.js';
import type { OfficialGroupMember, Rest } from './official/rest.js';
import type { GatewayHandle, OfficialEventEnvelope } from './official/gateway.js';
import {
  OneBotActionRouter,
  type CachedMessage,
  type GroupInfoSnapshot,
  type GroupMemberSnapshot,
  type MessageCacheLike,
  type MessageSender,
  type SendPartsOptions,
  type SendPartsResult,
  type SentMessagePart,
} from './onebot/actions.js';
import { officialEventToOneBotEvent, type AnyOneBotEvent, type OneBotMessageEvent } from './onebot/events.js';
import { startOneBotServer, type OneBotServerHandle } from './onebot/server.js';
import { startReverseClients, type ReverseHandle } from './onebot/reverse.js';
import { MilkyActionRouter } from './milky/actions.js';
import { startMilkyServer, type MilkyServerHandle } from './milky/server.js';
import { interactionToNoaEvent } from './noa/events.js';
import { JoinStrategyStore } from './noa/join-policy.js';
import { NoaActionRouter } from './noa/router.js';
import { NoaExtensionService } from './noa/service.js';

// —— 群目录 ——————————————————————————————

interface GroupEntry {
  openid: string;
  name?: string;
  alias?: string;
  joinedAt?: number;
  leftAt?: number;
  lastSeenAt?: number;
}

export class GroupDirectory {
  private entries = new Map<string, GroupEntry>();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    const data = readJson<{ groups?: GroupEntry[] }>(this.file, { groups: [] });
    for (const entry of data.groups ?? []) {
      if (typeof entry.openid === 'string' && entry.openid !== '') {
        this.entries.set(entry.openid, { ...entry });
      }
    }
  }

  list(): GroupEntry[] {
    return [...this.entries.values()].filter((e) => e.leftAt === undefined);
  }

  get(openid: string): GroupEntry | undefined {
    return this.entries.get(openid);
  }

  touch(openid: string, name?: string): void {
    if (openid === '') return;
    const now = Date.now();
    const prev = this.entries.get(openid);
    this.entries.set(openid, {
      ...prev,
      openid,
      name: name ?? prev?.name,
      lastSeenAt: now,
      leftAt: undefined,
    });
    this.save();
  }

  markJoined(openid: string, name?: string): void {
    if (openid === '') return;
    this.entries.set(openid, {
      ...this.entries.get(openid),
      openid,
      name,
      joinedAt: Date.now(),
      leftAt: undefined,
    });
    this.save();
  }

  markLeft(openid: string): void {
    if (openid === '') return;
    const prev = this.entries.get(openid) ?? { openid };
    this.entries.set(openid, { ...prev, leftAt: Date.now() });
    this.save();
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, { version: 1, groups: [...this.entries.values()] });
    } catch (err) {
      this.logger.warn(`[bridge] 写群目录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// —— 近期消息缓存 ——————————————————————————————

export class RecentMessageCache implements MessageCacheLike {
  private readonly map = new Map<string, CachedMessage>();
  constructor(
    private readonly capacity = 2000,
    private readonly ttlMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  put(pseudoId: string, record: CachedMessage): void {
    this.map.set(String(pseudoId), record);
    while (this.map.size > this.capacity) {
      const first = this.map.keys().next();
      if (first.done === true) break;
      this.map.delete(first.value);
    }
  }

  get(pseudoId: string): CachedMessage | undefined {
    const hit = this.map.get(String(pseudoId));
    if (hit === undefined) return undefined;
    if (this.now() - hit.tsMs > this.ttlMs) {
      this.map.delete(String(pseudoId));
      return undefined;
    }
    return hit;
  }
}

// —— 重复投递去重 ——————————————————————————————

/** 消息去重 TTL：官方可能因重试/重连重复推送同一 msg_id。 */
export const MESSAGE_DEDUPE_TTL_MS = 5 * 60_000;

/**
 * 按官方原始 msg_id 做短期去重。
 *
 * 同一 msg_id 在 TTL 内重复到达时返回 false，桥接层据此跳过；
 * 重复命中不会续期（TTL 从首次到达起算）。TTL 为惰性判定：过期条目
 * 在下次 add 该 id 时按新消息处理；容量溢出时按 FIFO 删除最早插入项。
 */
export class RecentIdSet {
  private readonly map = new Map<string, number>();

  constructor(
    private readonly capacity = 2000,
    private readonly ttlMs = MESSAGE_DEDUPE_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 首次出现返回 true；TTL 内重复返回 false；空 id 不参与去重。 */
  add(id: string): boolean {
    const key = String(id);
    if (key === '') return true;
    const now = this.now();
    const seenAt = this.map.get(key);
    if (seenAt !== undefined && now - seenAt <= this.ttlMs) return false;

    // 重新插入以维持插入顺序（Map 的 set 不会移动既有键）；容量溢出时按 FIFO 删除最早插入项。
    // TTL 为惰性判定；去重命中直接返回 false，不刷新时间戳，避免重复推送无限续期。
    if (seenAt !== undefined) this.map.delete(key);
    this.map.set(key, now);
    while (this.map.size > this.capacity) {
      const first = this.map.keys().next();
      if (first.done === true) break;
      this.map.delete(first.value);
    }
    return true;
  }
}

// —— 发送实现 ——————————————————————————————

class BridgeSender implements MessageSender {
  private readonly lastPassive = new Map<string, string>();

  constructor(
    private readonly deps: {
      rest: Rest;
      msgseq: MsgSeqManager;
      quota: Quota;
      passiveOverflow: 'fail' | 'proactive';
      logger: Logger;
      now: () => number;
    },
  ) {}

  rememberPassive(scope: OfficialScope, peerOpenid: string, rawMsgId: string): void {
    if (rawMsgId === '') return;
    this.lastPassive.set(`${scope}:${peerOpenid}`, rawMsgId);
  }

  async sendGroupText(groupOpenid: string, text: string): Promise<{ messageId: string; passive: boolean }> {
    return this.asTextResult(await this.sendParts('group', groupOpenid, [{ kind: 'text', text }]));
  }

  async sendPrivateText(userOpenid: string, text: string): Promise<{ messageId: string; passive: boolean }> {
    return this.asTextResult(await this.sendParts('c2c', userOpenid, [{ kind: 'text', text }]));
  }

  async sendGroupParts(
    groupOpenid: string,
    parts: readonly OutboundPart[],
    options?: SendPartsOptions,
  ): Promise<SendPartsResult> {
    return this.sendParts('group', groupOpenid, parts, options);
  }

  async sendPrivateParts(
    userOpenid: string,
    parts: readonly OutboundPart[],
    options?: SendPartsOptions,
  ): Promise<SendPartsResult> {
    return this.sendParts('c2c', userOpenid, parts, options);
  }

  async getGroupInfo(groupOpenid: string): Promise<GroupInfoSnapshot | null> {
    try {
      const info = await this.deps.rest.getGroupInfo(groupOpenid);
      return { groupName: info.groupName || undefined, memberCount: info.memberCount };
    } catch (err) {
      this.deps.logger.debug(
        `[bridge] 官方群信息不可用：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private asTextResult(result: SendPartsResult): { messageId: string; passive: boolean } {
    return { messageId: result.parts[0]?.messageId ?? '', passive: result.passive };
  }

  /**
   * 领取一次发送名额：优先被动窗口（msg_id + 递增 msg_seq），否则按配置转主动配额。
   * 发送失败不记账；主动消息在发送成功后再调用 recordProactive。
   */
  reserve(
    scope: OfficialScope,
    targetOpenid: string,
  ): { msgId?: string; msgSeq?: number; passive: boolean } {
    const rawMsgId = this.lastPassive.get(`${scope}:${targetOpenid}`);
    if (rawMsgId !== undefined) {
      const decision = this.deps.msgseq.acquire(rawMsgId, scope);
      if (decision.passive) return { msgId: rawMsgId, msgSeq: decision.msgSeq, passive: true };
    }
    if (this.deps.passiveOverflow !== 'proactive') {
      throw new Error('被动回复窗口已关闭（群 5 分钟/5 条、单聊 60 分钟/4 条）；如需主动消息请设置 passiveOverflow=proactive');
    }
    const check = this.deps.quota.check(scope, targetOpenid, 1);
    if (!check.ok) throw new Error(check.message ?? '本地主动消息配额受限');
    return { passive: false };
  }

  /** 主动消息发送成功后记账（平台判定优先于本地估算）。 */
  recordProactive(scope: OfficialScope, targetOpenid: string): void {
    this.deps.quota.record(scope, targetOpenid, this.deps.now());
  }

  /**
   * 按顺序发送分片：先上传富媒体（失败不消耗回复次数），再逐条领取被动槽。
   * 文本 / markdown / 图文卡片 / 富媒体各占一条官方消息，因此混合内容会拆成多条发送。
   */
  private async sendParts(
    scope: OfficialScope,
    targetOpenid: string,
    parts: readonly OutboundPart[],
    options?: SendPartsOptions,
  ): Promise<SendPartsResult> {
    let refAttached = false;
    let allPassive = true;
    const sent: SentMessagePart[] = [];

    for (const part of parts) {
      const prepared = part.kind === 'media'
        ? await this.deps.rest.uploadMedia(
          { scope, targetId: targetOpenid },
          part.file,
          { fileType: MEDIA_FILE_TYPE[part.mediaType], fileName: fileNameOf(part.file) },
        )
        : null;

      const grant = this.reserve(scope, targetOpenid);
      if (!grant.passive) allPassive = false;

      const refIdx: string | undefined = !refAttached && options?.refIdx !== undefined && options.refIdx !== ''
        ? options.refIdx
        : undefined;
      const sendOptions = {
        ...(grant.msgId === undefined ? {} : { msgId: grant.msgId, msgSeq: grant.msgSeq }),
        ...(refIdx === undefined ? {} : { refIdx }),
        ...(part.kind === 'text' || part.kind === 'markdown'
          ? (part.keyboard === undefined
            ? {}
            : { keyboard: part.keyboard as unknown as Record<string, unknown> })
          : {}),
      };

      let resp;
      switch (part.kind) {
        case 'text':
          resp = await this.deps.rest.sendText({ scope, targetId: targetOpenid }, part.text, sendOptions);
          break;
        case 'markdown':
          resp = await this.deps.rest.sendMarkdown({ scope, targetId: targetOpenid }, part.content, sendOptions);
          break;
        case 'card':
          resp = await this.deps.rest.sendCard(
            { scope, targetId: targetOpenid },
            part.card as unknown as { type: string; content: Record<string, unknown> },
            sendOptions,
          );
          break;
        case 'media':
          resp = await this.deps.rest.sendRichMedia(
            { scope, targetId: targetOpenid },
            prepared!.fileInfo,
            '',
            sendOptions,
          );
          break;
      }

      if (!grant.passive) this.recordProactive(scope, targetOpenid);
      refAttached = refIdx !== undefined;
      sent.push({
        messageId: String(resp.id ?? resp.message_ids?.[0] ?? ''),
        refIdx: resp.ext_info?.ref_idx,
      });
    }

    return { parts: sent, passive: allPassive };
  }

  async recall(scope: OfficialScope, targetOpenid: string, rawMsgId: string): Promise<void> {
    await this.deps.rest.recallMessage({ scope, targetId: targetOpenid, msgId: rawMsgId });
  }

  async setGroupBan(groupOpenid: string, muteSeconds: number, memberOpenid?: string): Promise<void> {
    await this.deps.rest.setGroupBan(groupOpenid, muteSeconds, memberOpenid);
  }

  async approveGroupRequest(groupOpenid: string, requestId: string, approve: boolean): Promise<void> {
    await this.deps.rest.setGroupAddRequest({ eventSeq: requestId, groupId: groupOpenid, approve });
  }

  async listGroupMembers(
    groupOpenid: string,
    cursor?: string,
  ): Promise<{ members: GroupMemberSnapshot[]; nextCursor: string }> {
    const page = await this.deps.rest.listGroupMembers(groupOpenid, cursor);
    return { members: page.members.map(toGroupMemberSnapshot), nextCursor: page.nextCursor };
  }

  async getGroupMember(groupOpenid: string, memberOpenid: string): Promise<GroupMemberSnapshot> {
    return toGroupMemberSnapshot(await this.deps.rest.getGroupMember(groupOpenid, memberOpenid));
  }

  async batchRemoveGroupMembers(
    groupOpenid: string,
    memberOpenids: readonly string[],
    addToBlacklist: boolean,
  ): Promise<{ failedBlacklistOpenids: string[] }> {
    const result = await this.deps.rest.batchRemoveGroupMembers(groupOpenid, memberOpenids, addToBlacklist);
    if (result.result !== 'success') {
      throw new Error(`官方批量移除成员返回 ${result.result === '' ? '空结果' : result.result}`);
    }
    return { failedBlacklistOpenids: result.failedBlacklistOpenids };
  }
}

function toGroupMemberSnapshot(member: OfficialGroupMember): GroupMemberSnapshot {
  return {
    memberOpenid: member.memberOpenid,
    username: member.username,
    role: member.role,
    bot: member.bot,
    joinedAt: member.joinedAt,
  };
}

/** OneBot 富媒体段 → 官方 file_type：1 图片 / 2 视频 / 3 语音。 */
const MEDIA_FILE_TYPE: Record<'image' | 'record' | 'video', 1 | 2 | 3> = {
  image: 1,
  video: 2,
  record: 3,
};

/** 从 URL / 本地路径提取文件名，供官方富媒体上传使用。 */
function fileNameOf(file: string): string | undefined {
  if (file.startsWith('base64://')) return undefined;
  const clean = file.replace(/^file:\/\//, '').split(/[?#]/)[0] ?? '';
  const base = clean.split(/[\\/]/).pop() ?? '';
  return base === '' ? undefined : base;
}

// —— 聚合入口 ——————————————————————————————

export interface BridgeOptions {
  config: NoaConfig;
  logger: Logger;
  dataDir: string;
  appId: string;
  appSecret: string;
  mapper: IdMapper;
  rest: Rest;
  gateway: GatewayHandle;
  now?: () => number;
}

export interface BridgeHandle {
  onebot?: OneBotServerHandle;
  reverse?: ReverseHandle;
  milky?: MilkyServerHandle;
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const { config, logger, dataDir, mapper, rest, gateway, appId } = options;
  const now = options.now ?? (() => Date.now());
  const idMode = config.idMode;

  // 机器人自身 openid / 昵称：/users/@me 有则用之，否则 openid 退回 AppID、昵称退回 Arona。
  let selfOpenid = '';
  let selfNickname = 'Arona';
  try {
    const info = await rest.getBotInfo();
    selfOpenid = readString(info.id, info.openid, info.user_openid, info.user_id);
    const officialName = readString(info.username, info.nickname, info.name);
    if (officialName !== '') selfNickname = officialName;
  } catch (err) {
    logger.debug?.(`获取机器人信息失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const selfSeed = selfOpenid !== '' ? selfOpenid : appId;
  const selfIdValue = (): number | string =>
    idMode === 'passthrough' ? selfSeed : Number(mapper.selfPseudo(selfSeed));

  const directory = new GroupDirectory(
    path.join(dataDir, 'registry', safeSegment(appId), 'groups.json'),
    logger,
  );
  const cache = new RecentMessageCache(2000, 15 * 60_000, now);
  const dedupe = new RecentIdSet(2000, MESSAGE_DEDUPE_TTL_MS, now);
  const msgseq = new MsgSeqManager(now);
  const quota = new Quota({
    dataDir,
    key: appId,
    config: {
      dailyLimitPerPeer: config.dailyLimitPerPeer,
      perMinuteLimit: config.perMinuteLimit,
      botQpsLimit: config.botQpsLimit,
      botQpmLimit: config.botQpmLimit,
    },
    logger,
    now,
  });
  const sender = new BridgeSender({
    rest,
    msgseq,
    quota,
    passiveOverflow: config.passiveOverflow,
    logger,
    now,
  });
  const mediaCache = new MediaCache({ dir: path.join(dataDir, 'cache', 'media') });
  const strategyStore = new JoinStrategyStore(
    path.join(dataDir, 'registry', safeSegment(appId), 'join-policy.json'),
    logger,
  );
  const noaService = new NoaExtensionService({ rest, sender, strategyStore, logger });
  const noaRouter = new NoaActionRouter({
    conf: config.noa,
    service: noaService,
    mapper,
    idMode,
    logger,
  });

  const onebotRouter = new OneBotActionRouter({
    idMode,
    mapper,
    sender,
    messageCache: cache,
    groupDirectory: directory,
    selfOpenid: selfSeed,
    selfNickname,
    logger,
    isOnline: () => gateway.online,
    mediaCache,
    noaConf: config.noa,
    noa: noaRouter,
    emitEvent: emitOneBot,
  });
  const milkyRouter = new MilkyActionRouter({
    sender,
    messageCache: cache,
    idMode,
    mapper,
    selfOpenid: selfSeed,
    selfNickname,
    appId,
  });

  let onebot: OneBotServerHandle | undefined;
  let reverse: ReverseHandle | undefined;
  let milky: MilkyServerHandle | undefined;

  if (config.onebot.enable) {
    reverse = startReverseClients({
      urls: config.onebot.reverseUrls,
      logger,
      selfId: selfIdValue,
      now,
      dispatch: (action, params, echo) => onebotRouter.dispatch(action, params, echo),
      accessToken: config.onebot.accessToken === '' ? undefined : config.onebot.accessToken,
    });
    try {
      onebot = await startOneBotServer({
        conf: config.onebot,
        logger,
        selfId: selfIdValue,
        now,
        dispatch: (action, params, echo) => onebotRouter.dispatch(action, params, echo),
        extraBroadcasters: [
          (event) => {
            reverse?.broadcast(event);
          },
        ],
      });
    } catch (err) {
      reverse.close();
      reverse = undefined;
      throw err;
    }
  }

  if (config.milky.enable) {
    try {
      milky = await startMilkyServer({
        conf: config.milky,
        logger,
        dispatch: (api, params) => milkyRouter.dispatch(api, params),
        now,
      });
    } catch (err) {
      await onebot?.close();
      reverse?.close();
      onebot = undefined;
      reverse = undefined;
      throw err;
    }
  }

  function emitOneBot(event: unknown): void {
    if (onebot !== undefined) {
      void onebot.broadcast(event);
    } else {
      reverse?.broadcast(event);
    }
  }

  gateway.onEvent((envelope) => {
    try {
      handleOfficialEvent(envelope);
    } catch (err) {
      logger.warn(`[bridge] 官方事件处理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  function handleOfficialEvent(envelope: OfficialEventEnvelope): void {
    const { eventType, data } = envelope;

    if (eventType === 'INTERACTION_CREATE') {
      handleInteraction(data);
      return;
    }

    const isMessageEvent = eventType === 'GROUP_AT_MESSAGE_CREATE'
      || eventType === 'GROUP_MESSAGE_CREATE'
      || eventType === 'C2C_MESSAGE_CREATE';

    if (isMessageEvent) {
      const rawMsgId = readString(data.id, data.message_id);
      if (!dedupe.add(rawMsgId)) {
        logger.debug?.(`[bridge] 忽略重复投递的消息事件 ${eventType}:${rawMsgId}`);
        return;
      }
    }

    if (eventType === 'GROUP_ADD_ROBOT') {
      directory.markJoined(readString(data.group_openid), readString(data.group_name) || undefined);
    } else if (eventType === 'GROUP_DEL_ROBOT') {
      directory.markLeft(readString(data.group_openid));
    }

    if (isMessageEvent && eventType !== 'C2C_MESSAGE_CREATE') {
      const groupOpenid = readString(data.group_openid);
      if (groupOpenid !== '') directory.touch(groupOpenid, readString(data.group_name) || undefined);
    }

    const onebotEvent = officialEventToOneBotEvent(
      { eventType, data },
      {
        mapper,
        idMode,
        selfOpenid: selfSeed,
        now,
      },
    );

    if (onebotEvent === null) {
      // 无 v11 对应的官方事件：只尝试投递 Milky（成员/请求类在下方 mapMilkyEvent 处理）。
      emitMilky(eventType, data);
      return;
    }

    if (onebotEvent.post_type === 'message') {
      rememberMessage(onebotEvent, data);
    }

    emitOneBot(onebotEvent);
    if (milky !== undefined) {
      const milkyEvent = mapMilkyEvent(onebotEvent, data, mapper, idMode);
      if (milkyEvent !== null) milky.broadcast(milkyEvent);
    }
  }

  function rememberMessage(event: OneBotMessageEvent, data: Record<string, unknown>): void {
    const rawMsgId = readString(data.id, data.message_id);
    if (rawMsgId === '') return;
    const scope: OfficialScope = event.message_type === 'group' ? 'group' : 'c2c';
    const peerOpenid = scope === 'group'
      ? readString(data.group_openid)
      : readString(data.user_openid, data.author && typeof data.author === 'object'
        ? (data.author as Record<string, unknown>).user_openid
        : '');
    msgseq.openWindow(rawMsgId);
    sender.rememberPassive(scope, peerOpenid, rawMsgId);

    const pseudoId = idMode === 'passthrough' ? rawMsgId : mapper.pseudoMsgOf(rawMsgId);
    cache.put(pseudoId, {
      rawMsgId,
      refIdx: extractRefIdx(data),
      scope,
      peerOpenid,
      senderOpenid: String(event.user_id),
      senderName: event.sender.nickname,
      segments: event.message,
      rawMessage: event.raw_message,
      tsMs: event.time * 1000,
    });
  }

  /**
   * INTERACTION_CREATE → noa_interaction（仅 noa.ext.interaction 启用时投递）。
   *
   * type 11/12 默认先 ACK code=0：官方要求 3 秒内回应，否则客户端持续 loading。
   * ACK 失败只告警，不阻塞事件投递。
   */
  function handleInteraction(data: Record<string, unknown>): void {
    if (!config.noa.ext.interaction) {
      logger.debug?.('[bridge] 收到 INTERACTION_CREATE，但 noa.ext.interaction 未启用，已忽略');
      return;
    }
    const event = interactionToNoaEvent(data, {
      mapper,
      idMode,
      selfOpenid: selfSeed,
      interactionRaw: config.noa.interactionRaw,
      now,
    });
    if (event === null) {
      logger.warn('[bridge] INTERACTION_CREATE 缺少 id，无法回应');
      return;
    }
    const interactionId = readString(data.id);
    const type = typeof data.type === 'number' ? data.type : Number(data.type);
    if (config.noa.autoAckInteraction && (type === 11 || type === 12) && interactionId !== '') {
      void rest.ackInteraction(interactionId, 0).catch((err: unknown) => {
        logger.warn(`[bridge] 自动回应互动失败：${err instanceof Error ? err.message : String(err)}`);
      });
    }
    emitOneBot(event);
  }

  function emitMilky(eventType: string, data: Record<string, unknown>): void {
    if (milky === undefined) return;
    const event = mapMilkyRawEvent(eventType, data, mapper, idMode, now);
    if (event !== null) milky.broadcast(event);
  }

  const pruneTimer = setInterval(() => {
    msgseq.prune();
  }, 60_000);
  pruneTimer.unref?.();

  return {
    onebot,
    reverse,
    milky,
    async close(): Promise<void> {
      clearInterval(pruneTimer);
      await onebot?.close();
      reverse?.close();
      await milky?.close();
    },
  };
}

// —— Milky 事件构造 ——————————————————————————————

function timeOf(data: Record<string, unknown>, now: () => number): number {
  const raw = readString(data.timestamp, data.time);
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(now() / 1000);
}

function mapMilkyEvent(
  event: AnyOneBotEvent,
  data: Record<string, unknown>,
  mapper: IdMapper,
  idMode: 'mapped' | 'passthrough',
): Record<string, unknown> | null {
  const expose = (openid: string): number | string =>
    idMode === 'passthrough' ? openid : Number(mapper.pseudoOf(openid));
  const now = (): number => Date.now();

  if (event.post_type === 'message') {
    const rawMsgId = readString(data.id, data.message_id);
    const seq = idMode === 'passthrough' ? rawMsgId : Number(mapper.pseudoMsgOf(rawMsgId));
    const scope: OfficialScope = event.message_type === 'group' ? 'group' : 'c2c';
    const peerOpenid = scope === 'group'
      ? readString(data.group_openid)
      : readString(data.user_openid, data.author && typeof data.author === 'object'
        ? (data.author as Record<string, unknown>).user_openid
        : '');
    const converted = onebotToMilkySegments(event.message);
    const segments: MilkySegment[] = converted.ok
      ? converted.segments
      : [{ type: 'text', data: { text: event.raw_message } }];
    return {
      time: Math.floor((event.time ?? Math.floor(now() / 1000))),
      self_id: Number(event.self_id),
      event_type: 'message_receive',
      data: {
        message_scene: scope === 'group' ? 'group' : 'friend',
        peer_id: expose(peerOpenid),
        message_seq: seq,
        sender_id: Number(event.user_id),
        time: event.time,
        segments,
      },
    };
  }

  if (event.post_type === 'notice') {
    if (event.notice_type === 'group_increase' || event.notice_type === 'group_decrease') {
      return {
        time: event.time,
        self_id: Number(event.self_id),
        event_type: event.notice_type === 'group_increase' ? 'group_member_increase' : 'group_member_decrease',
        data: {
          group_id: Number(event.group_id),
          user_id: Number(event.user_id),
          operator_id: event.operator_id === 0 ? undefined : Number(event.operator_id),
        },
      };
    }
    return null;
  }

  if (event.post_type === 'request') {
    if (event.request_type === 'group') {
      const [groupOpenid, seq] = splitFlag(event.flag);
      return {
        time: event.time,
        self_id: Number(event.self_id),
        event_type: 'group_join_request',
        data: {
          group_id: groupOpenid === '' ? 0 : Number(expose(groupOpenid)),
          notification_seq: Number(seq) || 0,
          is_filtered: false,
          initiator_id: Number(event.user_id),
          comment: event.comment,
        },
      };
    }
    return {
      time: event.time,
      self_id: Number(event.self_id),
      event_type: 'friend_request',
      data: {
        initiator_id: Number(event.user_id),
        initiator_uid: event.flag,
        comment: event.comment,
        via: '',
      },
    };
  }

  return null;
}

function mapMilkyRawEvent(
  eventType: string,
  data: Record<string, unknown>,
  mapper: IdMapper,
  idMode: 'mapped' | 'passthrough',
  now: () => number,
): Record<string, unknown> | null {
  if (eventType === 'GROUP_JOIN_REQUEST') {
    const groupOpenid = readString(data.group_openid);
    const seq = readString(data.notification_seq, data.id);
    const time = timeOf(data, now);
    return {
      time,
      self_id: 0,
      event_type: 'group_join_request',
      data: {
        group_id: idMode === 'passthrough' ? groupOpenid : Number(mapper.pseudoOf(groupOpenid)),
        notification_seq: Number(seq) || 0,
        is_filtered: Boolean(data.is_filtered),
        initiator_id: Number(readString(data.user_openid)),
        comment: readString(data.comment),
      },
    };
  }
  if (eventType === 'FRIEND_ADD') {
    return {
      time: timeOf(data, now),
      self_id: 0,
      event_type: 'friend_request',
      data: {
        initiator_id: Number(readString(data.user_openid)),
        initiator_uid: '',
        comment: '',
        via: '',
      },
    };
  }
  return null;
}

function splitFlag(flag: string): [string, string] {
  const idx = flag.indexOf(':');
  if (idx <= 0) return ['', ''];
  return [flag.slice(0, idx), flag.slice(idx + 1)];
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/**
 * 官方消息事件里的 REFIDX（message_scene.ext 中 `msg_idx=REFIDX_...`）。
 *
 * 引用回复的 message_reference.message_id 必须用它；message.id（ROBOT1.0_...）
 * 不能替代。缺失时返回 undefined，引用退化为普通被动回复。
 */
function extractRefIdx(data: Record<string, unknown>): string | undefined {
  const scene = data.message_scene;
  if (!isRecord(scene)) return undefined;
  const ext = scene.ext;
  if (!Array.isArray(ext)) return undefined;
  for (const item of ext) {
    if (typeof item !== 'string') continue;
    if (!item.startsWith('msg_idx=')) continue;
    const value = item.slice('msg_idx='.length);
    if (value !== '') return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

void segmentsToCQ;
