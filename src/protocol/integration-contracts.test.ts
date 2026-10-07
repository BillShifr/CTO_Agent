import { describe, expect, it } from 'vitest';
import {
  oneCInboundSchema,
  oneCRequestAttemptSchema,
  oneCWorkOrderExportSchema,
  qrPaymentCreateSchema,
  qrPaymentEventSchema,
  terminalPaymentEventSchema,
  vehicleDraftSchema,
} from './integration-contracts.js';

describe('integration contracts', () => {
  it('parses the canonical 1C acknowledgement', () => {
    expect(
      oneCInboundSchema.parse({
        event: 'workorder.ack',
        eventId: 'evt-1',
        workOrderExternalId: 'wo-1',
        number: 'WO-1',
        version: 2,
      }),
    ).toMatchObject({ event: 'workorder.ack', version: 2 });
  });

  it('exports a legal work order before invoice requisites are complete', () => {
    expect(
      oneCWorkOrderExportSchema.parse({
        workOrderId: 'work-order-1',
        number: 'WO-1',
        version: 3,
        stationExternalId: 'station-1',
        client: { type: 'legal_entity', legalName: 'Client LLP' },
        vehicle: { registrationNumber: '482KRA02', brand: 'Toyota', model: 'Camry' },
        items: [],
        totalTiyn: '0',
        status: 'created',
      }).client,
    ).toEqual({ type: 'legal_entity', legalName: 'Client LLP' });
  });

  it.each(['bin', 'legalAddress', 'iban', 'bik', 'kbe'] as const)(
    'rejects an empty legal requisite instead of exporting it as %s',
    (field) => {
      expect(() =>
        oneCWorkOrderExportSchema.parse({
          workOrderId: 'work-order-1',
          number: 'WO-1',
          version: 3,
          stationExternalId: 'station-1',
          client: { type: 'legal_entity', legalName: 'Client LLP', [field]: '   ' },
          vehicle: { registrationNumber: '482KRA02', brand: 'Toyota', model: 'Camry' },
          items: [],
          totalTiyn: 0n,
          status: 'created',
        }),
      ).toThrow();
    },
  );

  it('rejects a VIN result without a brand', () => {
    expect(() => vehicleDraftSchema.parse({ model: 'Camry', source: 'vpic', raw: {} })).toThrow();
  });

  it.each(['vpic', 'secondary', 'manual'] as const)(
    'keeps the legacy %s draft independent from the public decoder response',
    (source) => {
      expect(
        vehicleDraftSchema.parse({ brand: 'Toyota', source, raw: { provider: source } }),
      ).toStrictEqual({
        brand: 'Toyota',
        source,
        raw: { provider: source },
      });
    },
  );
});

describe('1C invoice callback request correlation', () => {
  it.each([0, -1, 1.5])('rejects invalid request attempt %s', (requestAttempt) => {
    expect(oneCRequestAttemptSchema.safeParse(requestAttempt).success).toBe(false);
  });

  it.each([
    {
      event: 'invoice.issued',
      eventId: 'evt-issued',
      payload: {
        workOrderExternalId: 'wo-1',
        invoiceExternalId: 'invoice-1',
        invoiceNumber: 'INV-1',
        issuedAt: '2026-09-17T08:00:00.000Z',
        amountTiyn: 1000n,
        documentUrl: 'https://example.test/invoice.pdf',
      },
    },
    {
      event: 'invoice.error',
      eventId: 'evt-error',
      workOrderExternalId: 'wo-1',
      message: 'Provider timeout',
    },
  ])('requires requestAttempt for $event callbacks', (callback) => {
    expect(oneCInboundSchema.safeParse(callback).success).toBe(false);
  });

  it('accepts positive requestAttempt on invoice callbacks', () => {
    expect(
      oneCInboundSchema.safeParse({
        event: 'invoice.error',
        eventId: 'evt-error',
        workOrderExternalId: 'wo-1',
        requestAttempt: 2,
        message: 'Provider timeout',
      }).success,
    ).toBe(true);
  });
});

describe('1C refund and reverse work-order contracts', () => {
  it('accepts a provider refund only with its original provider payment identity', () => {
    expect(
      oneCInboundSchema.parse({
        event: 'payment.refund',
        eventId: 'event-refund-1',
        workOrderExternalId: 'one-c-order-1',
        occurredAt: '2026-10-06T10:00:00.000Z',
        amountTiyn: '1200',
        method: 'card_terminal',
        paymentExternalId: 'smart-pos-1',
        refundExternalId: 'one-c-return-1',
      }),
    ).toMatchObject({ event: 'payment.refund', method: 'card_terminal', amountTiyn: 1200n });
    expect(
      oneCInboundSchema.safeParse({
        event: 'payment.refund',
        eventId: 'event-refund-1',
        workOrderExternalId: 'one-c-order-1',
        occurredAt: '2026-10-06T10:00:00.000Z',
        amountTiyn: '1200',
        method: 'card_terminal',
        refundExternalId: 'one-c-return-1',
      }).success,
    ).toBe(false);
  });

  it('requires a meaningful reverse work-order change with 1C catalog identities', () => {
    const changed = {
      event: 'workorder.changed',
      eventId: 'event-1',
      workOrderId: 'work-order-1',
      workOrderExternalId: 'one-c-order-1',
      baseVersion: 4,
      externalVersion: 'one-c-v5',
      changedAt: '2026-10-02T09:00:00.000Z',
    };
    expect(oneCInboundSchema.safeParse(changed).success).toBe(false);
    expect(
      oneCInboundSchema.safeParse({
        ...changed,
        items: [
          {
            itemId: 'item-1',
            externalId: 'one-c-service-1',
            type: 'service',
            name: 'Diagnostics',
            quantityThousandths: '1000',
            priceTiyn: '125000',
            normHoursHundredths: '150',
            mechanicShare: 50,
            requiresApproval: false,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

const paymentCreate = {
  workOrderId: 'wo-1',
  paymentAttemptId: 'attempt-1',
  amountTiyn: '1300',
  description: 'WO-1',
  stationId: 'station-1',
};

describe('payment boundary contracts', () => {
  it('accepts canonical positive int64 tiyn strings and returns bigint', () => {
    expect(qrPaymentCreateSchema.parse(paymentCreate).amountTiyn).toBe(1300n);
    expect(
      qrPaymentEventSchema.parse({
        eventId: 'evt-2',
        externalId: 'pay-1',
        status: 'paid',
        amountTiyn: '1300',
        paidAt: '2026-09-15T08:00:00.000Z',
      }).amountTiyn,
    ).toBe(1300n);
  });

  it.each([0, 1300n, '0', '-1', '01', '9223372036854775808'])(
    'rejects invalid tiyn %s',
    (amountTiyn) => {
      expect(() => qrPaymentCreateSchema.parse({ ...paymentCreate, amountTiyn })).toThrow();
    },
  );

  it('requires paidAt for paid events', () => {
    expect(() =>
      qrPaymentEventSchema.parse({
        eventId: 'evt-2',
        externalId: 'pay-1',
        status: 'paid',
        amountTiyn: '1300',
      }),
    ).toThrow();
  });

  it('trims bounded payment identifiers and descriptions', () => {
    expect(
      qrPaymentCreateSchema.parse({
        ...paymentCreate,
        workOrderId: ' wo-1 ',
        paymentAttemptId: ' attempt-1 ',
        description: ' WO-1 ',
        stationId: ' station-1 ',
      }),
    ).toMatchObject({
      workOrderId: 'wo-1',
      paymentAttemptId: 'attempt-1',
      description: 'WO-1',
      stationId: 'station-1',
    });
    expect(() =>
      qrPaymentCreateSchema.parse({ ...paymentCreate, description: 'x'.repeat(501) }),
    ).toThrow();
  });
});

describe('terminal payment boundary contracts', () => {
  it.each(['123', '12345', '12A4', ' 1234 '])('rejects non-canonical cardMask %s', (cardMask) => {
    expect(() =>
      terminalPaymentEventSchema.parse({
        eventId: 'evt-2',
        externalId: 'pay-1',
        status: 'failed',
        amountTiyn: '1300',
        cardMask,
      }),
    ).toThrow();
  });

  it('accepts four card digits and bounded provider references', () => {
    expect(
      terminalPaymentEventSchema.parse({
        eventId: 'evt-2',
        externalId: 'pay-1',
        status: 'failed',
        amountTiyn: '1300',
        cardMask: '1234',
        rrn: 'rrn-1',
        errorCode: 'declined',
      }),
    ).toMatchObject({ cardMask: '1234', rrn: 'rrn-1', errorCode: 'declined' });
  });

  it('accepts the actual Smart POS method and transaction evidence', () => {
    expect(
      terminalPaymentEventSchema.parse({
        eventId: 'evt-3',
        externalId: 'pay-2',
        status: 'paid',
        amountTiyn: '2500',
        actualMethod: 'card_terminal',
        transactionId: '987654',
        terminalId: 'terminal-1',
        cardMask: '4321',
        rrn: 'rrn-2',
        paidAt: '2026-10-06T12:00:00.000Z',
      }),
    ).toMatchObject({
      actualMethod: 'card_terminal',
      transactionId: '987654',
      terminalId: 'terminal-1',
      cardMask: '4321',
      rrn: 'rrn-2',
    });
  });

  it.each([
    ['rrn', 65],
    ['errorCode', 129],
  ] as const)('rejects oversized %s', (field, length) => {
    expect(() =>
      terminalPaymentEventSchema.parse({
        eventId: 'evt-2',
        externalId: 'pay-1',
        status: 'failed',
        amountTiyn: '1300',
        [field]: 'x'.repeat(length),
      }),
    ).toThrow();
  });
});
