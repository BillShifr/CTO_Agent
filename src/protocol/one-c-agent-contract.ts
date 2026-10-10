import { z } from 'zod';
import {
  oneCInvoiceAcceptedSchema,
  oneCInvoiceRequestSchema,
  oneCWorkOrderUpsertRequestSchema,
  oneCWorkOrderUpsertResponseSchema,
  oneCWriteProblemSchema,
} from './one-c-write-contract.js';
import { oneCInboundSchema, oneCInvoiceDocumentUploadSchema } from './integration-contracts.js';

const commandIdSchema = z.uuid();
const leaseTokenSchema = z.string().min(32).max(256);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Stable JSON bytes for hashes that must survive PostgreSQL JSONB object-key reordering. */
export function canonicalAgentJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalJsonValue(value));
  if (encoded === undefined) throw new Error('value is not JSON-serializable');
  return encoded;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  return value;
}

export const oneCAgentODataChunkSchema = z
  .object({
    leaseToken: leaseTokenSchema,
    index: z.number().int().min(0).max(127),
    values: z.array(z.unknown()),
    sha256: sha256Schema,
  })
  .strict();

export const oneCAgentODataManifestSchema = z
  .object({
    transfer: z.literal('chunks'),
    chunkCount: z.number().int().min(1).max(128),
    itemCount: z.number().int().nonnegative(),
    sha256: sha256Schema,
  })
  .strict();

export const oneCPayrollExportRequestSchema = z
  .object({
    periodId: z.uuid(),
    dateFrom: z.iso.datetime(),
    dateTo: z.iso.datetime(),
    stationId: z.uuid().nullable(),
    lines: z.array(
      z
        .object({
          employeeId: z.uuid(),
          component: z.enum(['norm_hours', 'salary', 'percent', 'refund', 'manual_adjustment']),
          amountTiyn: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
          workOrderId: z.uuid().nullable(),
          workOrderItemId: z.uuid().nullable(),
          formula: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
  })
  .strict();

export const oneCPayrollExportResponseSchema = z
  .object({ externalId: z.string().trim().min(1).max(128) })
  .strict();

/**
 * The local 1C extension keeps inbound-to-cloud events in its own durable outbox. The Agent only
 * holds a lease while it relays an event; it acknowledges the item after Cloud has accepted it.
 * A crash or failed HTTPS request leaves the item in 1C to be leased and retried safely.
 */
export const oneCAgentInboundClaimResponseSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            leaseToken: leaseTokenSchema,
            event: oneCInboundSchema,
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const oneCAgentInboundAckSchema = z
  .object({
    leaseToken: leaseTokenSchema,
    workOrderVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const oneCAgentInboundReceiptSchema = z
  .object({
    accepted: z.literal(true),
    eventId: z.string().trim().min(1).max(256),
    workOrderVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const oneCAgentInvoiceDocumentClaimResponseSchema = z
  .object({
    documents: z
      .array(
        z
          .object({
            leaseToken: leaseTokenSchema,
            upload: oneCInvoiceDocumentUploadSchema,
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const oneCAgentCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: commandIdSchema,
      kind: z.literal('kaspi.smart-pos.start'),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: leaseTokenSchema,
      leaseUntil: z.iso.datetime(),
      request: z
        .object({
          externalId: z.string().trim().min(1).max(128),
          amountTiyn: z
            .string()
            .regex(/^[1-9]\d*$/)
            .max(19),
          // Smart POS shows QR, a physical card, Apple Pay and Google Pay from the same local
          // payment prompt. The method is retained so its terminal result can only complete the
          // matching cloud payment record.
          method: z.enum(['kaspi_qr', 'card_terminal']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: commandIdSchema,
      kind: z.literal('work-order.upsert'),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: leaseTokenSchema,
      leaseUntil: z.iso.datetime(),
      request: oneCWorkOrderUpsertRequestSchema,
    })
    .strict(),
  z
    .object({
      id: commandIdSchema,
      kind: z.literal('odata.collection'),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: leaseTokenSchema,
      leaseUntil: z.iso.datetime(),
      request: z
        .object({
          relativePath: z.string().trim().min(1).max(1_000),
          query: z.record(z.string().max(128), z.string().max(10_000)).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: commandIdSchema,
      kind: z.literal('invoice.request'),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: leaseTokenSchema,
      leaseUntil: z.iso.datetime(),
      request: oneCInvoiceRequestSchema,
    })
    .strict(),
  z
    .object({
      id: commandIdSchema,
      kind: z.literal('payroll.export'),
      idempotencyKey: z.string().min(1).max(256),
      leaseToken: leaseTokenSchema,
      leaseUntil: z.iso.datetime(),
      request: oneCPayrollExportRequestSchema,
    })
    .strict(),
]);

export const oneCAgentClaimResponseSchema = z
  .object({
    command: oneCAgentCommandSchema.nullable(),
    retryAfterMs: z.number().int().min(250).max(60_000),
  })
  .strict();

const createOneCAgentResultSchema = <TKind extends string, TResponse extends z.ZodType>(
  kind: TKind,
  response: TResponse,
) =>
  z
    .object({
      kind: z.literal(kind),
      leaseToken: leaseTokenSchema,
      outcome: z.discriminatedUnion('status', [
        z.object({ status: z.literal('succeeded'), response }).strict(),
        z.object({ status: z.literal('failed'), problem: oneCWriteProblemSchema }).strict(),
      ]),
    })
    .strict();

export const oneCAgentResultSchema = z.discriminatedUnion('kind', [
  createOneCAgentResultSchema(
    'kaspi.smart-pos.start',
    z.object({ processId: z.string().trim().min(1).max(128) }).strict(),
  ),
  createOneCAgentResultSchema('work-order.upsert', oneCWorkOrderUpsertResponseSchema),
  createOneCAgentResultSchema('invoice.request', oneCInvoiceAcceptedSchema),
  createOneCAgentResultSchema(
    'odata.collection',
    z.union([z.array(z.unknown()), oneCAgentODataManifestSchema]),
  ),
  createOneCAgentResultSchema('payroll.export', oneCPayrollExportResponseSchema),
]);

export const oneCAgentHeartbeatSchema = z
  .object({
    agentId: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64),
    startedAt: z.iso.datetime(),
    pendingResults: z.number().int().nonnegative(),
    components: z
      .object({
        smartPos: z.enum(['ok', 'disabled', 'degraded']),
        oneCEvents: z.enum(['ok', 'degraded']),
        oneCDocuments: z.enum(['ok', 'degraded']),
      })
      .strict(),
    failures: z.array(z.enum(['smart_pos', 'one_c_events', 'one_c_documents'])).max(3),
  })
  .strict();

export type OneCAgentCommand = z.infer<typeof oneCAgentCommandSchema>;
export type OneCAgentClaimResponse = z.infer<typeof oneCAgentClaimResponseSchema>;
export type OneCAgentResult = z.infer<typeof oneCAgentResultSchema>;
export type OneCAgentHeartbeat = z.infer<typeof oneCAgentHeartbeatSchema>;
export type OneCAgentODataChunk = z.infer<typeof oneCAgentODataChunkSchema>;
export type OneCAgentODataManifest = z.infer<typeof oneCAgentODataManifestSchema>;
export type OneCAgentInboundClaimResponse = z.infer<typeof oneCAgentInboundClaimResponseSchema>;
export type OneCAgentInvoiceDocumentClaimResponse = z.infer<
  typeof oneCAgentInvoiceDocumentClaimResponseSchema
>;
export type OneCPayrollExportRequest = z.infer<typeof oneCPayrollExportRequestSchema>;
export type OneCPayrollExportResponse = z.infer<typeof oneCPayrollExportResponseSchema>;
