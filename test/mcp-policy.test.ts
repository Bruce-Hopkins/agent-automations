import assert from 'node:assert/strict';
import test from 'node:test';
import { FlowService } from '../src/app/flow-service';
import { assertFlowAllowed, PolicyError, type McpPolicy } from '../src/mcp/policy';

const DENY_ALL: McpPolicy = {
  allowBash: false,
  allowWrite: false,
  allowWeb: false,
  allowEmail: false,
  allowMcp: false,
  allowFlowPaths: true,
  maxConcurrentRuns: 1,
  maxFlowBytes: 1024,
  maxResultBytes: 1024,
};

function graphWith(permissions: Record<string, boolean>) {
  return new FlowService().loadPayload({
    nodes: [
      {
        id: 'a',
        label: 'A',
        provider: 'openai',
        model: 'gpt-4o-mini',
        prompt: 'a',
        permissions,
      },
    ],
    edges: [],
  });
}

test('read-only flows are allowed by a deny-all policy', () => {
  assert.doesNotThrow(() => assertFlowAllowed(graphWith({ read: true }), DENY_ALL));
});

test('dangerous permissions are named when denied', () => {
  assert.throws(
    () => assertFlowAllowed(graphWith({ bash: true, write: true }), DENY_ALL),
    (error: unknown) => error instanceof PolicyError && /requests bash/.test(error.message),
  );
});

test('an explicit allow lets the permission through', () => {
  assert.doesNotThrow(() => assertFlowAllowed(graphWith({ bash: true }), { ...DENY_ALL, allowBash: true }));
});

test('the refusal names the exact command that allows every denied permission', () => {
  assert.throws(
    () => assertFlowAllowed(graphWith({ bash: true, email_read: true, mcp: true }), DENY_ALL),
    (error: unknown) => error instanceof PolicyError && /settings --allow bash,email,mcp`/.test(error.message),
  );
});

test('a permission granted for one run lets the flow through without changing the policy', () => {
  const policy = { ...DENY_ALL };
  assert.doesNotThrow(() => assertFlowAllowed(graphWith({ bash: true }), policy, new Set(['LEAFI_ALLOW_BASH'] as const)));
  assert.equal(policy.allowBash, false);
});
