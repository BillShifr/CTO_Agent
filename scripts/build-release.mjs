import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  'README.md',
  'INSTALL.md',
  'configure-environment.ps1',
  'install-service.ps1',
  'uninstall-service.ps1',
]) {
  await cp(resolve(agentDirectory, name), resolve(releaseDirectory, name));
}

const releaseFiles = [
  'agent.mjs',
  'agent.mjs.map',
  'README.md',
  'INSTALL.md',
  'configure-environment.ps1',
  'install-service.ps1',
  'uninstall-service.ps1',
];
const checksums = [];
for (const name of releaseFiles) {
  const bytes = await readFile(resolve(releaseDirectory, name));
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(resolve(releaseDirectory, 'SHA256SUMS'), `${checksums.join('\n')}\n`, 'utf8');

console.log(`1C agent release created at ${releaseDirectory}`);
