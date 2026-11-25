import { lstat, statfs } from 'node:fs/promises';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';
import { oneCAgentDiagnosticsResponseSchema } from './protocol/one-c-agent-contract.js';
import { oneCLocalDiagnosticsResponseSchema } from './protocol/one-c-write-contract.js';

export interface DiagnosticCheck {
  readonly name:
    'configuration' | 'storage' | 'cloud' | 'one_c_write' | 'one_c_odata' | 'smart_pos';
  readonly status: 'ok' | 'disabled' | 'failed';
  readonly detail: string;
}

export async function runAgentDiagnostics(
  config: AgentConfig,
  options: { readonly network: boolean } = { network: true },
): Promise<readonly DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [ok('configuration', 'configuration is valid')];
  checks.push(await storageCheck(config));
  if (!options.network) return checks;
  checks.push(await cloudCheck(config));
  checks.push(
    await httpCheck(config, 'one_c_write', new URL('diagnostics', config.oneCUrl), {
      headers: {
        authorization: basic(config.oneCUsername, config.oneCPassword),
        accept: 'application/json',
        'x-avtopult-contract-version': '1.0',
      },
    }),
  );
  checks.push(
    await httpCheck(config, 'one_c_odata', new URL('$metadata', config.oneCODataUrl), {
      headers: {
        authorization: basic(config.oneCODataUsername, config.oneCODataPassword),
        accept: 'application/xml',
      },
    }),
  );
  checks.push(
    config.smartPos === undefined
      ? { name: 'smart_pos', status: 'disabled', detail: 'Smart POS is not configured' }
      : await smartPosCheck(config),
  );
  return checks;
}

async function cloudCheck(config: AgentConfig): Promise<DiagnosticCheck> {
  try {
    const response = await boundedFetch(config, new URL('diagnostics', config.cloudUrl), {
      method: 'GET',
      headers: {
        'x-onec-agent-id': config.agentId,
        'x-onec-secret': config.secret,
        accept: 'application/json',
      },
    });
    if (!response.ok) return failed('cloud', `HTTP ${String(response.status)}`);
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      return failed('cloud', 'invalid response content type');
    const parsed = oneCAgentDiagnosticsResponseSchema.safeParse(await json(response));
    if (!parsed.success) return failed('cloud', 'invalid diagnostics response');
    return ok('cloud', `HTTP ${String(response.status)}; agent credential accepted`);
  } catch {
    return failed('cloud', 'connection failed');
  }
}

async function smartPosCheck(config: AgentConfig): Promise<DiagnosticCheck> {
  if (config.smartPos === undefined)
    return { name: 'smart_pos', status: 'disabled', detail: 'Smart POS is not configured' };
  const url = new URL('/v2/status', config.smartPos.url);
  url.searchParams.set('processId', 'avtopult-read-only-diagnostic');
  return await httpCheck(config, 'smart_pos', url, {
    headers: { accesstoken: config.smartPos.token, accept: 'application/json' },
  });
}

export function diagnosticsSucceeded(checks: readonly DiagnosticCheck[]): boolean {
  return checks.every((check) => check.status !== 'failed');
}

async function storageCheck(config: AgentConfig): Promise<DiagnosticCheck> {
  try {
    const state = await lstat(config.stateDir);
    if (!state.isDirectory() || state.isSymbolicLink())
      return failed('storage', 'state path is not a real directory');
    const filesystem = await statfs(config.stateDir, { bigint: true });
    const free = filesystem.bavail * filesystem.bsize;
    if (free < config.minFreeBytes)
      return failed('storage', `free bytes ${free.toString()} are below configured minimum`);
    return ok('storage', `free bytes: ${free.toString()}`);
  } catch {
    return failed('storage', 'state directory is unavailable');
  }
}

async function httpCheck(
  config: AgentConfig,
  name: Extract<DiagnosticCheck['name'], 'cloud' | 'one_c_write' | 'one_c_odata' | 'smart_pos'>,
  url: URL,
  init: RequestInit,
): Promise<DiagnosticCheck> {
  try {
    const response = await boundedFetch(config, url, { method: 'GET', ...init });
    if (!response.ok) return failed(name, `HTTP ${String(response.status)}`);
    if (name === 'one_c_write') {
      if (response.headers.get('x-avtopult-contract-version') !== '1.0')
        return failed(name, 'contract version response is missing or unsupported');
      const parsed = oneCLocalDiagnosticsResponseSchema.safeParse(await json(response));
      if (!parsed.success) return failed(name, 'diagnostics response is invalid');
      if (parsed.data.status !== 'ready') return failed(name, '1C extension is degraded');
    }
    return ok(name, `HTTP ${String(response.status)}`);
  } catch {
    return failed(name, 'connection failed');
  }
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function ok(name: DiagnosticCheck['name'], detail: string): DiagnosticCheck {
  return { name, status: 'ok', detail };
}

function failed(name: DiagnosticCheck['name'], detail: string): DiagnosticCheck {
  return { name, status: 'failed', detail };
}
