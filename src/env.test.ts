import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { readEnvFile, resolveEnvFilePath } from './env.js';

let testDir: string | undefined;

afterEach(() => {
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
});

describe('readEnvFile', () => {
  it('reads requested values from an explicit credentials file', () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocodex-env-'));
    const credentialsFile = path.join(testDir, 'discord.env');
    fs.writeFileSync(
      credentialsFile,
      ['DISCORD_BOT_TOKEN=secret-token', 'DISCORD_APPLICATION_ID="application-id"', 'IGNORED=value'].join('\n'),
    );

    expect(readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID'], credentialsFile)).toEqual({
      DISCORD_BOT_TOKEN: 'secret-token',
      DISCORD_APPLICATION_ID: 'application-id',
    });
  });

  it('resolves a credentials pointer from local config with process precedence', () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocodex-env-pointer-'));
    const configFile = path.join(testDir, '.env');
    fs.writeFileSync(configFile, 'NANOCLAW_DISCORD_ENV_FILE=/config/discord.env\n');

    expect(resolveEnvFilePath('NANOCLAW_DISCORD_ENV_FILE', undefined, configFile)).toBe('/config/discord.env');
    expect(resolveEnvFilePath('NANOCLAW_DISCORD_ENV_FILE', ' /process/discord.env ', configFile)).toBe(
      '/process/discord.env',
    );
  });
});
