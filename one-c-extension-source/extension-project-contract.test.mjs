import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import {
  requiredExtensionProjectPaths,
  verifyExtensionProject,
} from './extension-project-contract.mjs';

const manifest = JSON.parse(
  await readFile(new URL('./extension-project-manifest.json', import.meta.url), 'utf8'),
);

test('exported extension project must contain metadata and every executable module', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'avtopult-extension-'));
  try {
    await assert.rejects(
      verifyExtensionProject(directory),
      /Configuration\.xml[\s\S]*AvtoPultДиагностикаКА2/,
    );

    const paths = requiredExtensionProjectPaths(manifest);
    for (const relativePath of paths) {
      const path = resolve(directory, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'fixture', 'utf8');
    }

    const result = await verifyExtensionProject(directory);
    assert.equal(result.required.length, 40);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manifest covers every maintained common module and required metadata object', async () => {
  const sourceDirectories = (
    await readdir(new URL('./src/CommonModules/', import.meta.url), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    manifest.commonModules.map(({ sourceDirectory }) => sourceDirectory).sort(),
    sourceDirectories,
  );
  assert.deepEqual(manifest.httpServices, ['AvtoPult']);
  assert.equal(manifest.informationRegisters.length, 12);
  assert.deepEqual(manifest.eventSubscriptions, [
    'AvtoPultЗаказыПриЗаписи',
    'AvtoPultРасчетыПриЗаписи',
  ]);
  assert.deepEqual(manifest.roles, ['AvtoPultИнтеграция']);
});
