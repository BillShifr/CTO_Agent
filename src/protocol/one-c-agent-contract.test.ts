import { describe, expect, it } from 'vitest';
import { oneCAgentClaimResponseSchema, oneCAgentResultSchema } from './one-c-agent-contract.js';

const id = 'a3f63973-d63f-4f07-8279-57300f22b409';
const token = 'x'.repeat(32);

describe('1C agent relay contract', () => {
  it('accepts a leased invoice command and its exact typed result', () => {
    const command = oneCAgentClaimResponseSchema.parse({
      retryAfterMs: 250,
      command: {
        id,
        kind: 'invoice.request',
        idempotencyKey: 'outbox:message-1',
        leaseToken: token,
        leaseUntil: '2026-10-03T00:00:00.000Z',
        request: {
          contractVersion: '1.0',
          workOrderExternalId: 'wo-1',
          amountTiyn: '50000',
          requestAttempt: 1,
        },
      },
    });
    expect(command.command?.kind).toBe('invoice.request');
    expect(() =>
      oneCAgentResultSchema.parse({
        kind: 'invoice.request',
        leaseToken: token,
        outcome: {
          status: 'succeeded',
          response: { contractVersion: '1.0', requestId: 'request-1', status: 'accepted' },
        },
      }),
    ).not.toThrow();
  });

  it('rejects an untyped response that could acknowledge the wrong command', () => {
    expect(
      oneCAgentResultSchema.safeParse({
        kind: 'invoice.request',
        leaseToken: token,
        outcome: {
          status: 'succeeded',
          response: { contractVersion: '1.0', externalId: 'wo-1', version: 1, result: 'created' },
        },
      }).success,
    ).toBe(false);
  });
});
