import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from './config.js';
import { diagnosticsSucceeded, runAgentDiagnostics } from './diagnostics.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('read-only diagnostics', () => {
  it('checks config and storage offline without making a request', async () => {
    const config = await testConfig();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const checks = await runAgentDiagnostics(config, { network: false });
    expect(diagnosticsSucceeded(checks)).toBe(true);
    expect(checks.map(({ name }) => name)).toEqual(['configuration', 'storage']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses only GET probes and reports an authentication failure without secrets', async () => {
    const config = await testConfig(true);
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void init;
      const url = input.toString();
      if (url.endsWith('/diagnostics')) return Response.json({ ok: true });
      return new Response('', { status: url.includes('$metadata') ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const checks = await runAgentDiagnostics(config);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const [, init] of fetch.mock.calls) expect(init?.method).toBe('GET');
    const cloudHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(cloudHeaders.get('x-onec-agent-id')).toBe('test-agent');
    expect(cloudHeaders.get('x-onec-secret')).toBe('a'.repeat(32));
    expect(diagnosticsSucceeded(checks)).toBe(false);
    expect(checks.find(({ name }) => name === 'one_c_odata')).toEqual({
      name: 'one_c_odata',
      status: 'failed',
      detail: 'HTTP 401',
    });
    expect(JSON.stringify(checks)).not.toContain(config.secret);
    expect(JSON.stringify(checks)).not.toContain(config.oneCPassword);
  });

  it('does not accept a generic HTML success page as cloud diagnostics', async () => {
    const config = await testConfig();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) =>
        input.toString().endsWith('/diagnostics')
          ? new Response('<html>proxy login</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            })
          : new Response('', { status: 200 }),
      ),
    );
    const checks = await runAgentDiagnostics(config);
    expect(checks.find(({ name }) => name === 'cloud')).toEqual({
      name: 'cloud',
      status: 'failed',
      detail: 'invalid response content type',
    });
  });
});

async function testConfig(smartPos = false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-diagnostics-'));
  directories.push(stateDir);
  return readConfig({
    AVTOPULT_AGENT_ID: 'test-agent',
    AVTOPULT_API_URL: 'https://cloud.example/api/v1/',
    AVTOPULT_AGENT_SECRET: 'a'.repeat(32),
    ONE_C_WRITE_URL: 'http://127.0.0.1/base/hs/avtopult/v1/',
    ONE_C_USERNAME: 'writer',
    ONE_C_PASSWORD: 'write-secret',
    ONE_C_ODATA_URL: 'http://127.0.0.1/base/odata/standard.odata/',
    ONE_C_ODATA_USERNAME: 'reader',
    ONE_C_ODATA_PASSWORD: 'read-secret',
    ONE_C_ALLOW_HTTP: '1',
    AVTOPULT_AGENT_STATE_DIR: stateDir,
    ...(smartPos
      ? {
          KASPI_SMART_POS_URL: 'https://terminal.kaspipos.kz:8080/',
          KASPI_SMART_POS_NAME: 'terminal',
          KASPI_SMART_POS_TOKEN: 't'.repeat(16),
          KASPI_SMART_POS_REFRESH_TOKEN: 'r'.repeat(16),
          KASPI_CALLBACK_SECRET: 'c'.repeat(16),
        }
      : {}),
  });
}
