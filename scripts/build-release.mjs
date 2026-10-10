import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const agentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = agentDirectory;
const releaseDirectory = resolve(repositoryDirectory, '.artifacts/one-c-agent');

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });
await build({
  entryPoints: [resolve(agentDirectory, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(releaseDirectory, 'agent.mjs'),
  sourcemap: 'external',
  legalComments: 'none',
});

for (const name of [
  'agent-maintenance.ps1',
  'README.md',
  'INSTALL.md',
  'configure-environment.ps1',
  'diagnose-agent.ps1',
  'install-service.ps1',
  'rotate-secrets.ps1',
  'uninstall-service.ps1',
  'update-service.ps1',
]) {
  await cp(resolve(agentDirectory, name), resolve(releaseDirectory, name));
}
await cp(
  resolve(repositoryDirectory, 'one-c-extension-source'),
  resolve(releaseDirectory, 'one-c-extension-source'),
  { recursive: true },
);
await cp(
  resolve(repositoryDirectory, 'one-c-write-api.md'),
  resolve(releaseDirectory, 'one-c-write-api.md'),
);

const releaseFiles = await filesWithin(releaseDirectory);
const checksums = [];
for (const name of releaseFiles) {
  const bytes = await readFile(resolve(releaseDirectory, name));
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(resolve(releaseDirectory, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');

console.log(`1C agent release created at ${releaseDirectory}`);

async function filesWithin(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...(await filesWithin(directory, relative)));
    else if (entry.isFile() && relative !== 'SHA256SUMS') names.push(relative);
  }
  return names.sort();
}
