import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectAgentStorage } from './state-health.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe('agent storage health', () => {
  it('reports durable queue sizes and applies backpressure at the configured state limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-agent-storage-'));
    directories.push(directory);
    await writeFile(join(directory, 'pending-results.json'), 'x'.repeat(64));

    const health = await inspectAgentStorage(
      directory,
      { maxStateBytes: 64n, minFreeBytes: 1n },
      { results: 2, odataTransfers: 1, smartPosPayments: 3 },
    );

    expect(health).toMatchObject({
      status: 'degraded',
      stateBytes: '64',
      maxStateBytes: '64',
      queues: { results: 2, odataTransfers: 1, smartPosPayments: 3 },
    });
    expect(BigInt(health.freeBytes)).toBeGreaterThan(0n);
  });
});
