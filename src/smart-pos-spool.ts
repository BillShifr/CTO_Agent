import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json-file.js';

const pendingSchema = z
  .record(
    z.string().min(1).max(128),
    z
      .object({
        processId: z.string().min(1).max(128),
        amountTiyn: z
          .string()
          .regex(/^[1-9]\d*$/)
          .max(19),
        // Existing spools were created when Smart POS was used only for Kaspi QR. Keeping that
        // default makes an in-flight pre-upgrade payment safe to resume after the deployment.
        method: z.enum(['kaspi_qr', 'card_terminal']).default('kaspi_qr'),
        createdAt: z.iso.datetime(),
        lastActualizeAt: z.iso.datetime().optional(),
        settlement: z
          .discriminatedUnion('status', [
            z
              .object({
                status: z.literal('paid'),
                paidAt: z.iso.datetime(),
                actualMethod: z.enum(['kaspi_qr', 'card_terminal']),
                transactionId: z.string().min(1).max(128),
                terminalId: z.string().min(1).max(128).optional(),
                cardMask: z
                  .string()
                  .regex(/^\d{4}$/)
                  .optional(),
                rrn: z.string().min(1).max(128).optional(),
              })
              .strict(),
            z.object({ status: z.enum(['failed', 'expired']) }).strict(),
          ])
          .optional(),
      })
      .strict(),
  )
  .transform((entries) => entries);

export type SmartPosPending = z.infer<typeof pendingSchema>;

export class SmartPosSpool {
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, 'pending-smart-pos.json');
  }

  async read(): Promise<SmartPosPending> {
    await mkdir(this.directory, { recursive: true });
    return (await readPrivateJson(this.file, (value) => pendingSchema.parse(value))) ?? {};
  }

  async write(value: SmartPosPending): Promise<void> {
    await writePrivateJson(this.file, value);
  }
}
