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
    expect(entries.some((entry) => entry.endsWith('one-c-openapi.yaml'))).toBe(true);
    expect(entries.some((entry) => entry.endsWith('  INTEGRATION.md'))).toBe(true);
    expect(entries.some((entry) => entry.endsWith('RELEASE.json'))).toBe(true);
    const metadata = JSON.parse(await readFile(resolve(release, 'RELEASE.json'), 'utf8')) as {
      platform: string;
      winsw: { included: boolean; sha256: string };
    };
    expect(metadata.platform).toBe('windows-x64');
    expect(metadata.winsw.included).toBe(false);
    expect(metadata.winsw.sha256).toMatch(/^[a-f\d]{64}$/);
    for (const name of [
      'agent-maintenance.ps1',
      'setup-agent.ps1',
      'configure-mappings.ps1',
      'diagnose-agent.ps1',
      'rotate-secrets.ps1',
      'update-service.ps1',
      'PRODUCTION-AUTODEPLOY.md',
      'production-deployment.ps1',
      'setup-production-runner.ps1',
      'runner-job-started.ps1',
      'deploy-agent-release.ps1',
      'restore-agent-release.ps1',
      'diagnose-production.ps1',
      'production-runner-release.json',
    ])
      expect(entries.some((entry) => entry.endsWith(`  ${name}`))).toBe(true);
    for (const name of [
      'ORDER-METADATA.md',
      'INVOICE-METADATA.md',
      'P-13-INTEGRATION.md',
      'REVERSE-METADATA.md',
      'src/CommonModules/AvtoPultАдаптерКА2/Module.bsl',
      'src/CommonModules/AvtoPultЗаказы/Module.bsl',
      'src/CommonModules/AvtoPultИзмененияЗаказов/Module.bsl',
      'src/CommonModules/AvtoPultКонтракт/Module.bsl',
      'src/CommonModules/AvtoPultСамопроверка/Module.bsl',
      'src/CommonModules/AvtoPultСчета/Module.bsl',
    ]) {
      const relative = `one-c-extension-source/${name}`;
      expect(entries.some((entry) => entry.endsWith(`  ${relative}`))).toBe(true);
      expect(await readFile(resolve(release, relative), 'utf8')).toBe(
        await readFile(resolve(workspace, relative), 'utf8'),
      );
    }
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
    expect(installer).toContain('Use update-service.ps1 for a transactional update.');
    expect(installer).toContain('Set-AgentDirectoryAcl $AgentDirectory');
    expect(installer).toContain('SetAccessRuleProtection($true, $false)');
    expect(installer).toContain('Start-Sleep -Seconds 5');
    expect(installer).toContain("'heartbeat-receipt.json'");
    expect(installer).toContain('fresh accepted cloud heartbeat');
    expect(installer).not.toContain("GetEnvironmentVariable($_, 'Machine')");
    const configurator = await readFile(resolve(workspace, 'configure-environment.ps1'), 'utf8');
    expect(configurator).toContain('SetAccessRuleProtection($true, $false)');
    expect(configurator).toContain("'agent-config.json'");
    expect(configurator).toContain('Request-AgentEnrollmentCredential');
    expect(configurator).toContain('UseExistingAgentCredential');
    expect(configurator).not.toContain(
      "SetEnvironmentVariable($entry.Key, $entry.Value, 'Machine')",
    );
    expect(await readFile(resolve(workspace, 'update-service.ps1'), 'utf8')).toContain(
      'Invoke-AgentPayloadSwap',
    );
    expect(await readFile(resolve(workspace, 'rotate-secrets.ps1'), 'utf8')).toContain(
      'Invoke-AgentConfigSwap',
    );
    const maintenance = await readFile(resolve(workspace, 'agent-maintenance.ps1'), 'utf8');
    expect(maintenance).toContain("'integrations/one-c/agent/v1/enroll'");
    expect(maintenance).toContain("'Cache-Control'");
    expect(maintenance).toContain('no-store');
    const workflow = await readFile(resolve(workspace, '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('path: .artifacts/');
    expect(workflow).toContain('include-hidden-files: true');
  });

  it('deploys only a successful main artifact through the protected production runner', async () => {
    const workflow = await readFile(
      resolve(workspace, '.github/workflows/deploy-agent.yml'),
      'utf8',
    );
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain('$run.head_sha -ne $main.commit.sha');
    expect(workflow).toContain('runs-on: [avtopult-one-c-production]');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain(
      'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
    );
    expect(workflow).toContain('-ExpectedSha256 $Matches[1]');
    expect(workflow).toContain("Join-Path $toolStage 'deploy-agent-release.ps1'");
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('actions/checkout@');

    const setup = await readFile(resolve(workspace, 'setup-production-runner.ps1'), 'utf8');
    expect(setup).toContain("'--no-default-labels'");
    expect(setup).toContain("'--windowslogonaccount', 'NT AUTHORITY\\SYSTEM'");
    expect(setup).toContain('ACTIONS_RUNNER_HOOK_JOB_STARTED');
    const guard = await readFile(resolve(workspace, 'runner-job-started.ps1'), 'utf8');
    expect(guard).toContain("@('workflow_run', 'workflow_dispatch')");
    expect(guard).toContain('$actual.workflowRef -ne $policy.workflowRef');
    const updater = await readFile(resolve(workspace, 'update-service.ps1'), 'utf8');
    expect(updater).toContain('Wait-AgentAcceptedHeartbeat');
    expect(updater).toContain('[string]$ResultFile');

    const pinnedRunner = JSON.parse(
      await readFile(resolve(workspace, 'production-runner-release.json'), 'utf8'),
    ) as { version: string; asset: string; url: string; sha256: string };
    expect(pinnedRunner.asset).toBe(`actions-runner-win-x64-${pinnedRunner.version}.zip`);
    expect(pinnedRunner.url).toBe(
      `https://github.com/actions/runner/releases/download/v${pinnedRunner.version}/${pinnedRunner.asset}`,
    );
    expect(pinnedRunner.sha256).toMatch(/^[a-f\d]{64}$/);
  });

  it('ships the implemented local 1C HTTP API as an OpenAPI contract', async () => {
    const specification = await readFile(resolve(workspace, 'one-c-openapi.yaml'), 'utf8');
    expect(specification).toContain('openapi: 3.1.0');
    expect(specification).toContain('url: http://127.0.0.1/{publication}/hs/avtopult/v1');
    for (const path of [
      '/diagnostics:',
      '/work-orders:',
      '/invoices:',
      '/payroll-periods:',
      '/events/claim:',
      '/events/{eventId}/ack:',
      '/invoice-documents/claim:',
      '/invoice-documents/{eventId}/content:',
      '/invoice-documents/{eventId}/ack:',
    ]) {
      expect(specification).toContain(`  ${path}`);
    }
    expect(specification).toContain('scheme: basic');
    expect(specification).toContain('name: X-AvtoPult-Contract-Version');
    expect(specification).toContain('name: Idempotency-Key');
    expect(specification).toContain('maxLength: 135');
    expect(specification).toContain(
      "pattern: '^(outbox:[0-9A-Za-z-]{1,128}|payroll:[0-9A-Za-z-]{1,127})$'",
    );
  });
});
