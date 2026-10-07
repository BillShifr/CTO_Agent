import { z } from 'zod';

const DATABASE_BIGINT_MAX = 9_223_372_036_854_775_807n;
const integrationIdSchema = z.string().trim().min(1).max(128);
const paymentAmountTiynSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(19)
  .transform((value) => BigInt(value))
  .refine((value) => value <= DATABASE_BIGINT_MAX);
const paymentDescriptionSchema = z.string().trim().min(1).max(500);
const paymentErrorCodeSchema = z.string().trim().min(1).max(128);
const paymentRrnSchema = z.string().trim().min(1).max(64);
const cardLastFourDigitsSchema = z.string().regex(/^[0-9]{4}$/);
export const oneCRequestAttemptSchema = z.number().int().positive();

export const oneCServiceSchema = z.object({
  externalId: z.string(),
  code: z.string(),
  name: z.string(),
  categoryPath: z.array(z.string()),
  normHours: z.number().nonnegative(),
  priceTiyn: z.coerce.bigint(),
  active: z.boolean(),
  version: z.string(),
});
export const oneCProductSchema = z.object({
  externalId: z.string(),
  sku: z.string(),
  barcode: z.string().optional(),
  name: z.string(),
  brand: z.string().optional(),
  unit: z.string(),
  retailPriceTiyn: z.coerce.bigint(),
  purchasePriceTiyn: z.coerce.bigint().optional(),
  active: z.boolean(),
  version: z.string(),
});
export const oneCStockBalanceSchema = z.object({
  warehouseExternalId: z.string(),
  productExternalId: z.string(),
  quantity: z.number(),
});
const oneCClientSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('person'),
    name: z.string(),
    phone: z.string(),
    iin: z.string().optional(),
  }),
  z.object({
    type: z.literal('legal_entity'),
    legalName: z.string(),
    bin: z.string().trim().min(1).optional(),
    legalAddress: z.string().trim().min(1).optional(),
    iban: z.string().trim().min(1).optional(),
    bik: z.string().trim().min(1).optional(),
    kbe: z.string().trim().min(1).optional(),
  }),
]);
export const oneCWorkOrderExportSchema = z.object({
  workOrderId: integrationIdSchema,
  externalId: z.string().optional(),
  number: z.string(),
  version: z.number().int(),
  stationExternalId: z.string(),
  client: oneCClientSchema,
  vehicle: z.object({
    vin: z.string().optional(),
    registrationNumber: z.string(),
    registrationCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    brand: z.string(),
    model: z.string(),
  }),
  items: z.array(
    z.object({
      itemId: integrationIdSchema,
      externalId: z.string().optional(),
      type: z.enum(['service', 'product']),
      name: z.string(),
      quantity: z.number(),
      priceTiyn: z.coerce.bigint(),
      normHours: z.number().optional(),
    }),
  ),
  totalTiyn: z.coerce.bigint(),
  status: z.string(),
  cancelledReason: z.string().optional(),
});
const oneCInvoiceIssuedBaseSchema = z.object({
  workOrderExternalId: z.string(),
  requestAttempt: oneCRequestAttemptSchema,
  invoiceExternalId: z.string(),
  invoiceNumber: z.string(),
  issuedAt: z.iso.datetime(),
  amountTiyn: z.coerce.bigint(),
  documentUrl: z.url().optional(),
  documentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export const oneCInvoiceIssuedSchema = oneCInvoiceIssuedBaseSchema.refine(
  (value) => (value.documentUrl === undefined) !== (value.documentSha256 === undefined),
  {
    message: 'exactly one invoice document source is required',
    path: ['documentUrl'],
  },
);

export const oneCInvoiceDocumentUploadSchema = oneCInvoiceIssuedBaseSchema
  .omit({ documentUrl: true, documentSha256: true })
  .extend({
    eventId: integrationIdSchema,
    documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const settlementEventFields = {
  eventId: integrationIdSchema,
  workOrderExternalId: integrationIdSchema,
  occurredAt: z.iso.datetime(),
  amountTiyn: z.coerce.bigint().positive(),
};

export const oneCInboundSchema = z
  .discriminatedUnion('event', [
    z.object({
      event: z.literal('invoice.issued'),
      eventId: z.string(),
      payload: oneCInvoiceIssuedSchema,
    }),
    z.object({
      event: z.literal('invoice.error'),
      eventId: z.string(),
      workOrderExternalId: z.string(),
      requestAttempt: oneCRequestAttemptSchema,
      message: z.string(),
    }),
    z.object({
      event: z.literal('invoice.paid'),
      eventId: z.string(),
      workOrderExternalId: z.string(),
      paidAt: z.iso.datetime(),
      amountTiyn: z.coerce.bigint(),
      paymentExternalId: z.string(),
    }),
    z.object({
      event: z.literal('invoice.payment'),
      ...settlementEventFields,
      paymentExternalId: integrationIdSchema,
    }),
    z.object({
      event: z.literal('cash.payment'),
      ...settlementEventFields,
      paymentExternalId: integrationIdSchema,
    }),
    z.object({
      event: z.literal('cash.refund'),
      ...settlementEventFields,
      refundExternalId: integrationIdSchema,
    }),
    z.object({
      event: z.literal('invoice.refund'),
      ...settlementEventFields,
      refundExternalId: integrationIdSchema,
    }),
    z.object({
      // The reversal is performed in 1C / at Smart POS. AvtoPult records the signed outcome but
      // never receives authority to issue a remote card refund itself.
      event: z.literal('payment.refund'),
      ...settlementEventFields,
      method: z.enum(['kaspi_qr', 'card_terminal']),
      paymentExternalId: integrationIdSchema,
      refundExternalId: integrationIdSchema,
    }),
    z.object({
      event: z.literal('workorder.ack'),
      eventId: z.string(),
      workOrderExternalId: z.string(),
      number: z.string(),
      version: z.number().int(),
    }),
    z.object({
      event: z.literal('workorder.changed'),
      eventId: integrationIdSchema,
      workOrderId: integrationIdSchema,
      workOrderExternalId: integrationIdSchema,
      baseVersion: z.number().int().positive(),
      externalVersion: integrationIdSchema,
      changedAt: z.iso.datetime(),
      transition: z
        .object({
          transitionId: z.enum([
            'T2',
            'T3',
            'T4',
            'T5',
            'T6',
            'T7',
            'T8',
            'T9',
            'T10',
            'T11',
            'T12',
            'T13',
            'T14',
            'T15',
            'T16',
          ]),
          facts: z.array(
            z.enum([
              'required_data_saved',
              'person_client',
              'legal_client',
              'invoice_payment_selected',
              'invoice_requisites_complete',
              'invoice_created',
              'invoice_document_attached',
              'invoice_failed_or_timed_out',
              'invoice_retry_cause_resolved',
              'payment_covers_total',
              'manual_payment_audit_complete',
              'work_order_unassigned',
              'mechanic_available',
              'mechanic_assigned',
              'bay_assigned',
              'actor_matches_assigned_mechanic',
              'approved_work_completed',
              'vehicle_issued',
              'cancellation_reason_provided',
              'actor_owns_work_order',
              'mechanic_added_no_items',
              'return_reason_provided',
            ]),
          ),
          comment: z.string().trim().min(1).optional(),
          mechanicId: integrationIdSchema.optional(),
          bayId: integrationIdSchema.optional(),
        })
        .optional(),
      items: z
        .array(
          z.object({
            itemId: integrationIdSchema,
            type: z.enum(['service', 'product']),
            externalId: integrationIdSchema,
            name: z.string().trim().min(1),
            quantityThousandths: z.coerce.bigint().positive(),
            priceTiyn: z.coerce.bigint().nonnegative(),
            normHoursHundredths: z.coerce.bigint().nonnegative().nullable(),
            mechanicShare: z.number().int().min(0).max(100),
            requiresApproval: z.boolean(),
          }),
        )
        .optional(),
    }),
  ])
  .superRefine((event, context) => {
    if (
      event.event === 'workorder.changed' &&
      event.items === undefined &&
      event.transition === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'workorder.changed requires items, transition, or both',
        path: ['items'],
      });
    }
  });

export const qrPaymentCreateSchema = z
  .object({
    workOrderId: integrationIdSchema,
    paymentAttemptId: integrationIdSchema,
    amountTiyn: paymentAmountTiynSchema,
    description: paymentDescriptionSchema,
    stationId: integrationIdSchema,
  })
  .strict();
export const qrPaymentCreatedSchema = z.discriminatedUnion('presentation', [
  z
    .object({
      presentation: z.literal('inline_qr'),
      externalId: integrationIdSchema,
      qrPayload: z.string(),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      presentation: z.literal('smart_pos'),
      externalId: integrationIdSchema,
      instructions: z.string().min(1).max(500),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
]);
const paymentEventShape = {
  eventId: integrationIdSchema,
  externalId: integrationIdSchema,
  amountTiyn: paymentAmountTiynSchema,
  errorCode: paymentErrorCodeSchema.optional(),
  actualMethod: z.enum(['kaspi_qr', 'card_terminal']).optional(),
  transactionId: integrationIdSchema.optional(),
  terminalId: integrationIdSchema.optional(),
  cardMask: z.string().trim().min(4).max(32).optional(),
  rrn: paymentRrnSchema.optional(),
};
const paidPaymentEventSchema = z
  .object({
    ...paymentEventShape,
    status: z.literal('paid'),
    paidAt: z.iso.datetime(),
  })
  .strict();
const failedPaymentEventSchema = z
  .object({
    ...paymentEventShape,
    status: z.literal('failed'),
    paidAt: z.iso.datetime().optional(),
  })
  .strict();
const expiredPaymentEventSchema = z
  .object({
    ...paymentEventShape,
    status: z.literal('expired'),
    paidAt: z.iso.datetime().optional(),
  })
  .strict();
export const qrPaymentEventSchema = z.discriminatedUnion('status', [
  paidPaymentEventSchema,
  failedPaymentEventSchema,
  expiredPaymentEventSchema,
]);
export const terminalPaymentCreatedSchema = z
  .object({
    externalId: integrationIdSchema,
    instructions: z.string(),
  })
  .strict();
const terminalPaymentEventShape = { cardMask: cardLastFourDigitsSchema.optional() };
export const terminalPaymentEventSchema = z.discriminatedUnion('status', [
  paidPaymentEventSchema.extend(terminalPaymentEventShape),
  failedPaymentEventSchema.extend(terminalPaymentEventShape),
  expiredPaymentEventSchema.extend(terminalPaymentEventShape),
]);
export const vehicleDraftSchema = z.object({
  brand: z.string(),
  model: z.string().optional(),
  year: z.number().int().optional(),
  bodyType: z.string().optional(),
  engineVolumeL: z.number().optional(),
  powerHp: z.number().optional(),
  transmission: z.string().optional(),
  source: z.enum(['vpic', 'secondary', 'manual']),
  raw: z.unknown(),
});

export type OneCService = z.infer<typeof oneCServiceSchema>;
export type OneCProduct = z.infer<typeof oneCProductSchema>;
export type OneCStockBalance = z.infer<typeof oneCStockBalanceSchema>;
export type OneCWorkOrderExport = z.infer<typeof oneCWorkOrderExportSchema>;
export type OneCInvoiceDocumentUpload = z.infer<typeof oneCInvoiceDocumentUploadSchema>;
export type OneCRequestAttempt = z.infer<typeof oneCRequestAttemptSchema>;
export type OneCInbound = z.infer<typeof oneCInboundSchema>;
export type QrPaymentCreate = z.infer<typeof qrPaymentCreateSchema>;
export type QrPaymentCreated = z.infer<typeof qrPaymentCreatedSchema>;
export type QrPaymentEvent = z.infer<typeof qrPaymentEventSchema>;
export type TerminalPaymentCreated = z.infer<typeof terminalPaymentCreatedSchema>;
export type TerminalPaymentEvent = z.infer<typeof terminalPaymentEventSchema>;
export type VehicleDraft = z.infer<typeof vehicleDraftSchema>;
