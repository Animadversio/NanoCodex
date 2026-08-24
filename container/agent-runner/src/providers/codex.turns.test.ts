import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CodexProvider, type CodexRuntimeDeps } from './codex.js';
import type { AppServer, JsonRpcNotification, ThreadParams, TurnParams } from './codex-app-server.js';
import type { ProviderEvent } from './types.js';

const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

function createCodexProvider(...args: ConstructorParameters<typeof CodexProvider>): CodexProvider {
  const provider = new CodexProvider(...args);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

describe('CodexProvider active turns', () => {
  it('resumes the durable context thread when a replacement runtime has no mailbox continuation', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider(
      { env: { NANOCLAW_CODEX_CONTEXT_THREAD_ID: 'thread-from-context' } },
      fake.runtime,
    );
    const query = provider.query({ prompt: 'continue', cwd: '/workspace/agent' });
    const collect = collectEvents(query.events, []);

    await waitFor(() => fake.startCalls.length === 1);
    query.end();
    fake.completeTurn('done');
    await collect;

    expect(fake.threadCalls[0]?.threadId).toBe('thread-from-context');
  });

  it('steers follow-ups into the active turn and yields liveness activity', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.push('follow-up prompt');
    await waitFor(() => fake.steerCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');

    await collect;

    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0].inputText).toBe('first prompt');
    expect(fake.steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', inputText: 'follow-up prompt' }]);
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
    expect(fake.killed).toBe(true);
  });

  it('queues follow-ups for the next turn when steering is rejected', async () => {
    const fake = createFakeCodexRuntime({ rejectSteer: true });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.push('queued follow-up');
    await waitFor(() => fake.steerCalls.length === 1);
    await sleep(0);

    fake.completeTurn('first answer');
    await waitFor(() => fake.startCalls.length === 2);
    query.end();
    fake.completeTurn('second answer');

    await collect;

    expect(fake.startCalls.map((call) => call.inputText)).toEqual(['first prompt', 'queued follow-up']);
    expect(fake.steerCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'second answer' },
    ]);
  });

  it('queues a follow-up that races turn completion into a new turn, never steering the finished turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);

    // The turn completes, then a follow-up lands in the same tick — before the
    // generator has drained and torn the turn down. codex's turn/steer no-ops
    // on a finished turn (resolves without error), so steering here would drop
    // the message silently. It must start a fresh turn instead.
    fake.completeTurn('first answer');
    query.push('racing follow-up');

    await waitFor(() => fake.startCalls.length === 2);
    query.end();
    fake.completeTurn('second answer');

    await collect;

    expect(fake.steerCalls).toHaveLength(0);
    expect(fake.startCalls.map((call) => call.inputText)).toEqual(['first prompt', 'racing follow-up']);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'second answer' },
    ]);
  });

  it('interrupts the active turn and closes the stream on abort', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.abort();

    await collect;

    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(fake.killed).toBe(true);
  });

  it('emits denied Guardian reviews and applies only an explicit override call', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delete it', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('item/autoApprovalReview/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      reviewId: 'review-1',
      startedAtMs: 10,
      completedAtMs: 20,
      targetItemId: 'item-1',
      decisionSource: 'agent',
      review: { status: 'denied', riskLevel: 'high', userAuthorization: 'low', rationale: 'destructive' },
      action: { type: 'command', source: 'shell', command: 'rm file', cwd: '/workspace/agent' },
    });
    fake.completeTurn('denied');
    await waitFor(() => events.some((event) => event.type === 'guardian-review'));

    const guardian = events.find((event) => event.type === 'guardian-review') as Extract<
      ProviderEvent,
      { type: 'guardian-review' }
    >;
    expect(guardian).toMatchObject({
      reviewId: 'review-1',
      status: 'denied',
      riskLevel: 'high',
      assessment: { id: 'review-1', status: 'denied', target_item_id: 'item-1' },
    });
    await query.approveGuardianDeniedAction?.(guardian.assessment);
    query.end();
    await collect;

    expect(fake.approvalCalls).toHaveLength(1);
    expect(fake.approvalCalls[0]).toMatchObject({
      threadId: 'thread-1',
      event: { id: 'review-1', status: 'denied' },
    });
  });

  it('threads the configured model and effort into the turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({ model: 'gpt-5.5', effort: 'high' }, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');

    await collect;

    expect(fake.startCalls[0].model).toBe('gpt-5.5');
    expect(fake.startCalls[0].effort).toBe('high');
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
  });

  it('maps Codex plans, commentary, tools, diffs, and completion into compact activity events', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'work on it', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('turn/plan/updated', {
      explanation: 'Checking first',
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Test', status: 'inProgress' },
      ],
    });
    fake.notify('item/started', {
      startedAtMs: 100,
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'pnpm test',
        status: 'inProgress',
      },
    });
    fake.notify('item/completed', {
      completedAtMs: 350,
      item: {
        id: 'comment-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'The focused tests pass.',
      },
    });
    fake.notify('item/completed', {
      completedAtMs: 400,
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'pnpm test',
        status: 'completed',
        durationMs: 300,
        exitCode: 0,
        aggregatedOutput: '18 tests passed',
      },
    });
    fake.notify('item/started', {
      startedAtMs: 450,
      item: {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'inProgress',
      },
    });
    fake.notify('item/completed', {
      completedAtMs: 750,
      item: {
        id: 'image-1',
        type: 'imageGeneration',
        status: 'completed',
      },
    });
    fake.notify('turn/diff/updated', {
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new',
    });
    query.end();
    fake.completeTurn('Done.');
    await collect;

    const updates = events
      .filter((event): event is Extract<ProviderEvent, { type: 'live-activity' }> => event.type === 'live-activity')
      .map((event) => event.update);
    expect(updates).toContainEqual({ kind: 'turn-started' });
    expect(updates).toContainEqual({
      kind: 'plan',
      explanation: 'Checking first',
      steps: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Test', status: 'inProgress' },
      ],
    });
    expect(updates).toContainEqual({ kind: 'commentary', text: 'The focused tests pass.' });
    expect(updates).toContainEqual({
      kind: 'item-completed',
      id: 'cmd-1',
      itemKind: 'command',
      label: 'pnpm test',
      status: 'completed',
      durationMs: 300,
      exitCode: 0,
      output: '18 tests passed',
      paths: undefined,
    });
    expect(updates).toContainEqual({
      kind: 'item-completed',
      id: 'image-1',
      itemKind: 'tool',
      label: 'image generation',
      status: 'completed',
      durationMs: undefined,
      exitCode: undefined,
      output: undefined,
      paths: undefined,
    });
    expect(updates).toContainEqual({
      kind: 'diff',
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new',
    });
    expect(updates).toContainEqual({ kind: 'turn-completed', failed: false });
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'Done.' }]);
  });

  it('emits an empty diff update so the activity card can clear transient changes', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'clean it up', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('turn/diff/updated', { diff: '' });
    query.end();
    fake.completeTurn('Clean.');
    await collect;

    expect(events).toContainEqual({ type: 'live-activity', update: { kind: 'diff', diff: '' } });
  });

  it('delivers harness-generated images as file events — the model never sends them itself', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const fake = createFakeCodexRuntime();
      const provider = createCodexProvider({}, fake.runtime);
      const query = provider.query({ prompt: 'make an image', cwd: '/workspace/agent' });
      const events: ProviderEvent[] = [];
      const collect = collectEvents(query.events, events);

      await waitFor(() => fake.startCalls.length === 1);
      // Codex's built-in image_gen writes into CODEX_HOME mid-turn.
      const imagesDir = path.join(codexHome, 'generated_images', 'thread-1');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, 'ig_abc.png'), 'png-bytes');

      query.end();
      fake.completeTurn('Here you go — created the image.');
      await collect;

      const files = events.filter((event) => event.type === 'file') as Array<{ type: 'file'; path: string }>;
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(path.join(imagesDir, 'ig_abc.png'));
      // file events arrive before the result so delivery shares the turn.
      expect(events.findIndex((e) => e.type === 'file')).toBeLessThan(events.findIndex((e) => e.type === 'result'));
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('ends the turn immediately with the real cause when the app-server dies mid-turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);

    // No pending request exists mid-turn (turn/start already resolved), so
    // only the exitHandlers seam can end the turn — without it this parks
    // on the waker until the 10-minute turn timeout.
    fake.crashServer(new Error('Codex app-server exited: code=1 signal=null'));

    // The generator yields the error event, then rethrows to its consumer.
    await collect.catch(() => {});

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('app-server exited');
  });
});

function createFakeCodexRuntime(opts: { rejectSteer?: boolean } = {}) {
  const server = fakeServer();
  const startCalls: TurnParams[] = [];
  const steerCalls: Array<{ threadId: string; turnId: string; inputText: string }> = [];
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  const approvalCalls: Array<{ threadId: string; event: Record<string, unknown> }> = [];
  const threadCalls: Array<{ threadId: string | undefined; params: ThreadParams }> = [];
  let killed = false;

  const notify = (method: string, params?: Record<string, unknown>): void => {
    const notification: JsonRpcNotification = { method, params };
    for (const handler of [...server.notificationHandlers]) handler(notification);
  };

  const runtime: CodexRuntimeDeps = {
    writeCodexConfigToml: () => {},
    spawnCodexAppServer: () => server,
    attachCodexAutoApproval: () => {},
    initializeCodexAppServer: async () => {},
    startOrResumeCodexThread: async (_server, threadId, params) => {
      threadCalls.push({ threadId, params });
      return threadId ?? 'thread-1';
    },
    startCodexTurn: async (_server, params) => {
      startCalls.push(params);
      const turnId = `turn-${startCalls.length}`;
      notify('turn/started', { turn: { id: turnId } });
      return turnId;
    },
    steerCodexTurn: async (_server, threadId, turnId, inputText) => {
      steerCalls.push({ threadId, turnId, inputText });
      if (opts.rejectSteer) throw new Error('steer rejected');
    },
    interruptCodexTurn: async (_server, threadId, turnId) => {
      interruptCalls.push({ threadId, turnId });
    },
    approveCodexGuardianDenial: async (_server, threadId, event) => {
      approvalCalls.push({ threadId, event });
    },
    killCodexAppServer: () => {
      killed = true;
    },
  };

  return {
    runtime,
    startCalls,
    steerCalls,
    interruptCalls,
    approvalCalls,
    threadCalls,
    notify,
    get killed() {
      return killed;
    },
    completeTurn(text: string) {
      notify('turn/completed', { turn: { items: [{ type: 'agentMessage', text }] } });
    },
    crashServer(err: Error) {
      for (const h of [...server.exitHandlers]) h(err);
    },
  };
}

function fakeServer(): AppServer {
  return {
    process: { stdin: { write: () => true }, kill: () => true },
    readline: { close: () => {} },
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

async function collectEvents(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) {
    sink.push(event);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
