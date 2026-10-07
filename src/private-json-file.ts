import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${file}.previous`;
  const backupTemporary = `${backup}.${process.pid}.${randomUUID()}.tmp`;
  const text = JSON.stringify(value);
  try {
    await writeSynced(temporary, text);
    await writeSynced(backupTemporary, text);
    await rm(backup, { force: true });
    await rename(file, backup).catch(ignoreMissing);
    await rename(temporary, file);
    await rm(backup, { force: true });
    await rename(backupTemporary, backup);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(backupTemporary, { force: true });
    throw error;
  }
}

export async function readPrivateJson<T>(
  file: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  let primaryFailure: unknown;
  try {
    return parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch (error) {
    if (!isMissing(error)) primaryFailure = error;
  }
  const backup = `${file}.previous`;
  try {
    const text = await readFile(backup, 'utf8');
    const recovered = parse(JSON.parse(text) as unknown);
    await replaceSynced(file, text);
    return recovered;
  } catch (backupFailure) {
    if (primaryFailure !== undefined) throw primaryFailure;
    if (isMissing(backupFailure)) return undefined;
    throw backupFailure;
  }
}

async function replaceSynced(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.recovery`;
  await writeSynced(temporary, text);
  try {
    await rm(file, { force: true });
    await rename(temporary, file);
    await syncDirectory(dirname(file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeSynced(file: string, text: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close();
  }
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) throw error;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
