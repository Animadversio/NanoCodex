/**
 * Native process driver for NanoCodex.
 *
 * The trusted host still owns routing, authorization, and session lifecycle,
 * while the per-session Bun runner and `codex app-server` execute directly on
 * the host. Codex's own workspace sandbox is the execution boundary.
 */
import { spawn, type ChildProcess } from 'child_process';
import { execFileSync } from 'child_process';
import path from 'path';

import { log } from '../log.js';

import {
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionHandle,
  type SessionKey,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

const HOST_ENV_ALLOWLIST = [
  'ALL_PROXY',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

interface NativeProcessState {
  readonly spec: SessionSpec;
  readonly name: string;
  child: ChildProcess | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopping: boolean;
}

export class NativeSessionDriver implements SessionDriver {
  readonly kind = 'native' as const;
  readonly #states = new Map<string, NativeProcessState>();
  readonly #subscribers = new Map<string, Set<(event: SessionEvent) => void>>();

  constructor(private readonly policy: MountPolicy) {}

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['native'],
      admissionEnforced: false,
      // Native execution deliberately has the host's network. Codex Guardian
      // reviews actions; this driver does not claim a network boundary that it
      // does not enforce.
      networkPolicy: 'host',
      encryptedVolumes: false,
      unrealized: ['memoryMb', 'cpus', 'pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: true,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.policy, this.capabilities());
    const extra = spec.containers.filter((container) => container.role !== 'agent');
    if (extra.length > 0) {
      throw specInvalid(`native driver cannot realize auxiliary role '${extra[0].role}'`);
    }

    const id = keyId(spec.key);
    const existing = this.#states.get(id);
    if (existing && existing.child && existing.exitCode === null) {
      return new NativeHandle(existing, this);
    }

    const state: NativeProcessState = {
      spec,
      name: `nanocodex-native-${spec.key.agentGroupId}-${spec.key.sessionId}`,
      child: null,
      exitCode: null,
      signal: null,
      stopping: false,
    };
    this.#states.set(id, state);
    return new NativeHandle(state, this);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    return [...this.#states.values()]
      .filter((state) => state.spec.key.installSlug === installSlug)
      .map((state) => ({
        handle: new NativeHandle(state, this),
        phase: state.child && state.exitCode === null ? 'running' : state.child ? 'terminal' : 'starting',
      }));
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    const subscribers = this.#subscribers.get(installSlug) ?? new Set<(event: SessionEvent) => void>();
    subscribers.add(onEvent);
    this.#subscribers.set(installSlug, subscribers);
    return {
      stop: () => subscribers.delete(onEvent),
    };
  }

  async reapResidue(installSlug: string): Promise<void> {
    for (const [id, state] of this.#states) {
      if (state.spec.key.installSlug === installSlug && state.child && state.exitCode !== null) {
        this.#states.delete(id);
      }
    }
  }

  start(state: NativeProcessState): void {
    if (state.child && state.exitCode === null) return;

    const agent = state.spec.containers.find((container) => container.role === 'agent');
    if (!agent) throw specInvalid('native session is missing the agent role');

    const sessionDir = requiredMountSource(agent.mounts, '/workspace');
    const agentDir = requiredMountSource(agent.mounts, '/workspace/agent');
    const runnerSrc = requiredMountSource(agent.mounts, '/app/src');
    const skillsDir = optionalMountSource(agent.mounts, '/app/skills');
    const globalDir = optionalMountSource(agent.mounts, '/workspace/global');
    const additionalDirectories = agent.mounts
      .filter((mount) => mount.containerPath.startsWith('/workspace/extra/'))
      .map((mount) => mount.hostPath);

    const env = nativeEnvironment(agent.env, agent.contributedEnv ?? {}, {
      sessionDir,
      agentDir,
      runnerSrc,
      skillsDir,
      globalDir,
      additionalDirectories,
    });
    const bun = resolveExecutable('bun', env.PATH);
    const child = spawn(bun, ['run', path.join(runnerSrc, 'index.ts')], {
      cwd: agentDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;
    state.exitCode = null;
    state.signal = null;
    state.stopping = false;

    child.stdout?.on('data', (chunk) => log.debug(chunk.toString().trim(), { runner: state.name }));
    child.stderr?.on('data', (chunk) => log.debug(chunk.toString().trim(), { runner: state.name }));
    child.on('error', (err) => {
      log.error('Native runner process error', { runner: state.name, err });
    });
    child.on('close', (code, signal) => {
      state.exitCode = code ?? (state.stopping ? 0 : 1);
      state.signal = signal;
      this.#emit(state.spec.key, 'terminal');
      log.info('Native runner exited', { runner: state.name, code, signal });
    });
    this.#emit(state.spec.key, 'phase');
    log.info('Native runner started', { runner: state.name, cwd: agentDir });
  }

  async stop(state: NativeProcessState): Promise<void> {
    const child = state.child;
    if (!child || state.exitCode !== null) {
      this.#states.delete(keyId(state.spec.key));
      return;
    }
    state.stopping = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (state.exitCode === null) child.kill('SIGKILL');
      }, state.spec.stopGraceSeconds * 1_000);
      timer.unref?.();
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#states.delete(keyId(state.spec.key));
  }

  status(state: NativeProcessState): SessionStatus {
    if (!state.child) return { phase: 'ready' };
    if (state.exitCode === null) return { phase: 'running' };
    if (state.exitCode === 0 || state.stopping) return { phase: 'stopped' };
    return {
      phase: 'failed',
      failure: { kind: 'started-then-died', retryable: false, exitCode: state.exitCode },
    };
  }

  #emit(key: SessionKey, kind: SessionEvent['kind']): void {
    for (const subscriber of this.#subscribers.get(key.installSlug) ?? []) subscriber({ key, kind });
  }
}

class NativeHandle implements SessionHandle {
  readonly key: SessionKey;
  readonly name: string;

  constructor(
    private readonly state: NativeProcessState,
    private readonly driver: NativeSessionDriver,
  ) {
    this.key = state.spec.key;
    this.name = state.name;
  }

  async start(): Promise<void> {
    this.driver.start(this.state);
  }

  async status(): Promise<SessionStatus> {
    return this.driver.status(this.state);
  }

  async stop(_reason: string): Promise<void> {
    await this.driver.stop(this.state);
  }

  execSpec(command: string[]): SessionExecSpec {
    if (command.length === 0) throw new Error('native exec requires a command');
    return { bin: command[0], argsTty: command.slice(1), argsPlain: command.slice(1) };
  }
}

function nativeEnvironment(
  composed: Record<string, string>,
  contributed: Record<string, string>,
  paths: {
    sessionDir: string;
    agentDir: string;
    runnerSrc: string;
    skillsDir?: string;
    globalDir?: string;
    additionalDirectories: string[];
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, composed, contributed, {
    HOME: process.env.HOME,
    NANOCLAW_NATIVE: '1',
    NANOCLAW_SESSION_DIR: paths.sessionDir,
    NANOCLAW_AGENT_DIR: paths.agentDir,
    NANOCLAW_RUNNER_SRC: paths.runnerSrc,
    NANOCLAW_SKILLS_DIR: paths.skillsDir,
    NANOCLAW_GLOBAL_DIR: paths.globalDir,
    NANOCLAW_CONFIG_PATH: path.join(paths.agentDir, 'container.json'),
    NANOCLAW_INBOUND_DB: path.join(paths.sessionDir, 'inbound.db'),
    NANOCLAW_OUTBOUND_DB: path.join(paths.sessionDir, 'outbound.db'),
    NANOCLAW_HEARTBEAT_PATH: path.join(paths.sessionDir, '.heartbeat'),
    NANOCLAW_OUTBOX_DIR: path.join(paths.sessionDir, 'outbox'),
    NANOCLAW_ADDITIONAL_DIRECTORIES: JSON.stringify(paths.additionalDirectories),
    NANOCLAW_CONVERSATIONS_DIR: path.join(paths.agentDir, 'conversations'),
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

function resolveExecutable(command: string, pathValue: string | undefined): string {
  try {
    return execFileSync('/usr/bin/env', ['which', command], {
      env: { PATH: pathValue ?? process.env.PATH },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    throw new Error(`Native runtime requires '${command}' on PATH`, { cause: err });
  }
}

function requiredMountSource(mounts: SessionSpec['containers'][number]['mounts'], target: string): string {
  const source = optionalMountSource(mounts, target);
  if (!source) throw specInvalid(`native session is missing mount target '${target}'`);
  return source;
}

function optionalMountSource(mounts: SessionSpec['containers'][number]['mounts'], target: string): string | undefined {
  return mounts.find((mount) => mount.containerPath === target)?.hostPath;
}

function keyId(key: SessionKey): string {
  return `${key.installSlug}\0${key.agentGroupId}\0${key.sessionId}`;
}
