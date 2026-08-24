import path from 'node:path';

import { writeMessageOut, type WriteMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';
import type { LiveActivityItemKind, LiveActivityUpdate, ProviderEvent } from './providers/types.js';

const DISCORD_LIMIT = 1900;
const UPDATE_DELAY_MS = 750;

interface ActivityItem {
  id: string;
  kind: LiveActivityItemKind;
  label: string;
  status: string;
  startedAtMs?: number;
  durationMs?: number | null;
  exitCode?: number | null;
  output?: string | null;
}

interface DiffSummary {
  paths: string[];
  added: number;
  deleted: number;
}

export interface ActivityDependencies {
  write: (message: WriteMessageOut) => Promise<number>;
  now: () => number;
  id: () => string;
}

const defaultDependencies: ActivityDependencies = {
  write: writeMessageOut,
  now: Date.now,
  id: () => `activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
};

export class LiveActivityReporter {
  private card: TurnActivityCard | null = null;
  private readonly cards: TurnActivityCard[] = [];
  private readonly enabled: boolean;

  constructor(
    private readonly routing: RoutingContext,
    private readonly cwd: string,
    private readonly dependencies: ActivityDependencies = defaultDependencies,
  ) {
    this.enabled = routing.channelType === 'discord' && !routing.taskRun && Boolean(routing.platformId);
  }

  apply(event: ProviderEvent): void {
    if (!this.enabled) return;
    if (event.type === 'live-activity' && event.update.kind === 'turn-started') {
      this.card?.finish(false);
      this.card = new TurnActivityCard(this.routing, this.cwd, this.dependencies);
      this.cards.push(this.card);
      this.card.start();
      return;
    }
    if (!this.card) return;
    if (event.type === 'guardian-review') {
      this.card.guardian(event.status, event.riskLevel, event.rationale);
    } else if (event.type === 'live-activity') {
      this.card.apply(event.update);
    } else if (event.type === 'error') {
      this.card.finish(true);
    }
  }

  async close(failed = false): Promise<void> {
    if (!this.card) return;
    if (failed) this.card.finish(true);
    await Promise.all(this.cards.map((card) => card.close()));
  }
}

class TurnActivityCard {
  private readonly startedAt: number;
  private readonly commentary: string[] = [];
  private readonly items = new Map<string, ActivityItem>();
  private itemOrder: string[] = [];
  private plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> = [];
  private planExplanation: string | null = null;
  private diff: DiffSummary | null = null;
  private guardianLine: string | null = null;
  private terminal: 'completed' | 'failed' | null = null;
  private initialId: string | null = null;
  private lastQueued = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly routing: RoutingContext,
    private readonly cwd: string,
    private readonly dependencies: ActivityDependencies,
  ) {
    this.startedAt = dependencies.now();
  }

  start(): void {
    this.queueFlush(true);
  }

  apply(update: LiveActivityUpdate): void {
    switch (update.kind) {
      case 'turn-started':
        return;
      case 'commentary':
        this.commentary.push(cleanText(update.text, 220));
        this.commentary.splice(0, Math.max(0, this.commentary.length - 2));
        break;
      case 'plan':
        this.plan = update.steps.slice(0, 6);
        this.planExplanation = update.explanation ? cleanText(update.explanation, 160) : null;
        break;
      case 'item-started':
        this.upsertItem({
          id: update.id,
          kind: update.itemKind,
          label: update.label,
          status: 'inProgress',
          startedAtMs: update.startedAtMs ?? this.dependencies.now(),
        });
        break;
      case 'item-completed': {
        const existing = this.items.get(update.id);
        this.upsertItem({
          id: update.id,
          kind: update.itemKind,
          label: update.label,
          status: update.status,
          startedAtMs: existing?.startedAtMs,
          durationMs:
            update.durationMs ??
            (existing?.startedAtMs ? Math.max(0, this.dependencies.now() - existing.startedAtMs) : undefined),
          exitCode: update.exitCode,
          output: usefulOutput(update.output, update.status, update.exitCode),
        });
        if (update.paths?.length) {
          this.diff = { paths: update.paths, added: this.diff?.added ?? 0, deleted: this.diff?.deleted ?? 0 };
        }
        break;
      }
      case 'diff':
        this.diff = update.diff ? summarizeDiff(update.diff) : null;
        break;
      case 'turn-completed':
        this.finish(update.failed);
        return;
    }
    this.queueFlush(false);
  }

  guardian(status: string, riskLevel?: string | null, rationale?: string | null): void {
    const risk = riskLevel ? ` · risk ${cleanText(riskLevel, 20)}` : '';
    const reason = rationale ? ` · ${cleanText(rationale, 130)}` : '';
    this.guardianLine = `${statusIcon(status)} Guardian ${cleanText(status, 24)}${risk}${reason}`;
    this.queueFlush(false);
  }

  finish(failed: boolean): void {
    this.terminal = failed ? 'failed' : 'completed';
    this.queueFlush(true);
  }

  async close(): Promise<void> {
    if (!this.terminal) this.terminal = 'completed';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queueFlush(true);
    await this.pending;
  }

  private upsertItem(item: ActivityItem): void {
    if (!this.items.has(item.id)) this.itemOrder.push(item.id);
    this.items.set(item.id, item);
    if (this.itemOrder.length > 12) {
      const removed = this.itemOrder.shift();
      if (removed) this.items.delete(removed);
    }
  }

  private queueFlush(immediate: boolean): void {
    this.dirty = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!immediate) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.enqueueFlush();
      }, UPDATE_DELAY_MS);
      return;
    }
    this.enqueueFlush();
  }

  private enqueueFlush(): void {
    this.pending = this.pending
      .then(() => this.flush())
      .catch((error) => {
        console.error(`[live-activity] ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const text = this.render();
    if (!this.initialId) {
      this.initialId = this.dependencies.id();
      await this.dependencies.write({
        id: this.initialId,
        in_reply_to: this.routing.inReplyTo,
        kind: 'activity',
        platform_id: this.routing.platformId,
        channel_type: this.routing.channelType,
        thread_id: this.routing.threadId,
        content: JSON.stringify({ text }),
      });
      this.lastQueued = text;
      if (this.dirty) this.queueFlush(false);
      return;
    }
    if (text === this.lastQueued) return;

    await this.dependencies.write({
      id: this.dependencies.id(),
      kind: 'activity',
      platform_id: this.routing.platformId,
      channel_type: this.routing.channelType,
      thread_id: this.routing.threadId,
      content: JSON.stringify({ operation: 'edit', messageOutId: this.initialId, text }),
    });
    this.lastQueued = text;
  }

  private render(): string {
    const elapsed = formatDuration(Math.max(0, this.dependencies.now() - this.startedAt));
    const state =
      this.terminal === 'failed' ? '🔴 failed' : this.terminal === 'completed' ? '🟢 complete' : '🟡 working';
    const sections: string[] = [`**Live activity** · ${state} · ${elapsed}`];

    if (this.commentary.length) {
      sections.push(this.commentary.map((line) => `💬 ${line}`).join('\n'));
    }
    if (this.plan.length) {
      const completed = this.plan.filter((step) => step.status === 'completed').length;
      const lines = this.plan.slice(0, 4).map((step) => `${planIcon(step.status)} ${cleanText(step.step, 145)}`);
      const explanation = this.planExplanation ? ` · ${this.planExplanation}` : '';
      sections.push(`**Plan ${completed}/${this.plan.length}**${explanation}\n${lines.join('\n')}`);
    }

    const recentItems = this.itemOrder
      .slice(-6)
      .map((id) => this.items.get(id))
      .filter((item): item is ActivityItem => item !== undefined);
    if (recentItems.length) {
      sections.push(`**Actions**\n${recentItems.map((item) => this.renderItem(item)).join('\n')}`);
    }
    if (this.diff) {
      const paths = this.diff.paths.slice(0, 4).map((value) => `\`${escapeCode(shortPath(value, this.cwd))}\``);
      const more = this.diff.paths.length > paths.length ? ` +${this.diff.paths.length - paths.length} more` : '';
      sections.push(
        `📝 ${this.diff.paths.length} file${this.diff.paths.length === 1 ? '' : 's'} · +${this.diff.added} −${
          this.diff.deleted
        }\n${paths.join(', ')}${more}`,
      );
    }
    if (this.guardianLine) sections.push(this.guardianLine);

    return capDiscord(sections);
  }

  private renderItem(item: ActivityItem): string {
    const label = cleanText(safeLabel(item.label, item.kind), 115);
    const duration =
      item.durationMs !== null && item.durationMs !== undefined ? ` · ${formatDuration(item.durationMs)}` : '';
    const exit = item.exitCode !== null && item.exitCode !== undefined ? ` · exit ${item.exitCode}` : '';
    const main = `${statusIcon(item.status)} ${kindLabel(item.kind)} \`${escapeCode(label)}\`${duration}${exit}`;
    return item.output ? `${main}\n  ↳ ${cleanText(item.output, 220)}` : main;
  }
}

function kindLabel(kind: LiveActivityItemKind): string {
  return { command: 'Command', file: 'Files', mcp: 'MCP', tool: 'Tool', web: 'Web' }[kind];
}

function planIcon(status: 'pending' | 'inProgress' | 'completed'): string {
  return status === 'completed' ? '✅' : status === 'inProgress' ? '🔄' : '▫️';
}

function statusIcon(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'approved') return '✅';
  if (normalized === 'inprogress' || normalized === 'in_progress') return '⏳';
  if (normalized === 'failed' || normalized === 'denied' || normalized === 'declined') return '❌';
  if (normalized === 'timedout' || normalized === 'aborted') return '⚠️';
  return '•';
}

function safeLabel(label: string, kind: LiveActivityItemKind): string {
  const redacted = redact(label);
  if (kind !== 'command') return redacted;
  return commandSummary(redacted);
}

function commandSummary(command: string): string {
  const line = command.split('\n', 1)[0].trim();
  const shell = /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-[A-Za-z]*c\s+(['"])(.*)\1$/.exec(line);
  const body = shell?.[2] ?? line;
  const names = body
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => {
      const withoutEnv = segment.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '').trim();
      const tokens = withoutEnv.match(/(?:[^\s'"`]+|'[^']*'|"[^"]*")+/g) ?? [];
      const executable = tokens[0]?.replace(/^['"]|['"]$/g, '');
      if (!executable) return null;
      const name = path.basename(executable);
      const subcommand = tokens[1]?.replace(/^['"]|['"]$/g, '');
      if (subcommand && ['bun', 'cargo', 'git', 'just', 'npm', 'pnpm'].includes(name) && !subcommand.startsWith('-')) {
        return `${name} ${subcommand}`;
      }
      return name;
    })
    .filter((name): name is string => name !== null);
  return [...new Set(names)].slice(0, 3).join(' → ') || 'command';
}

function usefulOutput(
  output: string | null | undefined,
  status: string,
  exitCode: number | null | undefined,
): string | null {
  if (!output) return null;
  const cleaned = cleanText(redact(output), 500);
  const failed = ['failed', 'declined', 'denied'].includes(status.toLowerCase()) || (exitCode ?? 0) !== 0;
  const usefulSuccess =
    /\b(?:passed|failed|error|warning|tests?|files? changed|insertions?|deletions?|built|compiled)\b/i.test(cleaned);
  if (!failed && !usefulSuccess) return null;
  return cleanText(cleaned, 220);
}

function redact(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function cleanText(value: string, limit: number): string {
  const cleaned = value
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<\/?(?:message|internal)\b[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function escapeCode(value: string): string {
  return value.replace(/`/g, 'ˋ');
}

function shortPath(value: string, cwd: string): string {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(cwd, value);
  return relative && !relative.startsWith('..') ? relative : value;
}

function summarizeDiff(diff: string): DiffSummary {
  const paths = new Set<string>();
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) paths.add(match[2]);
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
  }
  return { paths: [...paths], added, deleted };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}

function capDiscord(sections: string[]): string {
  const text = sections.join('\n\n');
  return text.length <= DISCORD_LIMIT ? text : `${text.slice(0, DISCORD_LIMIT - 2).trimEnd()}…`;
}
