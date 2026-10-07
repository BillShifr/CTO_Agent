import { describe, expect, it } from 'vitest';
import {
  canonicalAgentJson,
  oneCAgentClaimResponseSchema,
  oneCAgentResultSchema,
} from './one-c-agent-contract.js';

const id = 'a3f63973-d63f-4f07-8279-57300f22b409';
const token = 'x'.repeat(32);

describe('1C agent relay contract', () => {
  it('canonicalizes nested object keys for JSONB-stable transfer hashes', () => {
    expect(canonicalAgentJson([{ z: 1, a: { y: 2, b: 3 } }])).toBe('[{"a":{"b":3,"y":2},"z":1}]');
  });

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

describe('1C agent extended result contracts', () => {
  it('binds a closed payroll payload to its exact export receipt', () => {
    const parsed = oneCAgentClaimResponseSchema.parse({
      retryAfterMs: 250,
      command: {
        id,
        kind: 'payroll.export',
        idempotencyKey: 'payroll:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leaseToken: token,
        leaseUntil: '2026-10-03T00:00:00.000Z',
        request: {
          periodId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dateFrom: '2026-09-01T00:00:00.000Z',
          dateTo: '2026-10-01T00:00:00.000Z',
          stationId: null,
          lines: [
            {
              employeeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              component: 'refund',
              amountTiyn: '-15000',
              workOrderId: null,
              workOrderItemId: null,
              formula: { sourceComponent: 'percent' },
            },
          ],
        },
      },
    });
    expect(parsed.command?.kind).toBe('payroll.export');
    expect(() =>
      oneCAgentResultSchema.parse({
        kind: 'payroll.export',
        leaseToken: token,
        outcome: { status: 'succeeded', response: { externalId: 'accrual-2026-09' } },
      }),
    ).not.toThrow();
  });

  it('accepts a bounded OData chunk manifest without embedding the collection', () => {
    expect(() =>
      oneCAgentResultSchema.parse({
        kind: 'odata.collection',
        leaseToken: token,
        outcome: {
          status: 'succeeded',
          response: {
            transfer: 'chunks',
            chunkCount: 3,
            itemCount: 12,
            sha256: 'a'.repeat(64),
          },
        },
      }),
    ).not.toThrow();
  });
});
