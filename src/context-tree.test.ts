import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanocodex-context-tree-test' };
});

import { contextRuntimeEnvironment } from './context-runtime.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getContextNode,
  getSurfaceBindingsByAgentGroup,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';

const TEST_DIR = '/tmp/nanocodex-context-tree-test';
const PLATFORM_ID = 'discord:guild:channel';

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: PLATFORM_ID,
    instance: 'discord',
    name: 'Project',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('context tree routing', () => {
  it('binds the channel to a trunk and a Discord thread to a child branch', async () => {
    const trunk = await resolveSession('ag-1', 'mg-1', PLATFORM_ID, 'per-thread');
    const branch = await resolveSession('ag-1', 'mg-1', `${PLATFORM_ID}:thread-1`, 'per-thread');

    const trunkContext = await getContextNode(trunk.session.context_node_id!);
    const branchContext = await getContextNode(branch.session.context_node_id!);
    expect(trunkContext).toMatchObject({ kind: 'trunk', parent_context_id: null });
    expect(branchContext).toMatchObject({ kind: 'branch', parent_context_id: trunkContext!.id });
    expect(await getSurfaceBindingsByAgentGroup('ag-1')).toEqual([
      expect.objectContaining({ thread_key: '', context_node_id: trunkContext!.id }),
      expect.objectContaining({ thread_key: `${PLATFORM_ID}:thread-1`, context_node_id: branchContext!.id }),
    ]);
  });

  it('hands a new branch the trunk Codex thread as its native fork source', async () => {
    const trunk = await resolveSession('ag-1', 'mg-1', PLATFORM_ID, 'per-thread');
    const out = new Database(outboundDbPath('ag-1', trunk.session.id));
    out
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('continuation:codex', 'codex-trunk-thread', new Date().toISOString());
    out.close();

    const branch = await resolveSession('ag-1', 'mg-1', `${PLATFORM_ID}:thread-2`, 'per-thread');
    await expect(contextRuntimeEnvironment(branch.session)).resolves.toMatchObject({
      NANOCLAW_CONTEXT_NODE_ID: branch.session.context_node_id,
      NANOCLAW_CODEX_FORK_THREAD_ID: 'codex-trunk-thread',
    });
    await expect(getContextNode(trunk.session.context_node_id!)).resolves.toMatchObject({
      codex_thread_id: 'codex-trunk-thread',
    });
    await expect(contextRuntimeEnvironment(trunk.session)).resolves.toMatchObject({
      NANOCLAW_CODEX_CONTEXT_THREAD_ID: 'codex-trunk-thread',
    });
  });
});
