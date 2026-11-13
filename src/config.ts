/**
 * Config model for noa-ark.
 *
 * Credentials (appId/appSecret) are provided via environment variables
 * only — they never persist to config.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { configPath } from './store/json-store.js';

export type IdMode = 'mapped' | 'passthrough';
export type PassiveOverflow = 'fail' | 'proactive';
/** OneBot WS 工作模式：正向（服务端）/ 反向（客户端）/ 两者同时。 */
export type WsMode = 'forward' | 'reverse' | 'both';

export interface OneBotConf {
  enable: boolean;
  mode: WsMode;
  accessToken: string;
  /** WS 监听端口（正向 WebSocket；HTTP API 已移除）。 */
  wsPort: number;
  wsPath: string;
  reverseUrls: string[];
}

export interface MilkyConf {
  enable: boolean;
  port: number;
  accessToken: string;
}

/**
 * noa/1 扩展能力开关（文档 §2.4）。
 * 全部默认关闭；未启用时对应段/动作按「能力不存在」明确失败。
 */
export interface NoaExtConf {
  markdown: boolean;
  keyboard: boolean;
  card: boolean;
  interaction: boolean;
  typing: boolean;
  menu: boolean;
  joinPolicy: boolean;
  stream: boolean;
  wakeup: boolean;
}

export interface NoaConf {
  ext: NoaExtConf;
  /** 收到 INTERACTION_CREATE（type 11/12）时先自动 ACK code=0。 */
  autoAckInteraction: boolean;
  /** 事件里是否附带官方原始 d。 */
  interactionRaw: boolean;
}

export interface NoaConfig {
  appId: string;
  appSecret: string;
  /** REST/WSS base override; empty = official default. */
  baseUrl: string;
  tokenBaseUrl: string;
  dataDir: string;
  idMode: IdMode;
  passiveOverflow: PassiveOverflow;
  /**
   * 网关 intents 覆盖值；0 = 自动（1<<25 | 1<<24，平台拒绝时回退 1<<25）。
   */
  intents: number;
  /** Per-peer daily proactive cap (local estimate; platform verdict wins). */
  dailyLimitPerPeer: number;
  /** Per-peer proactive messages per minute. */
  perMinuteLimit: number;
  botQpsLimit: number;
  botQpmLimit: number;
  logEnabled: boolean;
  onebot: OneBotConf;
  milky: MilkyConf;
  noa: NoaConf;
}

export const DEFAULT_NOA_EXT: NoaExtConf = {
  markdown: false,
  keyboard: false,
  card: false,
  interaction: false,
  typing: false,
  menu: false,
  joinPolicy: false,
  stream: false,
  wakeup: false,
};

export const DEFAULT_CONFIG: NoaConfig = {
  appId: '',
  appSecret: '',
  baseUrl: 'https://api.bot.qq.com',
  tokenBaseUrl: 'https://api.bot.qq.com',
  dataDir: '',
  idMode: 'mapped',
  passiveOverflow: 'fail',
  intents: 0,
  dailyLimitPerPeer: 1000,
  perMinuteLimit: 20,
  botQpsLimit: 5,
  botQpmLimit: 30,
  logEnabled: true,
  onebot: {
    enable: true,
    mode: 'both',
    accessToken: '',
    wsPort: 7791,
    wsPath: '/ws',
    reverseUrls: [],
  },
  milky: {
    enable: false,
    port: 7792,
    accessToken: '',
  },
  noa: {
    ext: { ...DEFAULT_NOA_EXT },
    autoAckInteraction: true,
    interactionRaw: false,
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep-merge config; arrays replace wholesale; dangerous keys ignored. */
export function mergeConfig<T>(base: T, patch: unknown): T {
  if (!isObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const current = out[key];
    if (isObject(current)) {
      if (isObject(value)) out[key] = mergeConfig(current, value);
    } else if (Array.isArray(current)) {
      if (Array.isArray(value)) out[key] = value;
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Only warns; invalid values fall back in normalize(). */
export function validateConfig(config: NoaConfig): string[] {
  const warnings: string[] = [];
  if (!['mapped', 'passthrough'].includes(config.idMode)) {
    warnings.push(`idMode「${String(config.idMode)}」无效，按 mapped 运行`);
  }
  if (!['fail', 'proactive'].includes(config.passiveOverflow)) {
    warnings.push(`passiveOverflow「${String(config.passiveOverflow)}」无效，按 fail 运行`);
  }
  if (!Number.isInteger(config.intents) || config.intents < 0) {
    warnings.push('intents 必须是 >=0 的整数（0 表示自动）');
  }
  if (!Number.isInteger(config.onebot.wsPort) || config.onebot.wsPort < 0 || config.onebot.wsPort > 65535) {
    warnings.push('onebot.wsPort 必须是 0..65535 的整数');
  }
  if (!['forward', 'reverse', 'both'].includes(config.onebot.mode)) {
    warnings.push('onebot.mode 必须是 forward、reverse 或 both');
  }
  if (config.onebot.mode === 'reverse' && config.onebot.reverseUrls.length === 0) {
    warnings.push('onebot.mode=reverse 但 reverseUrls 为空，不会连接任何反向 WS');
  }
  if (!Array.isArray(config.onebot.reverseUrls)) warnings.push('onebot.reverseUrls 必须是数组');
  if (!Number.isInteger(config.milky.port) || config.milky.port < 0 || config.milky.port > 65535) {
    warnings.push('milky.port 必须是 0..65535 的整数');
  }
  if (!Number.isInteger(config.dailyLimitPerPeer) || config.dailyLimitPerPeer <= 0) {
    warnings.push('dailyLimitPerPeer 必须是正整数');
  }
  if (!Number.isInteger(config.perMinuteLimit) || config.perMinuteLimit <= 0) {
    warnings.push('perMinuteLimit 必须是正整数');
  }
  if (!Number.isInteger(config.botQpsLimit) || config.botQpsLimit <= 0) {
    warnings.push('botQpsLimit 必须是正整数');
  }
  if (!Number.isInteger(config.botQpmLimit) || config.botQpmLimit <= 0) {
    warnings.push('botQpmLimit 必须是正整数');
  }
  for (const [name, value] of Object.entries(config.noa?.ext ?? {})) {
    if (typeof value !== 'boolean') warnings.push(`noa.ext.${name} 必须是布尔值`);
  }
  if (typeof config.noa?.autoAckInteraction !== 'boolean') {
    warnings.push('noa.autoAckInteraction 必须是布尔值');
  }
  if (typeof config.noa?.interactionRaw !== 'boolean') {
    warnings.push('noa.interactionRaw 必须是布尔值');
  }
  return warnings;
}

function normalizeNoaExt(raw: unknown): NoaExtConf {
  const source = isObject(raw) ? raw : {};
  const ext = { ...DEFAULT_NOA_EXT };
  for (const key of Object.keys(DEFAULT_NOA_EXT) as Array<keyof NoaExtConf>) {
    if (typeof source[key] === 'boolean') ext[key] = source[key] as boolean;
  }
  return ext;
}

function normalize(config: NoaConfig): NoaConfig {
  if (config.idMode !== 'mapped' && config.idMode !== 'passthrough') config.idMode = 'mapped';
  if (config.passiveOverflow !== 'fail' && config.passiveOverflow !== 'proactive') {
    config.passiveOverflow = 'fail';
  }
  if (!Number.isInteger(config.intents) || config.intents < 0) config.intents = 0;
  if (typeof config.onebot !== 'object' || config.onebot === null) {
    config.onebot = { ...DEFAULT_CONFIG.onebot };
  }
  if (typeof config.milky !== 'object' || config.milky === null) {
    config.milky = { ...DEFAULT_CONFIG.milky };
  }
  if (!Number.isInteger(config.onebot.wsPort) || config.onebot.wsPort < 0 || config.onebot.wsPort > 65535) {
    config.onebot.wsPort = DEFAULT_CONFIG.onebot.wsPort;
  }
  if (config.onebot.mode !== 'forward' && config.onebot.mode !== 'reverse' && config.onebot.mode !== 'both') {
    config.onebot.mode = DEFAULT_CONFIG.onebot.mode;
  }
  if (!Array.isArray(config.onebot.reverseUrls)) config.onebot.reverseUrls = [];
  if (!Number.isInteger(config.milky.port) || config.milky.port < 0 || config.milky.port > 65535) {
    config.milky.port = DEFAULT_CONFIG.milky.port;
  }
  if (typeof config.noa !== 'object' || config.noa === null) {
    config.noa = { ...DEFAULT_CONFIG.noa, ext: { ...DEFAULT_NOA_EXT } };
  }
  config.noa.ext = normalizeNoaExt(config.noa.ext);
  if (typeof config.noa.autoAckInteraction !== 'boolean') config.noa.autoAckInteraction = true;
  if (typeof config.noa.interactionRaw !== 'boolean') config.noa.interactionRaw = false;
  if (!Number.isInteger(config.dailyLimitPerPeer) || config.dailyLimitPerPeer <= 0) {
    config.dailyLimitPerPeer = DEFAULT_CONFIG.dailyLimitPerPeer;
  }
  if (!Number.isInteger(config.perMinuteLimit) || config.perMinuteLimit <= 0) {
    config.perMinuteLimit = DEFAULT_CONFIG.perMinuteLimit;
  }
  if (!Number.isInteger(config.botQpsLimit) || config.botQpsLimit <= 0) {
    config.botQpsLimit = DEFAULT_CONFIG.botQpsLimit;
  }
  if (!Number.isInteger(config.botQpmLimit) || config.botQpmLimit <= 0) {
    config.botQpmLimit = DEFAULT_CONFIG.botQpmLimit;
  }
  return config;
}

/** Parse an arbitrary JSON object into a full config; doesn't touch files. */
export function parseConfig(raw: unknown, onWarn?: (message: string) => void): NoaConfig {
  const merged = mergeConfig(DEFAULT_CONFIG, raw);
  for (const warning of validateConfig(merged)) onWarn?.(warning);
  return normalize(merged);
}

export function loadConfig(file?: string, onWarn?: (message: string) => void): NoaConfig {
  const target = file ?? configPath();
  let raw: unknown = {};
  if (existsSync(target)) {
    try {
      raw = JSON.parse(readFileSync(target, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败: ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return parseConfig(raw, onWarn);
}

/** Credentials are env-only; the config file never carries them. */
export function resolveCredentials(config: NoaConfig): { appId: string; appSecret: string } | null {
  const appId = process.env.NOA_APP_ID ?? process.env.QQBOT_APPID ?? config.appId;
  const appSecret = process.env.NOA_APP_SECRET ?? process.env.QQBOT_SECRET ?? config.appSecret;
  if (appId && appSecret) return { appId, appSecret };
  return null;
}

export function maskedAppId(appId: string): string {
  if (appId.length <= 4) return appId === '' ? '(空)' : `${appId[0]}***`;
  return `${appId.slice(0, 4)}***${appId.slice(-2)}`;
}

/** 已启用的 noa/1 能力名（供 get_version_info 的 noa_ext 字段）。 */
export function enabledNoaExt(ext: NoaExtConf): string[] {
  return (Object.keys(ext) as Array<keyof NoaExtConf>).filter((key) => ext[key]);
}
