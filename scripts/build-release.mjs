import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

const runtimeArgument = process.argv.indexOf('--runtime');
const runtimeSource = runtimeArgument === -1 ? null : process.argv[runtimeArgument + 1];
if (runtimeArgument !== -1 && !runtimeSource) throw new Error('--runtime requires a directory');

const winswArgument = process.argv.indexOf('--winsw');
const winswSource = winswArgument === -1 ? null : process.argv[winswArgument + 1];
if (winswArgument !== -1 && !winswSource) throw new Error('--winsw requires a file path');
const winswSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';

const agentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = agentDirectory;
const releaseDirectory = resolve(repositoryDirectory, '.artifacts/one-c-agent');
const packageMetadata = JSON.parse(
  await readFile(resolve(repositoryDirectory, 'package.json'), 'utf8'),
);

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
  'INTEGRATION.md',
  'FIELD-INSTALL.md',
  'PRODUCTION-AUTODEPLOY.md',
  'RELEASE-READINESS.md',
  'setup-agent.ps1',
  'install-package.ps1',
  'configure-environment.ps1',
  'configure-mappings.ps1',
  'diagnose-agent.ps1',
  'install-service.ps1',
  'rotate-secrets.ps1',
  'uninstall-service.ps1',
  'update-service.ps1',
  'production-deployment.ps1',
  'setup-production-runner.ps1',
  'runner-job-started.ps1',
  'deploy-agent-release.ps1',
  'restore-agent-release.ps1',
  'diagnose-production.ps1',
  'production-runner-release.json',
]) {
  await cp(resolve(agentDirectory, name), resolve(releaseDirectory, name));
}
await cp(
  resolve(repositoryDirectory, 'one-c-extension-source'),
  resolve(releaseDirectory, 'one-c-extension-source'),
  { recursive: true },
);

if (winswSource) {
  const winswBytes = await readFile(resolve(winswSource));
  const actual = createHash('sha256').update(winswBytes).digest('hex');
  if (actual !== winswSha256) throw new Error('WinSW checksum mismatch');
  await writeFile(resolve(releaseDirectory, 'WinSW-x64.exe'), winswBytes);
}

if (runtimeSource) {
  const identity = execFileSync(
    resolve(runtimeSource, 'node.exe'),
    ['-p', "process.version + '/' + process.platform + '/' + process.arch"],
    { encoding: 'utf8' },
  ).trim();
  if (identity !== 'v22.20.0/win32/x64') throw new Error('Unexpected Windows runtime');
  await mkdir(resolve(releaseDirectory, 'runtime'));
  for (const name of ['node.exe', 'LICENSE']) {
    await cp(resolve(runtimeSource, name), resolve(releaseDirectory, 'runtime', name));
  }
}

await writeFile(
  resolve(releaseDirectory, 'RELEASE.json'),
  `${JSON.stringify(
    {
      package: '@avtopult/one-c-agent',
      version: packageMetadata.version,
      node: '22.20.x',
      runtime: { included: runtimeSource !== null, version: '22.20.0' },
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryDirectory,
        encoding: 'utf8',
      }).trim(),
      platform: 'windows-x64',
      winsw: { included: winswSource !== null, version: '2.12.0', sha256: winswSha256 },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
await cp(
  resolve(repositoryDirectory, 'one-c-write-api.md'),
  resolve(releaseDirectory, 'one-c-write-api.md'),
);
await cp(
  resolve(repositoryDirectory, 'one-c-openapi.yaml'),
  resolve(releaseDirectory, 'one-c-openapi.yaml'),
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
