/** 共享低层类型与工具函数。 */

export type Scope = 'group' | 'c2c';

/** 各子系统共用的结构化日志接口。 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createConsoleLogger(debugEnabled: boolean): Logger {
  const stamp = (): string => new Date().toISOString();
  return {
    debug: (m) => {
      if (debugEnabled) console.debug(`[${stamp()}] DEBUG ${m}`);
    },
    info: (m) => console.info(`[${stamp()}] INFO  ${m}`),
    warn: (m) => console.warn(`[${stamp()}] WARN  ${m}`),
    error: (m) => console.error(`[${stamp()}] ERROR ${m}`),
  };
}

/** 日志里出现的敏感串统一遮蔽。 */
export function redact(value: string): string {
  return value
    .replace(/(appSecret\s*[:=]\s*)\S+/gi, '$1***')
    .replace(/("appSecret"\s*:\s*")[^"]*(")/gi, '$1***$2')
    .replace(/(secret\s*[:=]\s*)\S+/gi, '$1***');
}

/** 消息相对于适配器的方向。 */

/** 官方 API 作用域：群聊或单聊。 */
export type OfficialScope = 'group' | 'c2c';

/** 超出被动窗口时的处理策略。 */
export type PassiveOverflow = 'fail' | 'proactive';

/** ID 暴露给上层的方式。 */
export type IdMode = 'mapped' | 'passthrough';
