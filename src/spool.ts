import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { oneCAgentResultSchema, type OneCAgentResult } from './protocol/index.js';

export class ResultSpool {
  private readonly file: string;
  constructor(private readonly directory: string) {
    this.file = join(directory, 'pending-results.json');
  }

  async read(): Promise<Record<string, OneCAgentResult>> {
    await mkdir(this.directory, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(value).map(([id, result]) => [id, oneCAgentResultSchema.parse(result)]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async write(value: Record<string, OneCAgentResult>): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    });
    await rename(temporary, this.file);
  }
}
