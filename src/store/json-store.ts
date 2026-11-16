import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path, { dirname } from 'node:path';

export type CorruptHandler = (file: string, backup: string, error: unknown) => void;

export function readJson<T>(file: string, fallback: T, onCorrupt?: CorruptHandler): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
    } catch {
      try {
        copyFileSync(file, backup);
      } catch {

      }
    }
    onCorrupt?.(file, backup, err);
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export function noaHome(): string {
  return process.env.NOA_HOME ?? path.join(os.homedir(), '.noa');
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return process.env.NOA_CONFIG ?? path.join(noaHome(), 'config.json');
}

export function dataDir(root?: string): string {
  return root ?? path.join(noaHome(), 'data');
}

export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
}
