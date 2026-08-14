import { describe, expect, it } from 'vitest';
import {
  createRuntimeSmokeApprovalRejectedError,
  decideRuntimeSmokeApproval,
  RUNTIME_SMOKE_APPROVAL_REJECTED,
  TOOL_ESCALATION
} from '../src/runtime-staging-smoke.js';

const sessionId = 'session-smoke';

describe('runtime staging smoke approval policy', () => {
  it.each([
    {
      type: 'approval/requested', sessionId, approvalId: 'approval-write', toolName: 'write', callId: 'call-write'
    },
    {
      type: 'approval/requested', sessionId, approvalId: 'approval-write-reason', toolName: 'write', callId: 'call-write',
      reason: 'write the random sentinel in the workspace'
    },
    {
      type: 'approval/requested', sessionId, approvalId: 'approval-extra-fields', toolName: 'write', callId: 'call-write',
      file_path: 'runtime-smoke-random.txt', content: 'nonce', arguments: { file_path: 'runtime-smoke-random.txt' }
    },
    {
      type: 'approval/requested', sessionId, approvalId: 'approval-other-tool', toolName: 'shell', callId: 'call-shell'
    }
  ])('rejects every current-session approval fixture: $approvalId', fixture => {
    expect(decideRuntimeSmokeApproval(fixture, sessionId)).toEqual({
      applicable: true,
      outcome: 'rejected',
      approvalId: fixture.approvalId
    });
  });

  it('fails closed when the frame is current-session but lacks a schema-valid approvalId', () => {
    expect(decideRuntimeSmokeApproval({ type: 'approval/requested', sessionId, toolName: 'write' }, sessionId)).toEqual({
      applicable: true,
      outcome: 'rejected'
    });
  });

  it('does not treat another session approval as this smoke approval', () => {
    expect(decideRuntimeSmokeApproval({
      type: 'approval/requested', sessionId: 'other-session', approvalId: 'approval-other', toolName: 'write'
    }, sessionId)).toEqual({ applicable: false });
  });

  it('exposes stable rejection and escalation codes', () => {
    const error = createRuntimeSmokeApprovalRejectedError();
    expect(error.code).toBe(RUNTIME_SMOKE_APPROVAL_REJECTED);
    expect(error.message).toBe(TOOL_ESCALATION);
  });
});
