import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { readEnvFile } from './env.js';

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
});
