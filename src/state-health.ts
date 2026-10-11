import { lstat, mkdir, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentStorageHealth {
  readonly status: 'ok' | 'degraded';
  readonly stateBytes: string;
  readonly freeBytes: string;
  readonly maxStateBytes: string;
  readonly minFreeBytes: string;
  readonly queues: {
    readonly results: number;
    readonly odataTransfers: number;
    readonly smartPosPayments: number;
  };
}

export async function inspectAgentStorage(
  stateDirectory: string,
  limits: { readonly maxStateBytes: bigint; readonly minFreeBytes: bigint },
  queues: AgentStorageHealth['queues'],
): Promise<AgentStorageHealth> {
  await mkdir(stateDirectory, { recursive: true });
  const stateBytes = await directoryBytes(stateDirectory);
  const filesystem = await statfs(stateDirectory, { bigint: true });
  const freeBytes = filesystem.bavail * filesystem.bsize;
  return {
    status:
      stateBytes >= limits.maxStateBytes || freeBytes < limits.minFreeBytes ? 'degraded' : 'ok',
    stateBytes: stateBytes.toString(),
    freeBytes: freeBytes.toString(),
    maxStateBytes: limits.maxStateBytes.toString(),
    minFreeBytes: limits.minFreeBytes.toString(),
    queues,
  };
}

async function directoryBytes(directory: string): Promise<bigint> {
  let total = 0n;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directoryBytes(path);
    else if (entry.isFile()) total += BigInt((await lstat(path)).size);
  }
  return total;
}
