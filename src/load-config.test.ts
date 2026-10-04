import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load-config.js';

describe('service configuration', () => {
  it('redacts invalid environment values too', async () => {
    await expect(loadConfig({ AVTOPULT_API_URL: 'private-invalid-secret' })).rejects.toThrow(
      'Cannot load agent configuration; check file access and required settings',
    );
  });
  it('redacts invalid secret-bearing configuration rather than logging parser input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-config-'));
    try {
      const path = join(directory, 'config.json');
      await writeFile(path, '{"password":"sensitive-secret",broken');
      await expect(loadConfig({ AVTOPULT_AGENT_CONFIG_FILE: path })).rejects.toThrow(
        'Cannot load agent configuration; check file access and required settings',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
