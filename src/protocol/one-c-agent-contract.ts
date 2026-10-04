import { z } from 'zod';
import {
  oneCInvoiceAcceptedSchema,
  oneCInvoiceRequestSchema,
  oneCWorkOrderUpsertRequestSchema,
  oneCWorkOrderUpsertResponseSchema,
  oneCWriteProblemSchema,
} from './one-c-write-contract.js';

const commandIdSchema = z.uuid();
const leaseTokenSchema = z.string().min(32).max(256);

export const oneCAgentCommandSchema = z.discriminatedUnion('kind', [
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
  createOneCAgentResultSchema('work-order.upsert', oneCWorkOrderUpsertResponseSchema),
  createOneCAgentResultSchema('invoice.request', oneCInvoiceAcceptedSchema),
  createOneCAgentResultSchema('odata.collection', z.array(z.unknown())),
]);

export const oneCAgentHeartbeatSchema = z
  .object({
    agentId: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64),
    startedAt: z.iso.datetime(),
    pendingResults: z.number().int().nonnegative(),
  })
  .strict();

export type OneCAgentCommand = z.infer<typeof oneCAgentCommandSchema>;
export type OneCAgentClaimResponse = z.infer<typeof oneCAgentClaimResponseSchema>;
export type OneCAgentResult = z.infer<typeof oneCAgentResultSchema>;
export type OneCAgentHeartbeat = z.infer<typeof oneCAgentHeartbeatSchema>;
