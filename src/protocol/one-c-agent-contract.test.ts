import { describe, expect, it } from 'vitest';
import {
  canonicalAgentJson,
  oneCAgentClaimResponseSchema,
  oneCAgentResultSchema,
  oneCAgentInboundAckSchema,
  oneCAgentInboundReceiptSchema,
  oneCAgentHeartbeatSchema,
} from './one-c-agent-contract.js';

const id = 'a3f63973-d63f-4f07-8279-57300f22b409';
const token = 'x'.repeat(32);

describe('1C agent relay contract', () => {
  it('carries the resulting order version without requiring it for payment receipts', () => {
    expect(
      oneCAgentInboundReceiptSchema.parse({ accepted: true, eventId: 'e-1', workOrderVersion: 7 })
        .workOrderVersion,
    ).toBe(7);
    expect(
      oneCAgentInboundAckSchema.parse({ leaseToken: token, workOrderVersion: 7 }).workOrderVersion,
    ).toBe(7);
    expect(
      oneCAgentInboundReceiptSchema.parse({ accepted: true, eventId: 'e-1' }).workOrderVersion,
    ).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', null])(
    'rejects unsafe resulting version %s',
    (workOrderVersion) => {
      expect(
        oneCAgentInboundReceiptSchema.safeParse({
          accepted: true,
          eventId: 'e-1',
          workOrderVersion,
        }).success,
      ).toBe(false);
      expect(
        oneCAgentInboundAckSchema.safeParse({ leaseToken: token, workOrderVersion }).success,
      ).toBe(false);
    },
  );

  it('canonicalizes nested object keys for JSONB-stable transfer hashes', () => {
    expect(canonicalAgentJson([{ z: 1, a: { y: 2, b: 3 } }])).toBe('[{"a":{"b":3,"y":2},"z":1}]');
  });

  it('accepts storage pressure telemetry while remaining compatible with an older agent', () => {
    const legacy = oneCAgentHeartbeatSchema.parse({
      agentId: 'station-1',
      version: '0.1.0',
      startedAt: '2026-10-10T00:00:00.000Z',
      pendingResults: 0,
      components: { smartPos: 'disabled', oneCEvents: 'ok', oneCDocuments: 'ok' },
      failures: [],
    });
    expect(legacy.components).toMatchObject({ resultDelivery: 'ok', storage: 'ok' });

    expect(() =>
      oneCAgentHeartbeatSchema.parse({
        ...legacy,
        storage: {
          status: 'degraded',
          stateBytes: '2000000000',
          freeBytes: '99999999',
          maxStateBytes: '2000000000',
          minFreeBytes: '1000000000',
          queues: { results: 4, odataTransfers: 1, smartPosPayments: 2 },
        },
        components: { ...legacy.components, storage: 'degraded' },
        failures: ['agent_storage'],
      }),
    ).not.toThrow();
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
