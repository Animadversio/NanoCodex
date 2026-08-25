import { getContextNode, setContextCodexThreadId } from './db/context-nodes.js';
import { findSessionByContext, getActiveSessions } from './db/sessions.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { ContextNode, Session } from './types.js';

const CODEX_CONTINUATION_KEY = 'continuation:codex';

/** Copy the runner-owned continuation into the durable context identity. */
export async function syncContextCodexThread(session: Session): Promise<string | null> {
  if (!session.context_node_id) return null;
  const state = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getState(CODEX_CONTINUATION_KEY),
  );
  const threadId = state?.value?.trim();
  if (!threadId) return null;
  await setContextCodexThreadId(session.context_node_id, threadId);
  return threadId;
}

/** Import existing runner continuations after a schema upgrade or host restart. */
export async function syncActiveContextContinuations(): Promise<void> {
  for (const session of await getActiveSessions()) await syncContextCodexThread(session);
}

async function refreshedContext(contextId: string): Promise<ContextNode> {
  const context = await getContextNode(contextId);
  if (!context) throw new Error(`Context node not found: ${contextId}`);
  return context;
}

/** Runtime-only environment derived from the durable context tree. */
export async function contextRuntimeEnvironment(session: Session): Promise<Record<string, string>> {
  if (!session.context_node_id) return {};
  await syncContextCodexThread(session);
  const context = await refreshedContext(session.context_node_id);
  const environment: Record<string, string> = { NANOCLAW_CONTEXT_NODE_ID: context.id };
  if (context.service_tier) environment.NANOCLAW_CODEX_SERVICE_TIER = context.service_tier;
  if (context.reasoning_effort) environment.NANOCLAW_CODEX_REASONING_EFFORT = context.reasoning_effort;
  if (context.codex_thread_id) environment.NANOCLAW_CODEX_CONTEXT_THREAD_ID = context.codex_thread_id;
  if (context.kind !== 'branch' || !context.parent_context_id || context.codex_thread_id) return environment;

  let parent = await refreshedContext(context.parent_context_id);
  if (!parent.codex_thread_id) {
    const parentSession = await findSessionByContext(parent.id);
    if (parentSession) {
      await syncContextCodexThread(parentSession);
      parent = await refreshedContext(parent.id);
    }
  }
  if (parent.codex_thread_id) environment.NANOCLAW_CODEX_FORK_THREAD_ID = parent.codex_thread_id;
  if (context.forked_from_turn_id) environment.NANOCLAW_CODEX_FORK_TURN_ID = context.forked_from_turn_id;
  return environment;
}
