import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanocodex-discord-context-controls-test' };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  findSurfaceBinding,
  getContextNode,
  initTestDb,
  runMigrations,
  setContextCodexThreadId,
} from '../db/index.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { resolveSession, writeOutboundDirect, writeSessionMessage } from '../session-manager.js';
import type { ChatSdkSlashCommandEvent } from './chat-sdk-bridge.js';
import {
  handleNanoCodexDiscordCommand,
  NANOCODEX_DISCORD_COMMAND,
  registerNanoCodexDiscordCommand,
} from './discord-context-controls.js';

const TEST_DIR = '/tmp/nanocodex-discord-context-controls-test';
const PLATFORM_ID = 'discord:guild:channel';

function event(command: string, threadId = PLATFORM_ID, userId = 'user-id', text = ''): ChatSdkSlashCommandEvent {
  return {
    command,
    text,
    instance: 'discord',
    platformId: PLATFORM_ID,
    threadId,
    userId,
    userName: 'User',
    isGroup: true,
  };
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  const createdAt = new Date().toISOString();
  await createAgentGroup({
    id: 'ag-1',
    name: 'NanoCodex',
    folder: 'nanocodex',
    agent_provider: null,
    created_at: createdAt,
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: PLATFORM_ID,
    instance: 'discord',
    name: 'Project',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: createdAt,
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: createdAt,
  });
  await createUser({ id: 'discord:user-id', kind: 'discord', display_name: 'User', created_at: createdAt });
  await addMember({ user_id: 'discord:user-id', agent_group_id: 'ag-1', added_by: null, added_at: createdAt });
  await grantRole({
    user_id: 'discord:user-id',
    role: 'admin',
    agent_group_id: 'ag-1',
    granted_by: null,
    granted_at: createdAt,
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('NanoCodex Discord context controls', () => {
  it('shows the current trunk and a human-created thread branch', async () => {
    const trunk = await resolveSession('ag-1', 'mg-1', PLATFORM_ID, 'per-thread');
    await setContextCodexThreadId(trunk.session.context_node_id!, 'codex-trunk-thread');
    const threadId = `${PLATFORM_ID}:thread-1`;
    await resolveSession('ag-1', 'mg-1', threadId, 'per-thread');

    await expect(handleNanoCodexDiscordCommand(event('/nanocodex where'))).resolves.toContain('Surface: channel trunk');
    const branchWhere = await handleNanoCodexDiscordCommand(event('/nanocodex where', threadId));
    expect(branchWhere).toContain('Surface: Discord thread');
    expect(branchWhere).toContain('Context: branch');

    const tree = await handleNanoCodexDiscordCommand(event('/nanocodex tree', threadId));
    expect(tree).toContain('● trunk');
    expect(tree).toContain('→ thread thread-1');
    expect(tree).toContain('Codex codex-trunk-thread');

    const lineage = await handleNanoCodexDiscordCommand(event('/nanocodex lineage', threadId));
    expect(lineage).toContain('└ trunk');
    expect(lineage).toContain('→ branch');
  });

  it('shows bounded history for the runtime attached to the current context', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', PLATFORM_ID, 'per-thread');
    await writeSessionMessage('ag-1', session.id, {
      id: 'in-1',
      kind: 'chat-sdk',
      timestamp: '2026-08-24T10:00:00.000Z',
      platformId: PLATFORM_ID,
      channelType: 'discord',
      threadId: PLATFORM_ID,
      content: JSON.stringify({ text: 'hello @everyone', sender: 'User' }),
    });
    await writeOutboundDirect('ag-1', session.id, {
      id: 'out-1',
      kind: 'chat',
      platformId: PLATFORM_ID,
      channelType: 'discord',
      threadId: PLATFORM_ID,
      content: JSON.stringify({ text: 'hello back' }),
    });

    const history = await handleNanoCodexDiscordCommand(event('/nanocodex history', PLATFORM_ID, 'user-id', '2'));
    expect(history).toContain('latest 2');
    expect(history).toContain('User: hello @\u200beveryone');
    expect(history).toContain('NanoCodex: hello back');
    await expect(
      handleNanoCodexDiscordCommand(event('/nanocodex history', PLATFORM_ID, 'user-id', '21')),
    ).resolves.toMatch(/whole number from 1 to 20/);
  });

  it('provides discoverable command help', async () => {
    const help = await handleNanoCodexDiscordCommand(event('/nanocodex help'));
    expect(help).toContain('/nanocodex history [limit]');
    expect(help).toContain('/nanocodex speed <normal|fast>');
    expect(help).toContain('/nanocodex thinking <default|low|medium|high|xhigh>');
    expect(help).toContain('Create a Discord thread manually');
  });

  it('stores independent speed and thinking controls on the current context', async () => {
    await expect(
      handleNanoCodexDiscordCommand(event('/nanocodex speed', PLATFORM_ID, 'user-id', 'fast')),
    ).resolves.toContain('Speed: **fast**');
    await expect(
      handleNanoCodexDiscordCommand(event('/nanocodex thinking', PLATFORM_ID, 'user-id', 'high')),
    ).resolves.toContain('Thinking: **high**');

    const trunkBinding = await findSurfaceBinding('ag-1', 'mg-1', '');
    await expect(getContextNode(trunkBinding!.context_node_id)).resolves.toMatchObject({
      kind: 'trunk',
      service_tier: 'fast',
      reasoning_effort: 'high',
    });

    const threadId = `${PLATFORM_ID}:thread-settings`;
    await handleNanoCodexDiscordCommand(event('/nanocodex speed', threadId, 'user-id', 'normal'));
    const branchBinding = await findSurfaceBinding('ag-1', 'mg-1', threadId);
    await expect(getContextNode(branchBinding!.context_node_id)).resolves.toMatchObject({
      kind: 'branch',
      service_tier: null,
      reasoning_effort: 'high',
      parent_context_id: trunkBinding!.context_node_id,
    });
    await expect(getContextNode(trunkBinding!.context_node_id)).resolves.toMatchObject({ service_tier: 'fast' });

    const status = await handleNanoCodexDiscordCommand(event('/nanocodex status', threadId));
    expect(status).toContain('Surface: Discord thread');
    expect(status).toContain('Speed: normal');
    expect(status).toContain('Thinking: high · context override');
    expect(status).toContain('Recent history: 0 messages');
  });

  it('requires owner or admin authority for persistent runtime controls', async () => {
    const createdAt = new Date().toISOString();
    await createUser({ id: 'discord:member', kind: 'discord', display_name: 'Member', created_at: createdAt });
    await addMember({ user_id: 'discord:member', agent_group_id: 'ag-1', added_by: null, added_at: createdAt });

    await expect(
      handleNanoCodexDiscordCommand(event('/nanocodex speed', PLATFORM_ID, 'member', 'fast')),
    ).resolves.toMatch(/requires an owner or admin role/);
  });

  it('does not expose context metadata to a non-member', async () => {
    await createUser({
      id: 'discord:outsider',
      kind: 'discord',
      display_name: 'Outsider',
      created_at: new Date().toISOString(),
    });
    await expect(handleNanoCodexDiscordCommand(event('/nanocodex tree', PLATFORM_ID, 'outsider'))).resolves.toMatch(
      /Permission denied/,
    );
  });
});

describe('NanoCodex Discord command registration', () => {
  it('upserts the named global command without bulk-overwriting other commands', async () => {
    const fetchImpl = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    await registerNanoCodexDiscordCommand({ applicationId: 'app-id', botToken: 'token', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/applications/app-id/commands');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(NANOCODEX_DISCORD_COMMAND);
  });
});
