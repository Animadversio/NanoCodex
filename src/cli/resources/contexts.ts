import { registerResource } from '../crud.js';

registerResource({
  name: 'context',
  plural: 'contexts',
  table: 'context_nodes',
  description:
    'Durable conversation node. A trunk is a channel root, a branch is a forked child, and a standalone context has no messaging-tree parent.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Context id.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Owning agent workspace.' },
    { name: 'kind', type: 'string', description: 'Tree role.', enum: ['trunk', 'branch', 'standalone'] },
    { name: 'parent_context_id', type: 'string', description: 'Parent trunk/branch; null for roots.' },
    { name: 'forked_from_turn_id', type: 'string', description: 'Optional inclusive Codex turn boundary.' },
    { name: 'codex_thread_id', type: 'string', description: 'Codex continuation owned by this context.' },
    { name: 'status', type: 'string', description: 'Lifecycle state.', enum: ['active', 'archived'] },
    { name: 'created_at', type: 'string', description: 'Created timestamp.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Last metadata update.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
});

registerResource({
  name: 'surface-binding',
  plural: 'surface-bindings',
  table: 'surface_bindings',
  description: 'Pointer from a messaging channel/thread address to a durable context node.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Binding id.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Owning agent workspace.' },
    { name: 'messaging_group_id', type: 'string', description: 'Channel or DM record.' },
    { name: 'thread_key', type: 'string', description: 'Empty for channel trunk; platform thread id otherwise.' },
    { name: 'context_node_id', type: 'string', description: 'Target durable context.' },
    { name: 'created_at', type: 'string', description: 'Created timestamp.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Last pointer update.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
});
