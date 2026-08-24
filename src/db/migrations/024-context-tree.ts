import type { Migration } from './index.js';

/**
 * Split durable conversation identity from transport routing and runtime state.
 *
 * - context_nodes are the logical conversation tree (trunks and branches)
 * - surface_bindings map a messaging surface onto one context node
 * - sessions remain the replaceable runner/mailbox process for a context
 *
 * Existing rows are backfilled conservatively: a channel-level session becomes
 * the trunk, threaded sessions become children, and non-channel sessions become
 * standalone contexts.
 */
export const migration024: Migration = {
  version: 24,
  name: 'context-tree',
  async up(db) {
    await db.exec(`
      CREATE TABLE context_nodes (
        id                  TEXT PRIMARY KEY,
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id),
        kind                TEXT NOT NULL,
        parent_context_id   TEXT REFERENCES context_nodes(id),
        forked_from_turn_id TEXT,
        codex_thread_id     TEXT,
        status              TEXT NOT NULL DEFAULT 'active',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX idx_context_nodes_agent ON context_nodes(agent_group_id, status);
      CREATE INDEX idx_context_nodes_parent ON context_nodes(parent_context_id);

      CREATE TABLE surface_bindings (
        id                 TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        thread_key         TEXT NOT NULL DEFAULT '',
        context_node_id    TEXT NOT NULL REFERENCES context_nodes(id),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE(agent_group_id, messaging_group_id, thread_key)
      );
      CREATE INDEX idx_surface_bindings_context ON surface_bindings(context_node_id);

      ALTER TABLE sessions ADD COLUMN context_node_id TEXT REFERENCES context_nodes(id);
      CREATE INDEX idx_sessions_context ON sessions(context_node_id, status);
    `);

    const now = new Date().toISOString();
    const sessions = await db.all<{
      id: string;
      agent_group_id: string;
      messaging_group_id: string | null;
      thread_id: string | null;
      created_at: string;
      platform_id: string | null;
      session_mode: string | null;
    }>(
      `SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.created_at,
              mg.platform_id, mga.session_mode
         FROM sessions s
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         LEFT JOIN messaging_group_agents mga
           ON mga.messaging_group_id = s.messaging_group_id
          AND mga.agent_group_id = s.agent_group_id
        ORDER BY s.created_at, s.id`,
    );

    const trunks = new Map<string, string>();
    const contextBySurface = new Map<string, string>();
    const channelKey = (agentGroupId: string, messagingGroupId: string): string =>
      `${agentGroupId}\0${messagingGroupId}`;
    const surfaceKey = (agentGroupId: string, messagingGroupId: string, threadKey: string): string =>
      `${agentGroupId}\0${messagingGroupId}\0${threadKey}`;

    for (const session of sessions) {
      if (!session.messaging_group_id || session.session_mode === 'agent-shared') continue;
      const key = channelKey(session.agent_group_id, session.messaging_group_id);
      const isChannelSurface = !session.thread_id || session.thread_id === session.platform_id;
      if (!isChannelSurface || trunks.has(key)) continue;
      const contextId = `ctx-${session.id}`;
      trunks.set(key, contextId);
      contextBySurface.set(surfaceKey(session.agent_group_id, session.messaging_group_id, ''), contextId);
      await db.run(
        `INSERT INTO context_nodes
           (id, agent_group_id, kind, parent_context_id, forked_from_turn_id, codex_thread_id, status, created_at, updated_at)
         VALUES (?, ?, 'trunk', NULL, NULL, NULL, 'active', ?, ?)`,
        contextId,
        session.agent_group_id,
        session.created_at,
        now,
      );
    }

    for (const session of sessions) {
      if (!session.messaging_group_id || session.session_mode === 'agent-shared') continue;
      const key = channelKey(session.agent_group_id, session.messaging_group_id);
      if (trunks.has(key)) continue;
      const contextId = `ctx-trunk-${session.agent_group_id}-${session.messaging_group_id}`;
      trunks.set(key, contextId);
      contextBySurface.set(surfaceKey(session.agent_group_id, session.messaging_group_id, ''), contextId);
      await db.run(
        `INSERT INTO context_nodes
           (id, agent_group_id, kind, parent_context_id, forked_from_turn_id, codex_thread_id, status, created_at, updated_at)
         VALUES (?, ?, 'trunk', NULL, NULL, NULL, 'active', ?, ?)`,
        contextId,
        session.agent_group_id,
        session.created_at,
        now,
      );
    }

    for (const session of sessions) {
      let contextId: string;
      if (!session.messaging_group_id || session.session_mode === 'agent-shared') {
        contextId = `ctx-${session.id}`;
        await db.run(
          `INSERT INTO context_nodes
             (id, agent_group_id, kind, parent_context_id, forked_from_turn_id, codex_thread_id, status, created_at, updated_at)
           VALUES (?, ?, 'standalone', NULL, NULL, NULL, 'active', ?, ?)`,
          contextId,
          session.agent_group_id,
          session.created_at,
          now,
        );
        if (session.messaging_group_id) {
          const threadKey = !session.thread_id || session.thread_id === session.platform_id ? '' : session.thread_id;
          contextBySurface.set(surfaceKey(session.agent_group_id, session.messaging_group_id, threadKey), contextId);
        }
      } else {
        const threadKey = !session.thread_id || session.thread_id === session.platform_id ? '' : session.thread_id;
        const key = surfaceKey(session.agent_group_id, session.messaging_group_id, threadKey);
        const existing = contextBySurface.get(key);
        if (existing) {
          contextId = existing;
        } else {
          contextId = `ctx-${session.id}`;
          contextBySurface.set(key, contextId);
          await db.run(
            `INSERT INTO context_nodes
               (id, agent_group_id, kind, parent_context_id, forked_from_turn_id, codex_thread_id, status, created_at, updated_at)
             VALUES (?, ?, 'branch', ?, NULL, NULL, 'active', ?, ?)`,
            contextId,
            session.agent_group_id,
            trunks.get(channelKey(session.agent_group_id, session.messaging_group_id))!,
            session.created_at,
            now,
          );
        }
      }
      await db.run('UPDATE sessions SET context_node_id = ? WHERE id = ?', contextId, session.id);
    }

    for (const [key, contextId] of contextBySurface) {
      const [agentGroupId, messagingGroupId, threadKey] = key.split('\0');
      await db.run(
        `INSERT INTO surface_bindings
           (id, agent_group_id, messaging_group_id, thread_key, context_node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        `surface-${contextId}`,
        agentGroupId,
        messagingGroupId,
        threadKey,
        contextId,
        now,
        now,
      );
    }
  },
};
