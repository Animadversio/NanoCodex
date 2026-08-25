import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { createAgentGroup } from './agent-groups.js';
import { createMessagingGroup } from './messaging-groups.js';
import { migrations, runMigrations } from './migrations/index.js';

afterEach(async () => {
  await closeDb();
});

describe('context-tree migration', () => {
  it('backfills a channel trunk, child branch, bindings, and runtime links', async () => {
    const db = await initTestDb();
    await runMigrations(
      db,
      migrations.filter((migration) => !['context-tree', 'context-runtime-preferences'].includes(migration.name)),
    );
    const now = new Date().toISOString();
    await createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: now,
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'discord:guild:channel',
      instance: 'discord',
      name: 'Project',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now,
    });
    for (const [id, threadId] of [
      ['sess-trunk', 'discord:guild:channel'],
      ['sess-branch', 'discord:guild:channel:thread-1'],
    ]) {
      await getDb().run(
        `INSERT INTO sessions
           (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
         VALUES (?, 'ag-1', 'mg-1', ?, NULL, 'active', 'stopped', NULL, ?)`,
        id,
        threadId,
        now,
      );
    }

    await runMigrations(db, migrations);

    const nodes = await getDb().all<{
      id: string;
      kind: string;
      parent_context_id: string | null;
    }>('SELECT id, kind, parent_context_id FROM context_nodes ORDER BY kind DESC');
    const trunk = nodes.find((node) => node.kind === 'trunk')!;
    const branch = nodes.find((node) => node.kind === 'branch')!;
    expect(branch.parent_context_id).toBe(trunk.id);
    expect(await getDb().all('SELECT thread_key, context_node_id FROM surface_bindings ORDER BY thread_key')).toEqual([
      { thread_key: '', context_node_id: trunk.id },
      { thread_key: 'discord:guild:channel:thread-1', context_node_id: branch.id },
    ]);
    expect(await getDb().all('SELECT id, context_node_id FROM sessions ORDER BY id')).toEqual([
      { id: 'sess-branch', context_node_id: branch.id },
      { id: 'sess-trunk', context_node_id: trunk.id },
    ]);
  });
});
