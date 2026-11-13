/**
 * noa-ark dsh 插件入口（Host 半边）。
 *
 * 载入后：
 *   1. 找到 dsh 已安装的 dsh-qqbot 所用的 @tencent-connect/qqbot-nodejs；
 *   2. 包装 QQBot 的 handleInboundMessage（消息，中间件之前）与 emit
 *      （非消息事件 / interaction / ready / disconnected）；
 *   3. 首次看到 QQBot 实例时，用它的凭据启动 noa 桥：
 *        - 官方入站消息/事件 → OneBot v11 事件；
 *        - OneBot 动作 → 官方 REST（同一凭据；被动窗口独立计数，
 *          隔离生效时只有一方发送）；
 *        - 对外提供 OneBot v11 正向 WS + 反向 WS。
 *
 * 不另开 QQ WebSocket：同一机器人第二条网关连接会与 dsh-qqbot 互相顶号。
 */

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

export const name = 'noa-ark';
/** 不依赖 dsh 服务；只需 Host 生命周期。 */
export const inject: string[] = [];

/** dsh 设置页读取的 Config schema（volatile 字段见 config-schema.ts）。 */
export { Config } from './config-schema.js';

export interface DshPluginContext {
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
  effect?: (callback: () => () => unknown, label?: string) => unknown;
  /** Cordis 事件；volatile 字段保存后触发 loader/volatile-update。 */
  on?: (event: string, listener: () => unknown) => unknown;
}

export interface DshTakeoverConf {
  /** 非空时只接管该 AppID 的 QQBot 实例。 */
  appId: string;
  /** 接管模式下默认 false：INTERACTION_CREATE 的 ACK 由 dsh-qqbot 负责。 */
  autoAckInteraction: boolean;
  /**
   * 回复隔离：
   *   auto   — 有 OneBot 客户端在线时，dsh-qqbot 不处理入站消息（默认）；
   *   always — 始终由 OneBot 侧处理，dsh 不回复；
   *   off    — 不做隔离（不推荐，可能与 OneBot 同时回复）。
   */
  isolation: 'auto' | 'always' | 'off';
  /** 桥启动失败后的重试间隔（毫秒）。 */
  retryDelayMs: number;
}

export interface NormalizedDshConfig {
  config: NoaConfig;
  takeover: DshTakeoverConf;
}

/**
 * 合并三处配置：noa 默认值 → ~/.noa/config.json → 插件行 config。
 * 凭据不从这里取，接管时直接用运行中 QQBot 的 getCredentials()。
 */
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

  // 接管模式下 INTERACTION_CREATE 会同时到达 dsh-qqbot；默认不抢 ACK。
  config.noa.autoAckInteraction = autoAckInteraction;

  return {
    config,
    takeover: { appId, autoAckInteraction, isolation, retryDelayMs },
  };
}

export function apply(ctx: DshPluginContext, rawConfig?: unknown): void {
  const logger = createDshLogger(ctx.logger);
  const normalized = normalizePluginConfig(rawConfig, (message) => logger.warn(`配置：${message}`));
  const runtime = new TakeoverRuntime(normalized.config, normalized.takeover, logger);

  let handle: TakeoverHandle | undefined;
  let disposed = false;

  // 设置页保存 volatile 字段后，用新值重建 OneBot 服务。
  ctx.on?.('loader/volatile-update', () => {
    if (disposed) return;
    runtime.applyConfig(normalizePluginConfig(rawConfig, (message) => logger.warn(`配置：${message}`)).config);
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

// —— 运行时 ————————————————————————————————

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
    private readonly takeoverConf: DshTakeoverConf,
    private readonly logger: Logger,
  ) {
    this.tap = new EventTap(logger);
    this.gateway = createSyntheticGateway(this.tap);
  }

  /** 正向 WS 地址；桥未启动时为 undefined（排障/测试用）。 */
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

  /**
   * dsh 设置页保存 volatile 字段后调用。
   * WS 绑定相关字段变化时重建 OneBot 服务；其余字段等下一次启动生效。
   */
  applyConfig(next: NoaConfig): void {
    if (this.closed) return;
    const previous = this.config;
    this.config = next;
    if (onebotBindingKey(previous) === onebotBindingKey(next)) return;
    if (this.bridge === undefined && !this.starting) {
      this.logger.info('OneBot 配置已更新，将在下次启动时生效');
      return;
    }
    this.logger.info('OneBot 配置已更新，正在重建 OneBot 服务');
    void this.restart();
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
      // 启动窗口：always 全归 OneBot；auto 下只有反向 WS 可能在桥就绪前
      // 抢先回复，才把首条消息按 OneBot 归属，避免单条双处理。
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

  /** 只接受已接管实例的事件；额外 QQBot 实例的事件不进入 OneBot。 */
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

// —— 事件缓冲 ————————————————————————————————

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

// —— 合成网关 ————————————————————————————————

interface SyntheticGateway extends GatewayHandle {
  markOnline(): void;
  markOffline(): void;
}

/**
 * noa 桥只关心“事件流”和“是否在线”，不拥有连接生命周期。
 * stop() 只标记离线，绝不调用 dsh-qqbot 的 bot.stop()。
 */
function createSyntheticGateway(tap: EventTap): SyntheticGateway {
  let online = false;
  return {
    ready: Promise.resolve(),
    done: new Promise<void>(() => {
      // 由 dsh 进程生命周期决定，永不 settle
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

// —— 日志 ——————————————————————————————————

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

/** dsh 把 `.volatile()` 字段传成稳定引用；合并配置前取一次快照。 */
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

/** WS 绑定字段；变化后需要重建监听/反向连接，其余配置可等下次启动。 */
function onebotBindingKey(config: NoaConfig): string {
  const { enable, mode, wsPort, wsPath, accessToken, reverseUrls } = config.onebot;
  return JSON.stringify([enable, mode, wsPort, wsPath, accessToken, reverseUrls]);
}
