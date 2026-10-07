import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireAgentRuntimeLock } from './runtime-guard.js';
import { TestTemporaryDirectories } from './test-temporary-directories.js';

const directories = new TestTemporaryDirectories();

afterEach(async () => await directories.cleanup());

async function fixture(): Promise<string> {
  return await directories.create('avtopult-runtime-guard-');
}

describe('agent runtime guard', () => {
  it('allows exactly one process to own a state directory', async () => {
    const directory = await fixture();
    const lock = await acquireAgentRuntimeLock(directory);
    await expect(acquireAgentRuntimeLock(directory)).rejects.toThrow(
      'another agent instance owns the state directory',
    );
    await lock.release();
    const replacement = await acquireAgentRuntimeLock(directory);
    await replacement.release();
  });

  it('recovers a lock whose recorded process no longer exists', async () => {
    const directory = await fixture();
    const lockDirectory = join(directory, '.agent.lock');
    await mkdir(lockDirectory);
    await writeFile(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    );

    const lock = await acquireAgentRuntimeLock(directory);
    await lock.release();
  });

  it('does not steal a newly created lock before its owner record is written', async () => {
    const directory = await fixture();
    await mkdir(join(directory, '.agent.lock'));

    await expect(acquireAgentRuntimeLock(directory)).rejects.toThrow(
      'another agent instance is initializing the state directory',
    );
  });

  it('rejects a state directory reached through a symbolic link', async () => {
    const parent = await fixture();
    const target = join(parent, 'target');
    const linked = join(parent, 'linked');
    await mkdir(target);
    await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(acquireAgentRuntimeLock(linked)).rejects.toThrow(
      'agent state directory must not be a symbolic link or junction',
    );
  });
});
