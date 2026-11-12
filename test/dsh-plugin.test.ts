import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectDshQqbotActivation } from '../src/dsh/takeover.js';
import { normalizePluginConfig } from '../src/dsh/plugin.js';

let dir = '';
let previousConfig: string | undefined;
let previousHome: string | undefined;
let previousProfile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'noa-dsh-'));
  previousConfig = process.env.NOA_CONFIG;
  previousHome = process.env.DSH_HOME;
  previousProfile = process.env.DSH_PROFILE;
  process.env.NOA_CONFIG = path.join(dir, 'config.json');
  process.env.DSH_HOME = path.join(dir, 'home');
  process.env.DSH_PROFILE = 'test';
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.NOA_CONFIG;
  else process.env.NOA_CONFIG = previousConfig;
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  if (previousProfile === undefined) delete process.env.DSH_PROFILE;
  else process.env.DSH_PROFILE = previousProfile;
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizePluginConfig', () => {
  it('defaults to takeover isolation auto and disables auto ACK', () => {
    const { config, takeover } = normalizePluginConfig(undefined, () => undefined);

    expect(config.onebot.enable).toBe(true);
    expect(config.onebot.wsPort).toBe(7791);
    expect(config.onebot.wsPath).toBe('/ws');
    expect(takeover).toEqual({
      appId: '',
      autoAckInteraction: false,
      isolation: 'auto',
      retryDelayMs: 30_000,
    });
    expect(config.noa.autoAckInteraction).toBe(false);
  });

  it('keeps the noa config-file autoAck flag from leaking into takeover mode', () => {
    writeFileSync(
      process.env.NOA_CONFIG!,
      JSON.stringify({ noa: { autoAckInteraction: true }, onebot: { wsPort: 7788 } }),
    );

    const { config, takeover } = normalizePluginConfig({}, () => undefined);
    expect(config.onebot.wsPort).toBe(7788);
    expect(takeover.autoAckInteraction).toBe(false);
    expect(config.noa.autoAckInteraction).toBe(false);
  });

  it('applies row overrides and accepts explicit isolation/ACK settings', () => {
    const warnings: string[] = [];
    const { config, takeover } = normalizePluginConfig(
      {
        passiveOverflow: 'proactive',
        onebot: { wsPort: 7800, reverseUrls: ['ws://127.0.0.1:6700'] },
        takeover: {
          appId: '123456',
          autoAckInteraction: true,
          isolation: 'always',
          retryDelayMs: 5000,
        },
      },
      (message) => warnings.push(message),
    );

    expect(config.onebot.wsPort).toBe(7800);
    expect(config.onebot.reverseUrls).toEqual(['ws://127.0.0.1:6700']);
    expect(config.passiveOverflow).toBe('proactive');
    expect(takeover).toEqual({
      appId: '123456',
      autoAckInteraction: true,
      isolation: 'always',
      retryDelayMs: 5000,
    });
    expect(config.noa.autoAckInteraction).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('falls back to auto isolation and warns on an invalid value', () => {
    const warnings: string[] = [];
    const { takeover } = normalizePluginConfig(
      { takeover: { isolation: 'sometimes' } },
      (message) => warnings.push(message),
    );

    expect(takeover.isolation).toBe('auto');
    expect(warnings.some((message) => message.includes('isolation'))).toBe(true);
  });
});

describe('detectDshQqbotActivation', () => {
  it('reads dsh.profile.bundles instead of assuming the dependency is active', () => {
    const profileDir = path.join(dir, 'home', 'profiles', 'test');
    mkdirSync(profileDir, { recursive: true });
    const packageFile = path.join(profileDir, 'package.json');

    writeFileSync(
      packageFile,
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    );
    expect(detectDshQqbotActivation()).toEqual({ bundled: false, profileDir });

    writeFileSync(
      packageFile,
      JSON.stringify({
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@tencent-connect/dsh-qqbot'] } },
      }),
    );
    expect(detectDshQqbotActivation()).toEqual({ bundled: true, profileDir });
  });
});
