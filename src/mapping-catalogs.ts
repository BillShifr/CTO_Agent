import { z } from 'zod';
import type { AgentConfig } from './config.js';
import { readODataOutcome } from './odata.js';

const entry = z.object({
  Ref_Key: z
    .uuid()
    .toLowerCase()
    .refine((id) => id !== '00000000-0000-0000-0000-000000000000'),
  Description: z.string().trim().min(1).max(1000),
});
export type MappingEntry = z.infer<typeof entry>;

/** Explicit skip paging also supports publications that omit odata.nextLink. */
export async function readMappingCatalog(config: AgentConfig, name: string) {
  if (!['Организации', 'Склады', 'ВидыЦен'].includes(name))
    throw new Error('Unsupported mapping catalog');
  const rows: MappingEntry[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const result = await readODataOutcome(config, {
      relativePath: `Catalog_${name}`,
      query: {
        $select: 'Ref_Key,Description',
        $orderby: 'Ref_Key',
        $top: '200',
        $skip: String(rows.length),
        $format: 'json',
      },
    });
    if (result.outcome.status !== 'succeeded') throw new Error(`Cannot read catalog: ${name}`);
    const values = z.array(entry).max(200).parse(result.outcome.response);
    for (const value of values) {
      if (seen.has(value.Ref_Key)) throw new Error(`Catalog changed during reading: ${name}`);
      seen.add(value.Ref_Key);
      rows.push(value);
    }
    if (values.length < 200) {
      if (rows.length === 0) throw new Error(`Empty catalog: ${name}`);
      return rows;
    }
  }
  throw new Error(`Catalog page limit: ${name}`);
}
