import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

const { requestApproval, approvalHandlers, resolvedHandlers, writeSessionMessage } = vi.hoisted(() => ({
  requestApproval: vi.fn().mockResolvedValue(undefined),
  approvalHandlers: new Map<string, (ctx: Record<string, unknown>) => Promise<void>>(),
  resolvedHandlers: [] as Array<(event: Record<string, unknown>) => Promise<void> | void>,
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...args: unknown[]) => requestApproval(...args),
  registerApprovalHandler: (action: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
    approvalHandlers.set(action, handler);
  },
}));

vi.mock('../approvals/primitive.js', () => ({
  registerApprovalResolvedHandler: (handler: (event: Record<string, unknown>) => Promise<void> | void) => {
    resolvedHandlers.push(handler);
  },
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => writeSessionMessage(...args),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  withExistingMailboxSession: vi.fn(),
}));

import './index.js';
import { getDeliveryAction } from '../../delivery.js';

const session = { id: 'session-1', agent_group_id: 'group-1', messaging_group_id: null } as Session;
const assessment = {
  id: 'review-1',
  turn_id: 'turn-1',
  started_at_ms: 1,
  completed_at_ms: 2,
  status: 'denied',
  action: { type: 'command', source: 'shell', command: 'rm file', cwd: '/tmp' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Guardian host bridge', () => {
  it('requests a human hold only for a genuine denied assessment', async () => {
    const action = getDeliveryAction('guardian_review');
    expect(action).toBeDefined();

    await action!(
      {
        requestId: 'review-1',
        status: 'denied',
        riskLevel: 'high',
        rationale: 'destructive',
        assessment,
        reviewedAction: assessment.action,
      },
      session,
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      session,
      action: 'guardian_override',
      payload: { requestId: 'review-1', assessment },
    });

    await action!(
      {
        requestId: 'review-2',
        status: 'approved',
        assessment: { ...assessment, id: 'review-2', status: 'approved' },
        reviewedAction: assessment.action,
      },
      session,
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('writes a system response only after the registered approval handler runs', async () => {
    const handler = approvalHandlers.get('guardian_override');
    expect(handler).toBeDefined();
    await handler!({ session, payload: { requestId: 'review-1', assessment }, userId: 'discord:admin' });

    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
    const message = writeSessionMessage.mock.calls[0][2] as { kind: string; content: string };
    expect(message.kind).toBe('system');
    expect(JSON.parse(message.content)).toMatchObject({
      type: 'guardian_override_response',
      requestId: 'review-1',
      approved: true,
      approvedBy: 'discord:admin',
      assessment,
    });
  });

  it('routes an authorized rejection back without granting the action', async () => {
    const approval = {
      action: 'guardian_override',
      payload: JSON.stringify({ requestId: 'review-1', assessment }),
    } as PendingApproval;
    await resolvedHandlers[0]({ approval, session, outcome: 'reject', userId: 'discord:admin' });

    const message = writeSessionMessage.mock.calls[0][2] as { content: string };
    expect(JSON.parse(message.content)).toMatchObject({ approved: false, assessment });
  });
});
