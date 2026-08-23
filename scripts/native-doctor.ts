import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../src/env.js';

const MIN_CODEX_VERSION = [0, 146, 0] as const;
let failed = false;

function report(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? '✓' : '✗'} ${label}: ${detail}`);
  if (!ok) failed = true;
}

function command(commandName: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(commandName, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    const delta = (actual[i] ?? 0) - (minimum[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

const nodeVersion = process.versions.node.split('.').map(Number);
report(versionAtLeast(nodeVersion, [22, 0, 0]), 'Node.js', process.versions.node);

for (const executable of ['pnpm', 'bun'] as const) {
  const result = command(executable, ['--version']);
  report(result.ok, executable, result.output || 'not found');
}

const codex = command('codex', ['--version']);
const codexMatch = /(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/.exec(codex.output);
const codexVersion = codexMatch?.slice(1).map(Number) ?? [];
report(
  codex.ok && codexVersion.length === 3 && versionAtLeast(codexVersion, MIN_CODEX_VERSION),
  'Codex CLI',
  codex.output || `not found (requires ${MIN_CODEX_VERSION.join('.')}+)`,
);

const login = command('codex', ['login', 'status']);
report(login.ok, 'Codex login', login.output || 'run `codex login`');

const env = readEnvFile(['DISCORD_BOT_TOKEN']);
report(Boolean(env.DISCORD_BOT_TOKEN), 'Discord token', env.DISCORD_BOT_TOKEN ? 'configured' : 'missing from .env');

const rootDependencies = path.join(process.cwd(), 'node_modules');
const runnerDependencies = path.join(process.cwd(), 'container', 'agent-runner', 'node_modules');
report(
  fs.existsSync(rootDependencies),
  'Host dependencies',
  fs.existsSync(rootDependencies) ? 'installed' : 'run `pnpm install`',
);
report(
  fs.existsSync(runnerDependencies),
  'Runner dependencies',
  fs.existsSync(runnerDependencies) ? 'installed' : 'run `cd container/agent-runner && bun install`',
);

console.log();
if (failed) {
  console.error('NanoCodex native prerequisites are incomplete.');
  process.exitCode = 1;
} else {
  console.log('NanoCodex native prerequisites look ready.');
}
