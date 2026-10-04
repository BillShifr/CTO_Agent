import { z } from 'zod';
const integrationIdSchema = z.string().trim().min(1).max(128);
export const oneCRequestAttemptSchema = z.number().int().positive();
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
