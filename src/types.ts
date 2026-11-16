export type Scope = 'group' | 'c2c';

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

export function redact(value: string): string {
  return value
    .replace(/(appSecret\s*[:=]\s*)\S+/gi, '$1***')
    .replace(/("appSecret"\s*:\s*")[^"]*(")/gi, '$1***$2')
    .replace(/(secret\s*[:=]\s*)\S+/gi, '$1***');
}

export type OfficialScope = 'group' | 'c2c';

export type PassiveOverflow = 'fail' | 'proactive';

export type IdMode = 'mapped' | 'passthrough';
