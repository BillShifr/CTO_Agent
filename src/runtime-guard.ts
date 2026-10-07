import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const ownerSchema = z.object({ pid: z.number().int().positive(), token: z.uuid() }).strict();

export interface AgentRuntimeLock {
  release(): Promise<void>;
}

export async function acquireAgentRuntimeLock(stateDirectory: string): Promise<AgentRuntimeLock> {
  await mkdir(stateDirectory, { recursive: true });
  if ((await lstat(stateDirectory)).isSymbolicLink())
    throw new Error('agent state directory must not be a symbolic link or junction');
  const lockDirectory = join(stateDirectory, '.agent.lock');
  const token = randomUUID();
  await acquire(lockDirectory, token, 0);
  return {
    release: async () => {
      const owner = await readOwner(lockDirectory);
      if (owner?.token === token) await rm(lockDirectory, { recursive: true, force: true });
    },
  };
}

async function acquire(lockDirectory: string, token: string, attempt: number): Promise<void> {
  if (attempt >= 3) throw new Error('agent runtime lock could not be acquired');
  try {
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ pid: process.pid, token }),
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await rm(lockDirectory, { recursive: true, force: true });
      throw error;
    }
    await recoverExistingLock(lockDirectory, error);
    await acquire(lockDirectory, token, attempt + 1);
  }
}

async function recoverExistingLock(lockDirectory: string, acquisitionFailure: unknown) {
  const stat = await lstat(lockDirectory);
  if (stat.isSymbolicLink())
    throw new Error('agent runtime lock must not be a symbolic link', {
      cause: acquisitionFailure,
    });
  const owner = await readOwner(lockDirectory);
  if (owner === undefined && Date.now() - stat.mtimeMs < 60_000)
    throw new Error('another agent instance is initializing the state directory', {
      cause: acquisitionFailure,
    });
  if (owner !== undefined && processExists(owner.pid))
    throw new Error('another agent instance owns the state directory', {
      cause: acquisitionFailure,
    });
  const stale = `${lockDirectory}.stale.${randomUUID()}`;
  try {
    await rename(lockDirectory, stale);
    await rm(stale, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readOwner(lockDirectory: string): Promise<z.infer<typeof ownerSchema> | undefined> {
  try {
    return ownerSchema.parse(JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return undefined;
    if (error instanceof z.ZodError) return undefined;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
