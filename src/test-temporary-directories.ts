import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class TestTemporaryDirectories {
  private readonly paths: string[] = [];

  async create(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    this.paths.push(directory);
    return directory;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
    );
  }
}
