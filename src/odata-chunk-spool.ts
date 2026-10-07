import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateJson, writePrivateJson } from './private-json-file.js';

const spoolSchema = z.record(z.uuid(), z.array(z.array(z.unknown())).max(128));
export type ODataChunks = Record<string, unknown[][]>;

export class ODataChunkSpool {
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, 'pending-odata-chunks.json');
  }

  async read(): Promise<ODataChunks> {
    await mkdir(this.directory, { recursive: true });
    return (await readPrivateJson(this.file, (value) => spoolSchema.parse(value))) ?? {};
  }

  async write(value: ODataChunks): Promise<void> {
    await writePrivateJson(this.file, value);
  }
}
