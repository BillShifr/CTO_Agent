import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPrivateJson, writePrivateJson } from './private-json-file.js';
import { TestTemporaryDirectories } from './test-temporary-directories.js';

const directories = new TestTemporaryDirectories();

afterEach(async () => await directories.cleanup());

async function fixture(): Promise<string> {
  const directory = await directories.create('avtopult-private-json-');
  return join(directory, 'state.json');
}

const parse = (value: unknown) => {
  if (typeof value !== 'object' || value === null || !('sequence' in value))
    throw new Error('invalid state');
  const sequence = (value as { sequence?: unknown }).sequence;
  if (typeof sequence !== 'number') throw new Error('invalid sequence');
  return { sequence };
};

describe('private JSON persistence', () => {
  it('keeps a synced current copy and a same-generation recovery copy', async () => {
    const file = await fixture();
    await writePrivateJson(file, { sequence: 1 });
    await writePrivateJson(file, { sequence: 2 });

    await expect(readPrivateJson(file, parse)).resolves.toEqual({ sequence: 2 });
    expect(JSON.parse(await readFile(`${file}.previous`, 'utf8'))).toEqual({ sequence: 2 });
  });

  it('restores the latest valid recovery copy when the primary is missing', async () => {
    const file = await fixture();
    await writePrivateJson(file, { sequence: 3 });
    await rm(file);

    await expect(readPrivateJson(file, parse)).resolves.toEqual({ sequence: 3 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sequence: 3 });
  });

  it('restores the latest valid recovery copy when the primary is truncated', async () => {
    const file = await fixture();
    await writePrivateJson(file, { sequence: 4 });
    await writeFile(file, '{', 'utf8');

    await expect(readPrivateJson(file, parse)).resolves.toEqual({ sequence: 4 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sequence: 4 });
  });

  it('does not hide corruption when both copies are invalid', async () => {
    const file = await fixture();
    await writePrivateJson(file, { sequence: 5 });
    await writeFile(file, '{', 'utf8');
    await writeFile(`${file}.previous`, '[]', 'utf8');

    await expect(readPrivateJson(file, parse)).rejects.toBeInstanceOf(SyntaxError);
  });
});
