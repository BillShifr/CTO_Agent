import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { oneCAgentResultSchema, type OneCAgentResult } from './protocol/index.js';
import { readPrivateJson, writePrivateJson } from './private-json-file.js';

export class ResultSpool {
  private readonly file: string;
  constructor(private readonly directory: string) {
    this.file = join(directory, 'pending-results.json');
  }

  async read(): Promise<Record<string, OneCAgentResult>> {
    await mkdir(this.directory, { recursive: true });
    return (
      (await readPrivateJson(this.file, (value) =>
        Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([id, result]) => [
            id,
            oneCAgentResultSchema.parse(result),
          ]),
        ),
      )) ?? {}
    );
  }

  async write(value: Record<string, OneCAgentResult>): Promise<void> {
    await writePrivateJson(this.file, value);
  }
}
