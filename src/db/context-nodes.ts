import type { ContextNode, ContextNodeKind, SurfaceBinding } from '../types.js';
import { getDb } from './connection.js';
import { isUniqueViolation } from './errors.js';

function generateId(prefix: 'ctx' | 'surface'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getContextNode(id: string): Promise<ContextNode | undefined> {
  return getDb().get<ContextNode>('SELECT * FROM context_nodes WHERE id = ?', id);
}

export async function getContextNodesByAgentGroup(agentGroupId: string): Promise<ContextNode[]> {
  return getDb().all<ContextNode>(
    'SELECT * FROM context_nodes WHERE agent_group_id = ? ORDER BY created_at, id',
    agentGroupId,
  );
}

export async function getSurfaceBindingsByAgentGroup(agentGroupId: string): Promise<SurfaceBinding[]> {
  return getDb().all<SurfaceBinding>(
    'SELECT * FROM surface_bindings WHERE agent_group_id = ? ORDER BY messaging_group_id, thread_key',
    agentGroupId,
  );
}

export async function findSurfaceBinding(
  agentGroupId: string,
  messagingGroupId: string,
  threadKey: string,
): Promise<SurfaceBinding | undefined> {
  return getDb().get<SurfaceBinding>(
    `SELECT * FROM surface_bindings
      WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_key = ?`,
    agentGroupId,
    messagingGroupId,
    threadKey,
  );
}

export async function bindSurfaceToContext(input: {
  agentGroupId: string;
  messagingGroupId: string;
  platformId: string;
  threadId: string | null;
  contextNodeId: string;
}): Promise<void> {
  const threadKey = input.threadId && input.threadId !== input.platformId ? input.threadId : '';
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO surface_bindings
       (id, agent_group_id, messaging_group_id, thread_key, context_node_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_group_id, messaging_group_id, thread_key) DO UPDATE SET
       context_node_id = excluded.context_node_id,
       updated_at = excluded.updated_at`,
    generateId('surface'),
    input.agentGroupId,
    input.messagingGroupId,
    threadKey,
    input.contextNodeId,
    now,
    now,
  );
}

async function createNodeAndBinding(input: {
  agentGroupId: string;
  messagingGroupId: string;
  threadKey: string;
  kind: ContextNodeKind;
  parentContextId: string | null;
  serviceTier: string | null;
  reasoningEffort: string | null;
}): Promise<ContextNode> {
  const now = new Date().toISOString();
  const node: ContextNode = {
    id: generateId('ctx'),
    agent_group_id: input.agentGroupId,
    kind: input.kind,
    parent_context_id: input.parentContextId,
    forked_from_turn_id: null,
    codex_thread_id: null,
    service_tier: input.serviceTier,
    reasoning_effort: input.reasoningEffort,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  const binding: SurfaceBinding = {
    id: generateId('surface'),
    agent_group_id: input.agentGroupId,
    messaging_group_id: input.messagingGroupId,
    thread_key: input.threadKey,
    context_node_id: node.id,
    created_at: now,
    updated_at: now,
  };

  try {
    await getDb().transaction(async () => {
      await getDb().run(
        `INSERT INTO context_nodes
           (id, agent_group_id, kind, parent_context_id, forked_from_turn_id, codex_thread_id,
            service_tier, reasoning_effort, status, created_at, updated_at)
         VALUES (@id, @agent_group_id, @kind, @parent_context_id, @forked_from_turn_id, @codex_thread_id,
                 @service_tier, @reasoning_effort, @status, @created_at, @updated_at)`,
        node,
      );
      await getDb().run(
        `INSERT INTO surface_bindings
           (id, agent_group_id, messaging_group_id, thread_key, context_node_id, created_at, updated_at)
         VALUES (@id, @agent_group_id, @messaging_group_id, @thread_key, @context_node_id, @created_at, @updated_at)`,
        binding,
      );
    });
    return node;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findSurfaceBinding(input.agentGroupId, input.messagingGroupId, input.threadKey);
    if (!raced) throw error;
    const racedNode = await getContextNode(raced.context_node_id);
    if (!racedNode) throw error;
    return racedNode;
  }
}

export async function resolveSurfaceContext(input: {
  agentGroupId: string;
  messagingGroupId: string;
  platformId: string;
  threadId: string | null;
  sessionMode: 'shared' | 'per-thread';
}): Promise<{ context: ContextNode; created: boolean }> {
  const requestedThreadKey = input.threadId && input.threadId !== input.platformId ? input.threadId : '';
  const threadKey = input.sessionMode === 'shared' ? '' : requestedThreadKey;
  const existing = await findSurfaceBinding(input.agentGroupId, input.messagingGroupId, threadKey);
  if (existing) {
    const context = await getContextNode(existing.context_node_id);
    if (!context)
      throw new Error(`Surface binding ${existing.id} points to missing context ${existing.context_node_id}`);
    return { context, created: false };
  }

  let parentContextId: string | null = null;
  let kind: ContextNodeKind = 'trunk';
  let serviceTier: string | null = null;
  let reasoningEffort: string | null = null;
  if (threadKey) {
    const trunk = await resolveSurfaceContext({ ...input, threadId: null, sessionMode: 'shared' });
    parentContextId = trunk.context.id;
    kind = 'branch';
    serviceTier = trunk.context.service_tier;
    reasoningEffort = trunk.context.reasoning_effort;
  }
  const context = await createNodeAndBinding({
    agentGroupId: input.agentGroupId,
    messagingGroupId: input.messagingGroupId,
    threadKey,
    kind,
    parentContextId,
    serviceTier,
    reasoningEffort,
  });
  return { context, created: true };
}

export async function createStandaloneContext(agentGroupId: string): Promise<ContextNode> {
  const now = new Date().toISOString();
  const context: ContextNode = {
    id: generateId('ctx'),
    agent_group_id: agentGroupId,
    kind: 'standalone',
    parent_context_id: null,
    forked_from_turn_id: null,
    codex_thread_id: null,
    service_tier: null,
    reasoning_effort: null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  await getDb().run(
    `INSERT INTO context_nodes
       (id, agent_group_id, kind, parent_context_id, forked_from_turn_id, codex_thread_id,
        service_tier, reasoning_effort, status, created_at, updated_at)
     VALUES (@id, @agent_group_id, @kind, @parent_context_id, @forked_from_turn_id, @codex_thread_id,
             @service_tier, @reasoning_effort, @status, @created_at, @updated_at)`,
    context,
  );
  return context;
}

export async function setContextCodexThreadId(contextId: string, codexThreadId: string): Promise<void> {
  await getDb().run(
    'UPDATE context_nodes SET codex_thread_id = ?, updated_at = ? WHERE id = ?',
    codexThreadId,
    new Date().toISOString(),
    contextId,
  );
}

export async function setContextRuntimePreferences(
  contextId: string,
  preferences: { serviceTier?: string | null; reasoningEffort?: string | null },
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { contextId, updatedAt: new Date().toISOString() };
  if (preferences.serviceTier !== undefined) {
    fields.push('service_tier = @serviceTier');
    values.serviceTier = preferences.serviceTier;
  }
  if (preferences.reasoningEffort !== undefined) {
    fields.push('reasoning_effort = @reasoningEffort');
    values.reasoningEffort = preferences.reasoningEffort;
  }
  if (fields.length === 0) return;
  fields.push('updated_at = @updatedAt');
  await getDb().run(`UPDATE context_nodes SET ${fields.join(', ')} WHERE id = @contextId`, values);
}
