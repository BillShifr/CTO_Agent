import { z } from 'zod';

const guid = z
  .uuid()
  .toLowerCase()
  .refine((value) => value !== '00000000-0000-0000-0000-000000000000');
const warehouse = z.object({ warehouseId: z.uuid().toLowerCase(), externalId: guid }).strict();

/** FR-INT-001: catalog configuration; native document profiles remain owned by 1C. */
export const oneCMappingsSchema = z
  .object({
    organizationExternalId: guid,
    productRetailPriceTypeId: guid,
    serviceRetailPriceTypeId: guid,
    purchasePriceTypeId: guid,
    defaultServiceNormHours: z.number().finite().min(0).max(1000),
    warehouses: z
      .array(warehouse)
      .min(1)
      .max(500)
      .refine(
        (items) =>
          new Set(items.map((item) => item.warehouseId)).size === items.length &&
          new Set(items.map((item) => item.externalId)).size === items.length,
        'Warehouse mappings must be unique',
      ),
  })
  .strict();

export const oneCMappingsUpdateSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    mappings: oneCMappingsSchema,
  })
  .strict();

export const oneCMappingsResponseSchema = z
  .object({
    connectionId: z.uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    mappings: oneCMappingsSchema.nullable(),
    targets: z.array(
      z
        .object({
          warehouseId: z.uuid(),
          warehouseName: z.string(),
          stationId: z.uuid(),
          stationName: z.string(),
        })
        .strict(),
    ),
    nativeProfiles: z.literal('configure_and_verify_in_1c'),
  })
  .strict();

export type OneCMappings = z.infer<typeof oneCMappingsSchema>;
export type OneCMappingsUpdate = z.infer<typeof oneCMappingsUpdateSchema>;
export type OneCMappingsResponse = z.infer<typeof oneCMappingsResponseSchema>;
