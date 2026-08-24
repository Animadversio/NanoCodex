import { getAgentGroup } from '../db/agent-groups.js';
import {
  findSurfaceBinding,
  getContextNode,
  getContextNodesByAgentGroup,
  getSurfaceBindingsByAgentGroup,
} from '../db/context-nodes.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionByContext } from '../db/sessions.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import type { ContextNode, MessagingGroupAgent } from '../types.js';
import type { ChatSdkSlashCommandEvent } from './chat-sdk-bridge.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const RESPONSE_LIMIT = 1900;

export const NANOCODEX_DISCORD_COMMAND = {
  name: 'nanocodex',
  description: 'Inspect and control NanoCodex context',
  options: [
    { type: 1, name: 'where', description: 'Show the context bound to this channel or thread' },
    { type: 1, name: 'tree', description: 'Show the context tree for this Discord channel' },
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
  return `${text.slice(0, RESPONSE_LIMIT - 24).trimEnd()}\n…additional branches omitted`;
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

/** Execute a host-owned NanoCodex command without adding it to model context. */
export async function handleNanoCodexDiscordCommand(event: ChatSdkSlashCommandEvent): Promise<string | null> {
  if (event.command === '/nanocodex where') return renderWhere(event);
  if (event.command === '/nanocodex tree') return renderTree(event);
  if (event.command.startsWith('/nanocodex')) return 'Use `/nanocodex where` or `/nanocodex tree`.';
  return null;
}
