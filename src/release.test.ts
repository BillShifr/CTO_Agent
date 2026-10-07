import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const workspace = resolve(import.meta.dirname, '..');
const release = resolve(workspace, '.artifacts/one-c-agent');

describe('Windows release artifact', () => {
  it('builds a self-contained checksummed agent bundle', async () => {
    await execute(process.execPath, ['scripts/build-release.mjs'], { cwd: workspace });
    const checksumFile = await readFile(resolve(release, 'SHA256SUMS'), 'utf8');
    const entries = checksumFile.trim().split('\n');

    expect(entries.length).toBeGreaterThan(10);
    for (const entry of entries) {
      const match = /^(?<hash>[a-f\d]{64})[ ]{2}(?<name>[^\\]+)$/.exec(entry);
      expect(match?.groups).toBeDefined();
      expect(match!.groups!.name!.split('/')).not.toContain('..');
      const bytes = await readFile(resolve(release, match!.groups!.name!));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(match!.groups!.hash);
    }
    expect(entries.some((entry) => entry.endsWith('one-c-extension-source/MAXIM-HANDOFF.md'))).toBe(
      true,
    );
    expect(entries.some((entry) => entry.endsWith('one-c-write-api.md'))).toBe(true);
    await expect(
      execute(process.execPath, [resolve(release, 'agent.mjs')], {
        cwd: release,
        env: {
          ...process.env,
          AVTOPULT_AGENT_CONFIG_FILE: resolve(release, 'missing-config.json'),
        },
      }),
    ).rejects.toThrow('Cannot load agent configuration');
  });

  it('uses a verified service wrapper instead of registering node directly', async () => {
    const installer = await readFile(resolve(workspace, 'install-service.ps1'), 'utf8');

    expect(installer).toContain('Get-FileHash');
    expect(installer).toContain('& $wrapper install');
    expect(installer).not.toMatch(/sc\.exe\s+create/i);
    expect(installer).toContain('AVTOPULT_AGENT_CONFIG_FILE');
    expect(installer).not.toContain("GetEnvironmentVariable($_, 'Machine')");
    const configurator = await readFile(resolve(workspace, 'configure-environment.ps1'), 'utf8');
    expect(configurator).toContain('SetAccessRuleProtection($true, $false)');
    expect(configurator).toContain("'agent-config.json'");
    expect(configurator).not.toContain(
      "SetEnvironmentVariable($entry.Key, $entry.Value, 'Machine')",
    );
  });
});
