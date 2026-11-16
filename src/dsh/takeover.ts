import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../types.js';

export interface TakeoverRawEvent {
  eventType: string;
  data: Record<string, unknown>;

  botAppId?: string;
}

export interface CapturedBot {
  appId: string;
  appSecret: string;
}

export interface TakeoverSink {

  onBot(bot: CapturedBot): void;

  onEvent(event: TakeoverRawEvent): void;

  shouldSuppressDshMessage?(event: TakeoverRawEvent): boolean;

  onDisconnect?(reason: string): void;
}

export interface TakeoverHandle {
  readonly installed: boolean;

  uninstall(): void;
}

export interface QqbotClassLike {
  prototype: unknown;
}

export interface ResolvedQqbot {
  QQBot: new (options: Record<string, unknown>) => unknown;

  sdkPath: string;

  packageDir: string;
}

const STATE_KEY = Symbol.for('noa-ark.dsh.takeover.state');

interface TakeoverState {
  originalEmit: (event: string, ...args: unknown[]) => unknown;
  originalHandleInbound: ((raw: unknown) => unknown) | undefined;

  inboundPatched: boolean;
  sinks: Set<InstalledSink>;
}

interface InstalledSink {
  sink: TakeoverSink;
}

interface CredentialedBot {
  getCredentials?: () => { appId?: unknown; clientSecret?: unknown };
  appId?: unknown;
}

export function installTakeover(
  qqbot: QqbotClassLike,
  sink: TakeoverSink,
  logger: Logger,
): TakeoverHandle {
  const proto = qqbot.prototype as Record<string | symbol, unknown>;
  let state = proto[STATE_KEY] as TakeoverState | undefined;

  if (state === undefined) {
    const originalEmit = proto.emit;
    if (typeof originalEmit !== 'function') {
      throw new Error('QQBot.prototype.emit 不存在，无法接管（SDK 版本不兼容？）');
    }
    const originalHandleInbound = proto.handleInboundMessage;
    const inboundPatched = typeof originalHandleInbound === 'function';
    state = {
      originalEmit: originalEmit as TakeoverState['originalEmit'],
      originalHandleInbound: inboundPatched
        ? (originalHandleInbound as (raw: unknown) => unknown)
        : undefined,
      inboundPatched,
      sinks: new Set(),
    };
    Object.defineProperty(proto, STATE_KEY, {
      value: state,
      enumerable: false,
      configurable: true,
      writable: false,
    });

    if (state.inboundPatched) {
      proto.handleInboundMessage = function patchedHandleInbound(this: unknown, raw: unknown): unknown {
        let allow = true;
        try {
          allow = dispatchInbound(state!, this, raw, logger);
        } catch (err) {
          logger.debug(`[dsh] 入站旁路异常：${err instanceof Error ? err.message : String(err)}`);
        }
        if (!allow) return Promise.resolve();
        return state!.originalHandleInbound!.call(this, raw);
      };
    }

    proto.emit = function patchedEmit(this: unknown, event: string, ...args: unknown[]): unknown {
      try {
        if (!dispatchEmit(state!, this, event, args, logger)) return Promise.resolve();
      } catch (err) {
        logger.debug(`[dsh] 接管旁路异常：${err instanceof Error ? err.message : String(err)}`);
      }
      return state!.originalEmit.apply(this, [event, ...args]);
    };
  }

  const installedSink: InstalledSink = { sink };
  state.sinks.add(installedSink);
  const installedState = state;

  return {
    installed: true,
    uninstall(): void {
      installedState.sinks.delete(installedSink);
      if (installedState.sinks.size > 0) return;
      if (proto.emit !== undefined) proto.emit = installedState.originalEmit;
      if (installedState.inboundPatched && installedState.originalHandleInbound !== undefined) {
        proto.handleInboundMessage = installedState.originalHandleInbound;
      }
      delete proto[STATE_KEY];
    },
  };
}

export interface DshQqbotActivation {

  bundled: boolean;
  profileDir: string;
}

export function detectDshQqbotActivation(): DshQqbotActivation | null {
  for (const profileDir of candidateProfileDirs()) {
    const packageFile = path.join(profileDir, 'package.json');
    if (!existsSync(packageFile)) continue;
    try {
      const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown } };
      };
      const bundles = manifest.dsh?.profile?.bundles;
      if (!Array.isArray(bundles)) continue;
      return {
        bundled: bundles.includes('@tencent-connect/dsh-qqbot'),
        profileDir,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function loadDshQqbot(logger: Logger): Promise<ResolvedQqbot | null> {
  const profileDirs = candidateProfileDirs();
  for (const profileDir of profileDirs) {
    for (const modulesDir of moduleDirs(profileDir)) {
      const dshQqbotDir = path.join(modulesDir, '@tencent-connect', 'dsh-qqbot');
      if (!existsSync(path.join(dshQqbotDir, 'package.json'))) continue;
      const nested = await tryLoadSdk(
        path.join(dshQqbotDir, 'node_modules', '@tencent-connect', 'qqbot-nodejs'),
        dshQqbotDir,
      );
      if (nested !== null) return nested;
      const hoisted = await tryLoadSdk(
        path.join(modulesDir, '@tencent-connect', 'qqbot-nodejs'),
        dshQqbotDir,
      );
      if (hoisted !== null) return hoisted;
    }
  }

  for (const profileDir of profileDirs) {
    for (const modulesDir of moduleDirs(profileDir)) {
      const direct = await tryLoadSdk(
        path.join(modulesDir, '@tencent-connect', 'qqbot-nodejs'),
        profileDir,
      );
      if (direct !== null) return direct;
    }
  }
  logger.warn('[dsh] 未找到 @tencent-connect/dsh-qqbot 或 @tencent-connect/qqbot-nodejs；接管不会生效');
  return null;
}

function moduleDirs(profileDir: string): string[] {
  const dirs = [path.join(profileDir, 'node_modules'), path.join(profileDir, 'dependencies', 'node_modules')];
  return dirs.filter((dir, index) => dirs.indexOf(dir) === index);
}

async function tryLoadSdk(sdkDir: string, packageDir: string): Promise<ResolvedQqbot | null> {
  const packageFile = path.join(sdkDir, 'package.json');
  if (!existsSync(packageFile)) return null;
  try {
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as { main?: unknown };
    const main = typeof manifest.main === 'string' && manifest.main !== ''
      ? manifest.main
      : './dist/index.js';
    const entry = path.resolve(sdkDir, main);
    if (!existsSync(entry)) return null;
    const mod = (await import(pathToFileURL(entry).href)) as { QQBot?: unknown };
    if (typeof mod.QQBot !== 'function') return null;
    return {
      QQBot: mod.QQBot as ResolvedQqbot['QQBot'],
      sdkPath: entry,
      packageDir,
    };
  } catch {
    return null;
  }
}

function candidateProfileDirs(): string[] {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dirs: string[] = [];
  const add = (dir: string | undefined): void => {
    if (dir !== undefined && dir !== '' && !dirs.includes(dir)) dirs.push(dir);
  };

  add(process.env.DSH_PROFILE_DIR);
  const profile = process.env.DSH_PROFILE;
  if (profile !== undefined && profile !== '') add(path.join(home, 'profiles', profile));
  add(path.join(home, 'profiles', 'desktop'));

  try {
    for (const name of readdirSync(path.join(home, 'profiles'))) {
      add(path.join(home, 'profiles', name));
    }
  } catch {

  }
  return dirs;
}

function dispatchInbound(
  state: TakeoverState,
  bot: unknown,
  raw: unknown,
  logger: Logger,
): boolean {
  const parsed = readInboundEvent(raw);
  if (parsed === null) return true;
  const creds = readCredentials(bot);
  const event: TakeoverRawEvent = creds === null ? parsed : { ...parsed, botAppId: creds.appId };
  notifyBot(state, bot, logger);

  let suppress = false;
  for (const { sink } of state.sinks) {
    try {
      sink.onEvent(event);
    } catch (err) {
      logger.debug(`[dsh] onEvent 回调异常：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (sink.shouldSuppressDshMessage?.(event) === true) suppress = true;
    } catch (err) {
      logger.debug(`[dsh] 隔离判定异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return !suppress;
}

function dispatchEmit(
  state: TakeoverState,
  bot: unknown,
  event: string,
  args: unknown[],
  logger: Logger,
): boolean {
  if (event === 'rawEvent') {
    const raw = readRawEvent(args[0]);
    if (raw === null) return true;
    notifyBot(state, bot, logger);
    forwardToSinks(state, withBotAppId(raw, bot), logger);
    return true;
  }

  if (event === 'interaction') {
    notifyBot(state, bot, logger);
    const interaction = readInteraction(args);
    if (interaction !== null) {
      forwardToSinks(
        state,
        withBotAppId({ eventType: 'INTERACTION_CREATE', data: interaction }, bot),
        logger,
      );
    }
    return true;
  }

  if (event === 'message' && !state.inboundPatched) {

    const message = args[1] ?? (isRecord(args[0]) ? args[0].message : undefined);
    const raw = readInboundEvent(message);
    if (raw === null) return true;
    const enriched = withBotAppId(raw, bot);
    notifyBot(state, bot, logger);
    forwardToSinks(state, enriched, logger);
    for (const { sink } of state.sinks) {
      try {
        if (sink.shouldSuppressDshMessage?.(enriched) === true) return false;
      } catch (err) {
        logger.debug(`[dsh] 隔离判定异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return true;
  }

  if (event === 'ready' || event === 'resumed') {
    notifyBot(state, bot, logger);
    return true;
  }

  if (event === 'disconnected') {
    const reason = readDisconnectReason(args[0]);
    for (const { sink } of state.sinks) {
      try {
        sink.onDisconnect?.(reason);
      } catch {

      }
    }
  }
  return true;
}

function forwardToSinks(state: TakeoverState, event: TakeoverRawEvent, logger: Logger): void {
  for (const { sink } of state.sinks) {
    try {
      sink.onEvent(event);
    } catch (err) {
      logger.debug(`[dsh] onEvent 回调异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function withBotAppId(event: TakeoverRawEvent, bot: unknown): TakeoverRawEvent {
  const creds = readCredentials(bot);
  return creds === null ? event : { ...event, botAppId: creds.appId };
}

function notifyBot(state: TakeoverState, bot: unknown, logger: Logger): void {
  const creds = readCredentials(bot);
  if (creds === null) return;
  for (const { sink } of state.sinks) {
    try {
      sink.onBot(creds);
    } catch (err) {
      logger.debug(`[dsh] onBot 回调异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function readCredentials(bot: unknown): CapturedBot | null {
  if (typeof bot !== 'object' || bot === null) return null;
  const candidate = bot as CredentialedBot;
  try {
    const creds = candidate.getCredentials?.();
    if (creds !== undefined) {
      const appId = typeof creds.appId === 'string' ? creds.appId : '';
      const appSecret = typeof creds.clientSecret === 'string' ? creds.clientSecret : '';
      if (appId !== '' && appSecret !== '') return { appId, appSecret };
    }
  } catch {

  }
  return null;
}

function readRawEvent(value: unknown): TakeoverRawEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const ctx = value as { eventType?: unknown; data?: unknown };
  if (typeof ctx.eventType !== 'string' || ctx.eventType === '') return null;
  if (typeof ctx.data !== 'object' || ctx.data === null || Array.isArray(ctx.data)) return null;
  return { eventType: ctx.eventType, data: ctx.data as Record<string, unknown> };
}

function readInboundEvent(value: unknown): TakeoverRawEvent | null {
  if (!isRecord(value)) return null;
  const eventType = typeof value.rawEventType === 'string' ? value.rawEventType : '';
  if (eventType === '') return null;
  const data = value.raw;
  if (!isRecord(data)) return null;
  return { eventType, data };
}

function readInteraction(args: unknown[]): Record<string, unknown> | null {
  const direct = args[1];
  if (isRecord(direct)) return direct;
  const ctx = args[0];
  if (isRecord(ctx) && isRecord(ctx.event)) return ctx.event;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDisconnectReason(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'unknown';
  const event = value as { code?: unknown; reason?: unknown; willReconnect?: unknown };
  const code = typeof event.code === 'number' ? event.code : 0;
  const reason = typeof event.reason === 'string' && event.reason !== '' ? ` ${event.reason}` : '';
  const reconnect = event.willReconnect === true ? '（将重连）' : '（不再重连）';
  return `code=${code}${reason}${reconnect}`;
}
