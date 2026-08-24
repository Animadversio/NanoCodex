import { describe, expect, it } from 'bun:test';

import { LiveActivityReporter, type ActivityDependencies } from './live-activity.js';
import type { RoutingContext } from './formatter.js';
import type { ProviderEvent } from './providers/types.js';

const DISCORD_ROUTING: RoutingContext = {
  platformId: 'discord:guild:channel',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'in-1',
  taskRun: false,
};

describe('LiveActivityReporter', () => {
  it('creates one bounded card then edits it with compact, redacted turn details', async () => {
    const writes: Array<{ id: string; kind: string; content: string }> = [];
    let now = 1_000;
    let nextSequence = 1;
    let nextId = 1;
    const dependencies: ActivityDependencies = {
      write: async (message) => {
        writes.push({ id: message.id, kind: message.kind, content: message.content });
        return nextSequence++;
      },
      now: () => now,
      id: () => `activity-${nextId++}`,
    };
    const reporter = new LiveActivityReporter(DISCORD_ROUTING, '/workspace/agent', dependencies);

    reporter.apply(live({ kind: 'turn-started' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].content).text).toContain('🟡 working');

    reporter.apply(live({ kind: 'commentary', text: 'I am checking the implementation now.' }));
    reporter.apply(
      live({
        kind: 'plan',
        explanation: 'Validate the compact stream',
        steps: [
          { step: 'Inspect events', status: 'completed' },
          { step: 'Run tests', status: 'inProgress' },
        ],
      }),
    );
    reporter.apply(
      live({
        kind: 'item-started',
        id: 'cmd-1',
        itemKind: 'command',
        label: "/bin/zsh -lc 'TOKEN=super-secret pnpm test --filter live'",
        startedAtMs: now,
      }),
    );
    now += 1_250;
    reporter.apply(
      live({
        kind: 'item-completed',
        id: 'cmd-1',
        itemKind: 'command',
        label: "/bin/zsh -lc 'TOKEN=super-secret pnpm test --filter live'",
        status: 'completed',
        durationMs: 1_250,
        exitCode: 0,
        output: 'API_KEY=also-secret 18 tests passed',
      }),
    );
    reporter.apply(
      live({
        kind: 'diff',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+another',
      }),
    );
    reporter.apply({
      type: 'guardian-review',
      threadId: 'thread-1',
      reviewId: 'review-1',
      status: 'approved',
      riskLevel: 'low',
      rationale: 'Safe local test',
      action: {},
      assessment: {},
    });
    reporter.apply(live({ kind: 'turn-completed', failed: false }));
    await reporter.close();

    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.kind === 'activity')).toBe(true);
    const edit = JSON.parse(writes[1].content) as { operation: string; messageOutId: string; text: string };
    expect(edit.operation).toBe('edit');
    expect(edit.messageOutId).toBe('activity-1');
    expect(edit.text).toContain('🟢 complete');
    expect(edit.text).toContain('Plan 1/2');
    expect(edit.text).toContain('pnpm test');
    expect(edit.text).toContain('exit 0');
    expect(edit.text).toContain('18 tests passed');
    expect(edit.text).toContain('1 file · +2 −1');
    expect(edit.text).toContain('Guardian approved · risk low');
    expect(edit.text).not.toContain('super-secret');
    expect(edit.text).not.toContain('also-secret');
    expect(edit.text).not.toContain('--filter');
    expect(edit.text.length).toBeLessThanOrEqual(1900);
  });

  it('does not emit cards outside Discord or for task runs', async () => {
    const writes: unknown[] = [];
    const dependencies: ActivityDependencies = {
      write: async (message) => {
        writes.push(message);
        return 1;
      },
      now: () => 0,
      id: () => 'activity-1',
    };
    const slack = new LiveActivityReporter({ ...DISCORD_ROUTING, channelType: 'slack' }, '/tmp', dependencies);
    const task = new LiveActivityReporter({ ...DISCORD_ROUTING, taskRun: true }, '/tmp', dependencies);

    slack.apply(live({ kind: 'turn-started' }));
    task.apply(live({ kind: 'turn-started' }));
    await slack.close();
    await task.close();

    expect(writes).toHaveLength(0);
  });

  it('clears transient diff statistics when Codex reports a clean final diff', async () => {
    const writes: Array<{ content: string }> = [];
    let nextId = 1;
    const dependencies: ActivityDependencies = {
      write: async (message) => {
        writes.push({ content: message.content });
        return writes.length;
      },
      now: () => 1_000,
      id: () => `activity-${nextId++}`,
    };
    const reporter = new LiveActivityReporter(DISCORD_ROUTING, '/workspace/agent', dependencies);

    reporter.apply(live({ kind: 'turn-started' }));
    await Promise.resolve();
    await Promise.resolve();
    reporter.apply(live({ kind: 'diff', diff: 'diff --git a/a.ts b/a.ts\n-old\n+new' }));
    reporter.apply(live({ kind: 'diff', diff: '' }));
    reporter.apply(live({ kind: 'turn-completed', failed: false }));
    await reporter.close();

    const final = JSON.parse(writes.at(-1)!.content) as { text: string };
    expect(final.text).not.toContain('📝');
  });
});

function live(update: Extract<ProviderEvent, { type: 'live-activity' }>['update']): ProviderEvent {
  return { type: 'live-activity', update };
}
