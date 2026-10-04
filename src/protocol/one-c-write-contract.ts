import { z } from 'zod';
import { oneCWorkOrderExportSchema, oneCRequestAttemptSchema } from './integration-contracts.js';

const DATABASE_BIGINT_MAX = 9_223_372_036_854_775_807n;
const externalIdSchema = z.string().trim().min(1).max(128);
const tiynStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(19)
  .refine((value) => BigInt(value) <= DATABASE_BIGINT_MAX);

export const ONE_C_WRITE_CONTRACT_VERSION = '1.0' as const;
export const ONE_C_WRITE_PATHS = Object.freeze({
  workOrders: 'work-orders',
  invoices: 'invoices',
});

export const oneCIdempotencyKeySchema = z.string().regex(/^outbox:[0-9a-z-]{1,128}$/i);

const wireItemSchema = oneCWorkOrderExportSchema.shape.items.element
  .omit({ externalId: true, priceTiyn: true })
  .extend({ externalId: externalIdSchema, priceTiyn: tiynStringSchema })
  .strict();

const wireWorkOrderSchema = oneCWorkOrderExportSchema
  .omit({ items: true, totalTiyn: true })
  .extend({
    items: z.array(wireItemSchema),
    totalTiyn: tiynStringSchema,
  })
  .strict();

export const oneCWorkOrderUpsertRequestSchema = z
  .object({
    contractVersion: z.literal(ONE_C_WRITE_CONTRACT_VERSION),
    workOrder: wireWorkOrderSchema,
  })
  .strict();

export const oneCWorkOrderUpsertResponseSchema = z
  .object({
    contractVersion: z.literal(ONE_C_WRITE_CONTRACT_VERSION),
    externalId: externalIdSchema,
    version: z.number().int().nonnegative(),
    result: z.enum(['created', 'updated', 'replayed']),
  })
  .strict();

export const oneCInvoiceRequestSchema = z
  .object({
    contractVersion: z.literal(ONE_C_WRITE_CONTRACT_VERSION),
    workOrderExternalId: externalIdSchema,
    amountTiyn: tiynStringSchema,
    requestAttempt: oneCRequestAttemptSchema,
  })
  .strict();

export const oneCInvoiceAcceptedSchema = z
  .object({
    contractVersion: z.literal(ONE_C_WRITE_CONTRACT_VERSION),
    requestId: externalIdSchema,
    status: z.enum(['accepted', 'replayed']),
  })
  .strict();

export const oneCWriteProblemSchema = z
  .object({
    contractVersion: z.literal(ONE_C_WRITE_CONTRACT_VERSION),
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    currentVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type OneCWorkOrderUpsertRequest = z.infer<typeof oneCWorkOrderUpsertRequestSchema>;
export type OneCWorkOrderUpsertResponse = z.infer<typeof oneCWorkOrderUpsertResponseSchema>;
export type OneCInvoiceRequest = z.infer<typeof oneCInvoiceRequestSchema>;
export type OneCInvoiceAccepted = z.infer<typeof oneCInvoiceAcceptedSchema>;
export type OneCWriteProblem = z.infer<typeof oneCWriteProblemSchema>;
