import { getAgentGroup } from '../db/agent-groups.js';
import {
  findSurfaceBinding,
  getContextNode,
  getContextNodesByAgentGroup,
  getSurfaceBindingsByAgentGroup,
} from '../db/context-nodes.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionByContext } from '../db/sessions.js';
import { sessionHistory, type HistoryRow } from '../modules/cross-session-context/index.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import type { ContextNode, MessagingGroupAgent } from '../types.js';
import type { ChatSdkSlashCommandEvent } from './chat-sdk-bridge.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const RESPONSE_LIMIT = 1900;
const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_MAX_LIMIT = 20;

export const NANOCODEX_DISCORD_COMMAND = {
  name: 'nanocodex',
  description: 'Inspect and control NanoCodex context',
  options: [
    { type: 1, name: 'help', description: 'Show NanoCodex context commands' },
    { type: 1, name: 'where', description: 'Show the context bound to this channel or thread' },
    { type: 1, name: 'tree', description: 'Show the context tree for this Discord channel' },
    { type: 1, name: 'lineage', description: 'Show the ancestry of the current context' },
    {
      type: 1,
      name: 'history',
      description: 'Show recent messages in the current context',
      options: [
        {
          type: 4,
          name: 'limit',
          description: `Number of messages to show (1-${HISTORY_MAX_LIMIT})`,
          required: false,
          min_value: 1,
          max_value: HISTORY_MAX_LIMIT,
        },
      ],
    },
  ],
} as const;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Upsert only NanoCodex's global command; do not overwrite other app commands. */
export async function registerNanoCodexDiscordCommand(input: {
  applicationId: string;
  botToken: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${DISCORD_API_BASE}/applications/${input.applicationId}/commands`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${input.botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(NANOCODEX_DISCORD_COMMAND),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Discord command registration failed (${response.status}): ${detail}`);
  }
}

function namespacedDiscordUserId(userId: string): string {
  return userId.includes(':') ? userId : `discord:${userId}`;
}

function compactId(id: string | null): string {
  if (!id) return 'not started';
  if (id.length <= 24) return id;
  return `${id.slice(0, 12)}…${id.slice(-6)}`;
}

function capResponse(lines: string[]): string {
  const text = lines.join('\n');
  if (text.length <= RESPONSE_LIMIT) return text;
  return `${text.slice(0, RESPONSE_LIMIT - 20).trimEnd()}\n…additional output omitted`;
}

function renderHelp(): string {
  return [
    '**NanoCodex context controls**',
    '`/nanocodex where` — inspect this Discord surface and runtime',
    '`/nanocodex tree` — show the channel trunk and thread branches',
    '`/nanocodex lineage` — show this context from root to current node',
    '`/nanocodex history [limit]` — show the latest 1-20 context messages',
    '',
    'Create a Discord thread manually to deliberately fork a branch from the channel trunk.',
  ].join('\n');
}

async function accessibleWirings(
  event: ChatSdkSlashCommandEvent,
): Promise<{ messagingGroupId: string; wirings: MessagingGroupAgent[] } | string> {
  const mg = await getMessagingGroupByPlatform('discord', event.platformId, event.instance);
  if (!mg) return 'This Discord channel is not registered with NanoCodex yet.';
  const userId = namespacedDiscordUserId(event.userId);
  const wirings = await getMessagingGroupAgents(mg.id);
  const allowed: MessagingGroupAgent[] = [];
  for (const wiring of wirings) {
    if ((await canAccessAgentGroup(userId, wiring.agent_group_id)).allowed) allowed.push(wiring);
  }
  if (allowed.length === 0) return 'Permission denied: you do not have access to a NanoCodex agent in this channel.';
  return { messagingGroupId: mg.id, wirings: allowed };
}

async function renderWhere(event: ChatSdkSlashCommandEvent): Promise<string> {
  const accessible = await accessibleWirings(event);
  if (typeof accessible === 'string') return accessible;

  const threadKey = event.threadId === event.platformId ? '' : event.threadId;
  const lines = [`**NanoCodex context**`, `Surface: ${threadKey ? 'Discord thread' : 'channel trunk'}`];
  for (const wiring of accessible.wirings) {
    const agent = await getAgentGroup(wiring.agent_group_id);
    const binding = await findSurfaceBinding(wiring.agent_group_id, accessible.messagingGroupId, threadKey);
    lines.push('', `**${agent?.name ?? wiring.agent_group_id}**`);
    if (!binding) {
      lines.push('Context: not created yet', 'The first handled agent turn on this surface will create it.');
      continue;
    }
    const context = await getContextNode(binding.context_node_id);
    if (!context) {
      lines.push(`Context: invalid binding ${compactId(binding.context_node_id)}`);
      continue;
    }
    const runtime = await findSessionByContext(context.id);
    lines.push(
      `Context: ${context.kind} · ${compactId(context.id)}`,
      `Parent: ${compactId(context.parent_context_id)}`,
      `Codex: ${compactId(context.codex_thread_id)}`,
      `Runtime: ${runtime ? `${runtime.container_status} · ${compactId(runtime.id)}` : 'not running'}`,
    );
  }
  return capResponse(lines);
}

function contextLine(context: ContextNode, label: string, currentContextId: string | null): string {
  const marker = context.id === currentContextId ? '→' : context.kind === 'trunk' ? '●' : '└';
  const codex = context.codex_thread_id ? ` · Codex ${compactId(context.codex_thread_id)}` : '';
  return `${marker} ${label} · ${compactId(context.id)}${codex}`;
}

async function renderTree(event: ChatSdkSlashCommandEvent): Promise<string> {
  const accessible = await accessibleWirings(event);
  if (typeof accessible === 'string') return accessible;

  const currentThreadKey = event.threadId === event.platformId ? '' : event.threadId;
  const lines = ['**NanoCodex context tree**'];
  for (const wiring of accessible.wirings) {
    const agent = await getAgentGroup(wiring.agent_group_id);
    const bindings = (await getSurfaceBindingsByAgentGroup(wiring.agent_group_id)).filter(
      (binding) => binding.messaging_group_id === accessible.messagingGroupId,
    );
    const contexts = new Map((await getContextNodesByAgentGroup(wiring.agent_group_id)).map((node) => [node.id, node]));
    const current = bindings.find((binding) => binding.thread_key === currentThreadKey)?.context_node_id ?? null;
    lines.push('', `**${agent?.name ?? wiring.agent_group_id}**`);
    if (bindings.length === 0) {
      lines.push('No context has been created for this channel yet.');
      continue;
    }
    for (const binding of bindings) {
      const context = contexts.get(binding.context_node_id);
      if (!context) continue;
      const label = binding.thread_key ? `thread ${compactId(binding.thread_key.split(':').at(-1) ?? '')}` : 'trunk';
      lines.push(contextLine(context, label, current));
    }
  }
  return capResponse(lines);
}

async function renderLineage(event: ChatSdkSlashCommandEvent): Promise<string> {
  const accessible = await accessibleWirings(event);
  if (typeof accessible === 'string') return accessible;

  const threadKey = event.threadId === event.platformId ? '' : event.threadId;
  const lines = ['**NanoCodex context lineage**'];
  for (const wiring of accessible.wirings) {
    const agent = await getAgentGroup(wiring.agent_group_id);
    const binding = await findSurfaceBinding(wiring.agent_group_id, accessible.messagingGroupId, threadKey);
    lines.push('', `**${agent?.name ?? wiring.agent_group_id}**`);
    if (!binding) {
      lines.push('No context has been created on this surface yet.');
      continue;
    }

    const ancestry: ContextNode[] = [];
    const visited = new Set<string>();
    let context = await getContextNode(binding.context_node_id);
    while (context && !visited.has(context.id)) {
      ancestry.push(context);
      visited.add(context.id);
      context = context.parent_context_id ? await getContextNode(context.parent_context_id) : undefined;
    }
    ancestry.reverse();
    ancestry.forEach((node, index) => {
      const marker = index === ancestry.length - 1 ? '→' : '└';
      const codex = node.codex_thread_id ? ` · Codex ${compactId(node.codex_thread_id)}` : '';
      lines.push(`${marker} ${node.kind} · ${compactId(node.id)}${codex}`);
    });
    if (context) lines.push('⚠ Context ancestry contains a cycle.');
  }
  return capResponse(lines);
}

function historyLimit(text: string): number | string {
  if (!text.trim()) return HISTORY_DEFAULT_LIMIT;
  const parsed = Number(text.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_MAX_LIMIT) {
    return `History limit must be a whole number from 1 to ${HISTORY_MAX_LIMIT}.`;
  }
  return parsed;
}

function historyLine(row: HistoryRow): string {
  const stamp = row.timestamp.replace('T', ' ').slice(0, 16);
  const direction = row.direction === 'in' ? '→' : '←';
  const sender = (row.sender || (row.direction === 'in' ? 'user' : 'agent')).replace(/@/g, '@\u200b');
  const text = row.text.replace(/\s+/g, ' ').replace(/@/g, '@\u200b').trim().slice(0, 240) || `[${row.kind}]`;
  return `${stamp}Z · ${direction} ${sender}: ${text}`;
}

async function renderHistory(event: ChatSdkSlashCommandEvent): Promise<string> {
  const limit = historyLimit(event.text);
  if (typeof limit === 'string') return limit;
  const accessible = await accessibleWirings(event);
  if (typeof accessible === 'string') return accessible;

  const threadKey = event.threadId === event.platformId ? '' : event.threadId;
  const lines = [`**NanoCodex context history · latest ${limit}**`];
  for (const wiring of accessible.wirings) {
    const agent = await getAgentGroup(wiring.agent_group_id);
    const binding = await findSurfaceBinding(wiring.agent_group_id, accessible.messagingGroupId, threadKey);
    lines.push('', `**${agent?.name ?? wiring.agent_group_id}**`);
    if (!binding) {
      lines.push('No context has been created on this surface yet.');
      continue;
    }
    const runtime = await findSessionByContext(binding.context_node_id);
    if (!runtime) {
      lines.push('No runtime history is attached to this context.');
      continue;
    }
    const rows = await sessionHistory({ id: runtime.id, limit }, { caller: 'host' });
    lines.push(...(rows.length > 0 ? rows.map(historyLine) : ['No messages recorded yet.']));
  }
  return capResponse(lines);
}

/** Execute a host-owned NanoCodex command without adding it to model context. */
export async function handleNanoCodexDiscordCommand(event: ChatSdkSlashCommandEvent): Promise<string | null> {
  if (event.command === '/nanocodex help') return renderHelp();
  if (event.command === '/nanocodex where') return renderWhere(event);
  if (event.command === '/nanocodex tree') return renderTree(event);
  if (event.command === '/nanocodex lineage') return renderLineage(event);
  if (event.command === '/nanocodex history') return renderHistory(event);
  if (event.command.startsWith('/nanocodex')) return renderHelp();
  return null;
}
