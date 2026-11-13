/**
 * noa-ark CLI
 *
 *   noa-ark start    连接官方 QQ 网关并启动 OneBot v11 兼容层
 *   noa-ark doctor   打印配置、凭据、端口与数据目录自检
 *   noa-ark version
 */

import path from 'node:path';
import { loadConfig, resolveCredentials, maskedAppId, enabledNoaExt, type NoaConfig } from './config.js';
import { createConsoleLogger, redact } from './types.js';
import { ensureDir, dataDir as resolveDataDir, safeSegment } from './store/json-store.js';
import { IdMapper } from './core/idmap.js';
import { Rest } from './official/rest.js';
import { connectGateway } from './official/gateway.js';
import { startBridge } from './bridge.js';
import { VERSION } from './version.js';

const USAGE = `noa-ark ${VERSION} — NOA 方舟计划：QQ 官方机器人 → OneBot v11 兼容层

用法：
  noa-ark start      连接官方网关并启动 OneBot v11 服务
  noa-ark doctor     自检：配置 / 凭据 / 端口 / 数据目录
  noa-ark version    显示版本
  noa-ark help       显示帮助

凭据（仅环境变量，不落盘）：
  NOA_APP_ID / NOA_APP_SECRET   （兼容 QQBOT_APPID / QQBOT_SECRET）
配置：
  NOA_CONFIG（默认 ~/.noa/config.json）
数据：
  NOA_HOME（默认 ~/.noa）→ data/
`;

async function commandStart(argv: string[]): Promise<void> {
  const logger = createConsoleLogger(process.env.NOA_DEBUG === '1');
  const config = loadConfig(undefined, (message) => logger.warn(`配置：${message}`));
  if (config.noa.ext.interaction && (config.intents & (1 << 26)) === 0) {
    logger.warn(
      'noa.ext.interaction 已启用，但 intents 未包含 1<<26（INTERACTION）；'
      + '请显式设置 intents=1<<25|1<<24|1<<26，否则收不到 INTERACTION_CREATE 事件',
    );
  }
  const credentials = resolveCredentials(config);
  if (credentials === null) {
    logger.error('缺少机器人凭据：请设置 NOA_APP_ID / NOA_APP_SECRET 环境变量。');
    process.exitCode = 1;
    return;
  }

  const root = resolveDataDir(config.dataDir || undefined);
  ensureDir(root);
  ensureDir(path.join(root, 'registry'));

  const mapper = new IdMapper({
    file: path.join(root, 'registry', 'idmap.json'),
    capacity: 200_000,
    logger,
  });

  const rest = new Rest({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    baseUrl: config.baseUrl || undefined,
    tokenBaseUrl: config.tokenBaseUrl || config.baseUrl || undefined,
    logger,
  });

  const gateway = connectGateway({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    baseUrl: config.baseUrl,
    tokenBaseUrl: config.tokenBaseUrl || config.baseUrl,
    logger,
    tokenProvider: () => rest.tokenForGateway(),
    intents: config.intents > 0 ? config.intents : undefined,
  });

  const bridge = await startBridge({
    config,
    logger,
    dataDir: root,
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    mapper,
    rest,
    gateway,
  });

  logger.info(`AppID：${maskedAppId(credentials.appId)}`);
  if (bridge.onebot !== undefined) {
    logger.info(`OneBot v11：${bridge.onebot.url}（正向 WS；HTTP API 已移除）`);
  }
  if (bridge.reverse !== undefined) {
    logger.info(`OneBot 反向 WS：${config.onebot.reverseUrls.join(', ')}`);
  }
  if (config.onebot.enable && bridge.onebot === undefined && bridge.reverse === undefined) {
    logger.warn(`OneBot 未开放任何 WS 通道（mode=${config.onebot.mode}，reverseUrls 为空）`);
  }
  if (bridge.milky !== undefined) {
    logger.info(`Milky v1.3：${bridge.milky.url}/api/:api + /event`);
  }
  logger.info(`数据目录：${root}`);

  try {
    await gateway.ready;
    logger.info('NOA 方舟适配器已上线，等待事件');
  } catch (error) {
    logger.error(`QQ 网关未就绪：${error instanceof Error ? redact(error.message) : String(error)}`);
  }

  const shutdown = (code = 0): void => {
    logger.info('正在退出…');
    gateway.stop();
    void bridge.close().finally(() => process.exit(code));
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  void gateway.done.then(() => {
    if (process.exitCode === undefined) shutdown(0);
  });

  void argv;
}

function commandDoctor(): void {
  const config = loadConfig(undefined, (message) => console.warn(`配置：${message}`));
  const credentials = resolveCredentials(config);
  const root = resolveDataDir(config.dataDir || undefined);
  const enabledExt = enabledNoaExt(config.noa.ext);
  const noaExtLine = enabledExt.length === 0
    ? '（全部关闭）'
    : `${enabledExt.join(', ')}${config.noa.ext.interaction && (config.intents & (1 << 26)) === 0
      ? '；⚠️ 需要 intents 包含 1<<26'
      : ''}`;

  const lines = [
    `noa-ark 自检（${VERSION}）`,
    `1. 配置：${process.env.NOA_CONFIG ?? path.join(process.env.NOA_HOME ?? path.join(process.env.HOME ?? '', '.noa'), 'config.json')}`,
    `2. 凭据：${credentials === null
      ? '❌ 未找到（设置 NOA_APP_ID / NOA_APP_SECRET）'
      : `✅ ${maskedAppId(credentials.appId)}（来源：环境变量）`}`,
    `3. ID 模式：${config.idMode}${config.idMode === 'mapped' ? '（openid → 稳定伪 QQ 号）' : '（openid 直通）'}`,
    `4. 被动超窗策略：${config.passiveOverflow}；网关 intents：${config.intents > 0
      ? String(config.intents)
      : '自动（1<<25 | 1<<24，平台 4014 时回退 1<<25）'}`,
    `5. OneBot v11：${config.onebot.enable
      ? `模式 ${config.onebot.mode}${config.onebot.mode === 'reverse'
        ? ''
        : `；正向 ws://127.0.0.1:${config.onebot.wsPort}${config.onebot.wsPath}`}（HTTP API 已移除）`
      : '（关闭）'}`,
    `6. 反向 WS：${config.onebot.mode === 'forward' || config.onebot.reverseUrls.length === 0
      ? '（未配置）'
      : config.onebot.reverseUrls.join(', ')}`,
    `7. noa/1 扩展：${noaExtLine}`,
    `8. 数据目录：${root}`,
    `9. 映射文件：${path.join(root, 'registry', safeSegment(credentials?.appId ?? 'unbound'), 'groups.json')} 与 idmap.json`,
    '10. 平台红线：不涉及协议逆向、不模拟客户端登录（仅官方开放平台能力）',
  ];
  console.info(lines.join('\n'));
  if (credentials === null) process.exitCode = 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  switch (command) {
    case 'start':
      await commandStart(argv.slice(1));
      return;
    case 'doctor':
      commandDoctor();
      return;
    case 'version':
    case '--version':
    case '-v':
      console.info(`noa-ark ${VERSION}`);
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.info(USAGE);
      return;
    default:
      console.error(`未知命令：${command}\n`);
      console.info(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
