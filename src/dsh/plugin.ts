import path from 'node:path';
import { mergeConfig, loadConfig, parseConfig, maskedAppId, type NoaConfig } from '../config.js';
import { dataDir as resolveDataDir, ensureDir } from '../store/json-store.js';
import { IdMapper } from '../core/idmap.js';
import { Rest } from '../official/rest.js';
import type { GatewayHandle, OfficialEventEnvelope } from '../official/gateway.js';
import { startBridge, type BridgeHandle } from '../bridge.js';
import type { Logger } from '../types.js';
import {
  detectDshQqbotActivation,
  installTakeover,
  loadDshQqbot,
  type CapturedBot,
  type TakeoverHandle,
  type TakeoverRawEvent,
  type TakeoverSink,
} from './takeover.js';
import { DshChatService, type DshHost } from './ai.js';

export const name = 'noa-ark';

export const inject: string[] = [];

export { Config } from './config-schema.js';

export interface DshPluginContext {
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  effect?: (callback: () => () => unknown, label?: string) => unknown;

  on?: (event: string, listener: () => unknown) => unknown;

  get?: (name: string) => unknown;
}

export interface DshTakeoverConf {

  appId: string;

  autoAckInteraction: boolean;

  isolation: 'auto' | 'always' | 'off';

  retryDelayMs: number;
}

export interface NormalizedDshConfig {
  config: NoaConfig;
  takeover: DshTakeoverConf;
}

export function normalizePluginConfig(
  raw: unknown,
  warn: (message: string) => void,
): NormalizedDshConfig {
  let base: NoaConfig;
  try {
    base = loadConfig(undefined, warn);
  } catch (err) {
    warn(`读取 ~/.noa/config.json 失败，改用默认配置：${err instanceof Error ? err.message : String(err)}`);
    base = parseConfig({});
  }
  const plain = unwrapVolatile(raw);
  const config = parseConfig(mergeConfig(base, plain), warn);

  const record = isRecord(plain) ? plain : {};
  const takeoverRaw = isRecord(record.takeover) ? record.takeover : {};
  const appId = typeof takeoverRaw.appId === 'string' ? takeoverRaw.appId.trim() : '';
  const autoAckInteraction = takeoverRaw.autoAckInteraction === true;
  const isolationRaw = takeoverRaw.isolation;
  const isolation: DshTakeoverConf['isolation'] = isolationRaw === 'always' || isolationRaw === 'off'
    ? isolationRaw
    : 'auto';
  if (isolationRaw !== undefined && isolationRaw !== 'auto' && isolationRaw !== 'always' && isolationRaw !== 'off') {
    warn(`takeover.isolation「${String(isolationRaw)}」无效，按 auto 运行`);
  }
  const retryRaw = takeoverRaw.retryDelayMs;
  const retryDelayMs = typeof retryRaw === 'number' && Number.isFinite(retryRaw) && retryRaw >= 0
    ? Math.floor(retryRaw)
    : 30_000;

  config.noa.autoAckInteraction = autoAckInteraction;

  return {
    config,
    takeover: { appId, autoAckInteraction, isolation, retryDelayMs },
  };
}

export function apply(ctx: DshPluginContext, rawConfig?: unknown): void {
  const logger = createDshLogger(ctx.logger);
  const normalized = normalizePluginConfig(rawConfig, (message) => logger.warn(`配置：${message}`));
  const host: DshHost = {
    get: (name) => {
      if (typeof ctx.get !== 'function') return undefined;
      try {
        return ctx.get(name);
      } catch {
        return undefined;
      }
    },
  };
  const ai = new DshChatService(host, normalized.config.dshChat, logger);
  const runtime = new TakeoverRuntime(normalized.config, normalized.takeover, logger, ai);

  let handle: TakeoverHandle | undefined;
  let disposed = false;

  ctx.on?.('loader/volatile-update', () => {
    if (disposed) return;
    const next = normalizePluginConfig(rawConfig, (message) => logger.warn(`配置：${message}`));
    runtime.applyConfig(next.config);
    runtime.applyTakeover(next.takeover);
  });

  ctx.effect?.(() => {
    return () => {
      disposed = true;
      handle?.uninstall();
      handle = undefined;
      void runtime.close();
      logger.info('已卸载 dsh 接管，OneBot 服务已关闭');
    };
  }, 'noa-ark.lifecycle');

  void (async () => {
    try {
      const resolved = await loadDshQqbot(logger);
      if (disposed) return;
      if (resolved === null) {
        logger.error('未找到 dsh 已安装的 dsh-qqbot / qqbot-nodejs，插件保持空闲');
        return;
      }
      handle = installTakeover(resolved.QQBot, runtime, logger);
      logger.info(`QQBot 旁路已挂载：${resolved.sdkPath}`);
      const activation = detectDshQqbotActivation();
      if (activation !== null && !activation.bundled) {
        logger.warn(
          `dsh-qqbot 已安装但未在当前 profile 的 dsh.profile.bundles 中启用（${activation.profileDir}）；`
          + '接管层会保持空闲。启用并扫码绑定后重启 dsh：dsh plugin --profile <profile> add @tencent-connect/dsh-qqbot',
        );
      }
      logger.info('等待 dsh-qqbot 的网关事件；收到 ready 或首条入站消息后启动 OneBot 服务');
    } catch (err) {
      logger.error(`接管 dsh-qqbot 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

export class TakeoverRuntime implements TakeoverSink {
  private readonly tap: EventTap;
  private readonly gateway: SyntheticGateway;
  private bridge: BridgeHandle | undefined;
  private starting = false;
  private restartRequested = false;
  private nextRetryAt = 0;
  private captured: CapturedBot | undefined;
  private suppressing = false;
  private closed = false;
  private readonly ignoredAppIds = new Set<string>();

  constructor(
    private config: NoaConfig,
    private takeoverConf: DshTakeoverConf,
    private readonly logger: Logger,
    private ai?: DshChatService,
  ) {
    this.tap = new EventTap(logger);
    this.gateway = createSyntheticGateway(this.tap);
  }

  get onebotUrl(): string | undefined {
    return this.bridge?.onebot?.url;
  }

  onBot(bot: CapturedBot): void {
    if (this.closed) return;
    if (this.takeoverConf.appId !== '' && bot.appId !== this.takeoverConf.appId) {
      if (!this.ignoredAppIds.has(bot.appId)) {
        this.ignoredAppIds.add(bot.appId);
        this.logger.warn(`忽略未匹配 takeover.appId 的 QQBot 实例（AppID：${maskedAppId(bot.appId)}）`);
      }
      return;
    }
    if (this.captured === undefined) {
      this.captured = bot;
      this.logger.info(`发现 dsh-qqbot 运行实例（AppID：${maskedAppId(bot.appId)}）`);
    } else if (this.captured.appId !== bot.appId) {
      if (!this.ignoredAppIds.has(bot.appId)) {
        this.ignoredAppIds.add(bot.appId);
        this.logger.warn(
          `忽略额外的 QQBot 实例（AppID：${maskedAppId(bot.appId)}）；已接管 ${maskedAppId(this.captured.appId)}`,
        );
      }
      return;
    }
    if (this.bridge !== undefined || this.starting) return;
    if (Date.now() < this.nextRetryAt) return;
    this.starting = true;
    this.gateway.markOnline();
    void this.start(bot).finally(() => {
      this.afterStart();
    });
  }

  applyConfig(next: NoaConfig): void {
    if (this.closed) return;
    const previous = this.config;
    this.config = next;
    this.ai?.setConfig(next.dshChat);
    if (onebotBindingKey(previous) === onebotBindingKey(next)) return;
    if (this.bridge === undefined && !this.starting) {
      this.logger.info('OneBot 配置已更新，将在下次启动时生效');
      return;
    }
    this.logger.info('OneBot 配置已更新，正在重建 OneBot 服务');
    void this.restart();
  }

  applyTakeover(next: DshTakeoverConf): void {
    if (this.closed) return;
    const previous = this.takeoverConf;
    this.takeoverConf = next;
    if (previous.isolation !== next.isolation) {
      this.logger.info(`回复隔离已切换：${next.isolation}`);
    }
  }

  onEvent(event: TakeoverRawEvent): void {
    if (!this.acceptsBot(event.botAppId)) return;
    this.gateway.markOnline();
    this.tap.push(event);
  }

  shouldSuppressDshMessage(event: TakeoverRawEvent): boolean {
    if (event.botAppId !== undefined && !this.acceptsBot(event.botAppId)) return false;
    if (this.takeoverConf.isolation === 'off') return false;
    if (this.bridge === undefined) {
      if (!this.starting) return false;

      const reverseMayConnect = this.config.onebot.mode !== 'forward'
        && this.config.onebot.reverseUrls.length > 0;
      return this.takeoverConf.isolation === 'always' || reverseMayConnect;
    }
    const onebotClients = (this.bridge.onebot?.clients ?? 0) + (this.bridge.reverse?.connections ?? 0);
    const suppress = this.takeoverConf.isolation === 'always'
      || (this.takeoverConf.isolation === 'auto' && onebotClients > 0);
    if (suppress !== this.suppressing) {
      this.suppressing = suppress;
      if (suppress) {
        const detail = this.takeoverConf.isolation === 'always'
          ? 'isolation=always'
          : `OneBot 客户端 ${onebotClients} 个在线`;
        this.logger.info(`隔离生效：${detail}，dsh-qqbot 暂停入站处理（避免双回复）`);
      } else {
        this.logger.info('隔离解除：dsh-qqbot 恢复处理入站消息');
      }
    }
    return suppress;
  }

  private acceptsBot(appId: string | undefined): boolean {
    if (appId === undefined) return true;
    if (this.takeoverConf.appId !== '' && appId !== this.takeoverConf.appId) return false;
    if (this.captured !== undefined && appId !== this.captured.appId) return false;
    return true;
  }

  onDisconnect(reason: string): void {
    this.gateway.markOffline();
    this.logger.warn(`QQ 网关断开：${reason}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.restartRequested = false;
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.close();
    await this.ai?.close();
  }

  private afterStart(): void {
    this.starting = false;
    if (!this.restartRequested) return;
    this.restartRequested = false;
    void this.restart();
  }

  private async restart(): Promise<void> {
    if (this.closed) return;
    const bot = this.captured;
    if (bot === undefined) return;
    if (this.starting) {
      this.restartRequested = true;
      return;
    }
    this.starting = true;
    this.nextRetryAt = 0;
    const bridge = this.bridge;
    this.bridge = undefined;
    await bridge?.close();
    if (this.closed) {
      this.starting = false;
      return;
    }
    try {
      await this.start(bot);
    } finally {
      this.afterStart();
    }
  }

  private async start(bot: CapturedBot): Promise<void> {
    try {
      const root = resolveDataDir(this.config.dataDir || undefined);
      ensureDir(root);
      ensureDir(path.join(root, 'registry'));

      const mapper = new IdMapper({
        file: path.join(root, 'registry', 'idmap.json'),
        capacity: 200_000,
        logger: this.logger,
      });
      const rest = new Rest({
        appId: bot.appId,
        appSecret: bot.appSecret,
        baseUrl: this.config.baseUrl || undefined,
        tokenBaseUrl: this.config.tokenBaseUrl || this.config.baseUrl || undefined,
        logger: this.logger,
      });

      const bridge = await startBridge({
        config: this.config,
        logger: this.logger,
        dataDir: root,
        appId: bot.appId,
        appSecret: bot.appSecret,
        mapper,
        rest,
        gateway: this.gateway,
        dshChat: () => this.config.dshChat,
        ...(this.ai === undefined ? {} : { ai: this.ai }),
      });
      if (this.closed) {
        await bridge.close();
        return;
      }
      this.bridge = bridge;

      this.logger.info(`已接管 QQ 连接（AppID：${maskedAppId(bot.appId)}），OneBot 使用同一凭据`);
      if (bridge.onebot !== undefined) {
        this.logger.info(`OneBot v11 正向 WS：${bridge.onebot.url}`);
      }
      if (bridge.reverse !== undefined) {
        this.logger.info(`OneBot v11 反向 WS：${this.config.onebot.reverseUrls.join(', ')}`);
      }
      if (bridge.onebot === undefined && bridge.reverse === undefined) {
        if (this.config.onebot.enable) {
          this.logger.warn(
            `OneBot 未开放任何 WS 通道（mode=${this.config.onebot.mode}，reverseUrls 为空）`,
          );
        } else {
          this.logger.warn('onebot.enable=false，未开放任何 OneBot 服务');
        }
      }
      if (bridge.milky !== undefined) {
        this.logger.info(`Milky v1.3：${bridge.milky.url}/api/:api + /event`);
      }
    } catch (err) {
      if (this.closed) return;
      this.bridge = undefined;
      this.nextRetryAt = Date.now() + this.takeoverConf.retryDelayMs;
      this.logger.error(
        `启动 noa 桥失败（${this.takeoverConf.retryDelayMs}ms 后重试）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

class EventTap {
  private handler: ((event: OfficialEventEnvelope) => void) | undefined;
  private pending: OfficialEventEnvelope[] = [];
  private dropped = 0;

  constructor(private readonly logger: Logger) {}

  push(event: OfficialEventEnvelope): void {
    if (this.handler !== undefined) {
      this.handler(event);
      return;
    }
    if (this.pending.length >= 500) {
      this.pending.shift();
      this.dropped += 1;
      return;
    }
    this.pending.push(event);
  }

  setHandler(handler: (event: OfficialEventEnvelope) => void): void {
    this.handler = handler;
    if (this.pending.length === 0) return;
    const queued = this.pending;
    this.pending = [];
    if (this.dropped > 0) {
      this.logger.warn(`桥启动期间事件缓冲溢出，丢弃 ${this.dropped} 条（已投递 ${queued.length} 条）`);
      this.dropped = 0;
    }
    for (const event of queued) handler(event);
  }
}

interface SyntheticGateway extends GatewayHandle {
  markOnline(): void;
  markOffline(): void;
}

function createSyntheticGateway(tap: EventTap): SyntheticGateway {
  let online = false;
  return {
    ready: Promise.resolve(),
    done: new Promise<void>(() => {

    }),
    get online(): boolean {
      return online;
    },
    stop(): void {
      online = false;
    },
    onEvent(handler: (event: OfficialEventEnvelope) => void): void {
      tap.setHandler(handler);
    },
    markOnline(): void {
      online = true;
    },
    markOffline(): void {
      online = false;
    },
  };
}

function createDshLogger(host: DshPluginContext['logger']): Logger {
  const prefix = '[noa-ark] ';
  const emit = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
  ): void => {
    const fn = host?.[level];
    if (typeof fn === 'function') {
      fn.call(host, prefix + message);
      return;
    }
    const fallback = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    fallback(prefix + message);
  };
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

export function unwrapVolatile(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) {
    const ref = value as unknown as { get?: unknown };
    if (typeof ref.get === 'function') {
      return unwrapVolatile((ref.get as () => unknown)());
    }
  }
  if (Array.isArray(value)) return value.map(unwrapVolatile);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = unwrapVolatile(item);
    }
    return out;
  }
  return value;
}

function onebotBindingKey(config: NoaConfig): string {
  const { enable, mode, wsPort, wsPath, accessToken, reverseUrls } = config.onebot;
  return JSON.stringify([enable, mode, wsPort, wsPath, accessToken, reverseUrls]);
}
