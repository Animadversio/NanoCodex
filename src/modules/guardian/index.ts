/**
 * Guardian bridge: persist Codex auto-review outcomes and route only denied
 * actions to a NanoCodex admin/owner for an explicit human override.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { requestApproval, registerApprovalHandler } from '../approvals/index.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';

const GUARDIAN_OVERRIDE_ACTION = 'guardian_override';

registerDeliveryAction(
  'guardian_review',
  async (content, session) => {
    const requestId = stringField(content, 'requestId');
    const status = stringField(content, 'status');
    const assessment = objectField(content, 'assessment');
    const reviewedAction = objectField(content, 'reviewedAction');
    if (!requestId || !status || !assessment || !reviewedAction) {
      log.warn('Ignoring malformed Guardian review', { sessionId: session.id, requestId, status });
      return;
    }

    log.info('Guardian review recorded', {
      sessionId: session.id,
      requestId,
      status,
      riskLevel: content.riskLevel,
    });
    if (status !== 'denied') return;
    if (assessment.status !== 'denied') {
      log.warn('Ignoring Guardian override request whose assessment is not denied', { requestId });
      return;
    }

    const rationale = typeof content.rationale === 'string' ? content.rationale : 'No rationale supplied.';
    const risk = typeof content.riskLevel === 'string' ? content.riskLevel : 'unknown';
    await requestApproval({
      session,
      agentName: session.agent_group_id,
      action: GUARDIAN_OVERRIDE_ACTION,
      payload: { requestId, assessment, reviewedAction },
      title: `Codex Guardian denied a ${reviewedAction.type ?? 'tool'} action`,
      question: [
        `Risk: ${risk}`,
        `Reason: ${rationale}`,
        `Action: ${summarizeAction(reviewedAction)}`,
        'Approve only if this exact action should be retried with your authority.',
      ].join('\n'),
    });
  },
  unguarded('records an auto-review and creates a human approval hold; it cannot execute the denied action'),
);

registerApprovalHandler(GUARDIAN_OVERRIDE_ACTION, async ({ session, payload, userId }) => {
  await writeOverrideResponse(session, payload, true, userId);
});

registerApprovalResolvedHandler(async ({ approval, session, outcome, userId }) => {
  if (approval.action !== GUARDIAN_OVERRIDE_ACTION || outcome !== 'reject') return;
  await writeOverrideResponse(session, JSON.parse(approval.payload) as Record<string, unknown>, false, userId);
});

async function writeOverrideResponse(
  session: Session,
  payload: Record<string, unknown>,
  approved: boolean,
  userId: string,
): Promise<void> {
  const requestId = stringField(payload, 'requestId');
  const assessment = objectField(payload, 'assessment');
  if (!requestId || !assessment) return;
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `guardian-response-${requestId}-${approved ? 'approve' : 'reject'}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'guardian_override_response',
      requestId,
      approved,
      approvedBy: userId,
      assessment,
    }),
  });
}

function summarizeAction(action: Record<string, unknown>): string {
  const summary = JSON.stringify(action);
  return summary.length <= 1_500 ? summary : `${summary.slice(0, 1_497)}...`;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
