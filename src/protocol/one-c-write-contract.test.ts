import { describe, expect, it } from 'vitest';
import {
  ONE_C_WRITE_CONTRACT_VERSION,
  oneCIdempotencyKeySchema,
  oneCInvoiceRequestSchema,
  oneCWorkOrderUpsertRequestSchema,
  oneCWorkOrderUpsertResponseSchema,
  oneCWriteProblemSchema,
} from './one-c-write-contract.js';

const workOrder = {
  workOrderId: 'work-order-42',
  number: 'WO-42',
  version: 3,
  stationExternalId: 'warehouse-1',
  client: { type: 'person' as const, name: 'Client', phone: '+77010000000' },
  vehicle: { registrationNumber: '482KRA02', brand: 'Toyota', model: 'Camry' },
  items: [
    {
      itemId: 'item-1',
      externalId: 'service-1',
      type: 'service' as const,
      name: 'Diagnostics',
      quantity: 1,
      priceTiyn: '125000',
      normHours: 1.5,
    },
  ],
  totalTiyn: '125000',
  status: 'created',
};

describe('1C write contract', () => {
  it('preserves stable identities and actual line policy through wire validation', () => {
    const enriched = {
      ...workOrder,
      clientId: 'client-42',
      vehicleId: 'vehicle-42',
      items: [{ ...workOrder.items[0], mechanicShare: 75, requiresApproval: true }],
    };
    expect(
      oneCWorkOrderUpsertRequestSchema.parse({
        contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
        workOrder: enriched,
      }).workOrder,
    ).toEqual(enriched);
  });

  it('accepts the canonical work-order request and acknowledgement', () => {
    expect(
      oneCWorkOrderUpsertRequestSchema.parse({
        contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
        workOrder,
      }),
    ).toMatchObject({ workOrder: { number: 'WO-42', totalTiyn: '125000' } });
    expect(
      oneCWorkOrderUpsertResponseSchema.parse({
        contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
        externalId: '9b903d88-bbd2-11f1-8705-9c6b00dcef78',
        version: 3,
        result: 'created',
      }),
    ).toMatchObject({ version: 3, result: 'created' });
  });

  it.each([125000n, 0, -1, '01', '9223372036854775808'])(
    'rejects a non-canonical wire amount %s',
    (amountTiyn) => {
      expect(
        oneCWorkOrderUpsertRequestSchema.safeParse({
          contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
          workOrder: { ...workOrder, totalTiyn: amountTiyn },
        }).success,
      ).toBe(false);
    },
  );

  it('requires a durable outbox idempotency key', () => {
    expect(oneCIdempotencyKeySchema.parse('outbox:84b5dd67-03b4-49f7-a14f-49e94fbc7db3')).toBe(
      'outbox:84b5dd67-03b4-49f7-a14f-49e94fbc7db3',
    );
    expect(oneCIdempotencyKeySchema.safeParse('retry-1').success).toBe(false);
  });

  it('rejects an outbound item without a stable 1C catalog identity', () => {
    expect(
      oneCWorkOrderUpsertRequestSchema.safeParse({
        contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
        workOrder: {
          ...workOrder,
          items: [{ ...workOrder.items[0], externalId: undefined }],
        },
      }).success,
    ).toBe(false);
  });

  it('defines asynchronous invoice acceptance and bounded machine-readable failures', () => {
    expect(
      oneCInvoiceRequestSchema.parse({
        contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
        workOrderExternalId: 'work-order-1',
        amountTiyn: '420000',
        requestAttempt: 2,
      }),
    ).toMatchObject({ requestAttempt: 2 });
    expect(
      oneCWriteProblemSchema.parse({
        contractVersion: ONE_C_WRITE_CONTRACT_VERSION,
        code: 'STALE_VERSION',
        message: 'Expected version 5',
        retryable: false,
        currentVersion: 5,
      }),
    ).toMatchObject({ retryable: false, currentVersion: 5 });
  });
});
