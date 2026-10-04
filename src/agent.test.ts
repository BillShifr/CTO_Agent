import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneCAgent } from './agent.js';
import { readConfig } from './config.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe('1C agent delivery', () => {
  it.each(['normal', 'lost-response', 'reclaimed'])(
    'spools and recovers delivery without executing 1C again: %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-agent-'));
      directories.push(directory);
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      let claims = 0;
      let acknowledgements = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          observed.push({ url, init });
          if (url.endsWith('/heartbeat')) return new Response(null, { status: 204 });
          if (url.endsWith('/commands/claim')) {
            claims++;
            if (claims > 1 && mode !== 'reclaimed')
              return Response.json({ command: null, retryAfterMs: 2000 });
            return Response.json({
              retryAfterMs: 250,
              command: {
                id: 'a3f63973-d63f-4f07-8279-57300f22b409',
                kind: 'invoice.request',
                idempotencyKey: 'outbox:message-1',
                leaseToken: (claims === 1 ? 'x' : 'y').repeat(32),
                leaseUntil: '2026-10-03T05:00:00.000Z',
                request: {
                  contractVersion: '1.0',
                  workOrderExternalId: 'wo-1',
                  amountTiyn: '50000',
                  requestAttempt: 1,
                },
              },
            });
          }
          if (url.endsWith('/hs/avtopult/v1/invoices'))
            return Response.json({
              contractVersion: '1.0',
              requestId: 'invoice-request-1',
              status: 'accepted',
            });
          if (url.endsWith('/result')) {
            acknowledgements++;
            return acknowledgement(mode, acknowledgements);
          }
          throw new Error(`unexpected URL ${url}`);
        }),
      );

      const agent = new OneCAgent(
        readConfig({
          AVTOPULT_AGENT_ID: 'station-1',
          AVTOPULT_API_URL: 'https://cloud.example/api/v1/',
          AVTOPULT_AGENT_SECRET: 's'.repeat(32),
          ONE_C_WRITE_URL: 'http://127.0.0.1/base/hs/avtopult/v1/',
          ONE_C_USERNAME: 'writer',
          ONE_C_PASSWORD: 'write-secret',
          ONE_C_ODATA_URL: 'http://127.0.0.1/base/odata/standard.odata/',
          ONE_C_ODATA_USERNAME: 'reader',
          ONE_C_ODATA_PASSWORD: 'read-secret',
          ONE_C_ALLOW_HTTP: '1',
          ONE_C_ALLOW_WRITES: '1',
          AVTOPULT_AGENT_STATE_DIR: directory,
        }),
      );
      if (mode === 'lost-response') await expect(agent.runOnce()).rejects.toThrow();
      else await agent.runOnce();
      if (mode !== 'normal') await agent.runOnce();

      const local = observed.find((entry) => entry.url.endsWith('/invoices'));
      expect(new Headers(local?.init?.headers).get('idempotency-key')).toBe('outbox:message-1');
      expect(observed.filter((entry) => entry.url.endsWith('/invoices'))).toHaveLength(1);
      expect(acknowledgements).toBe(mode === 'normal' ? 1 : mode === 'lost-response' ? 2 : 3);
      expect(JSON.parse(await readFile(join(directory, 'pending-results.json'), 'utf8'))).toEqual(
        {},
      );
    },
  );
});

function acknowledgement(mode: string, count: number): Response {
  if (mode === 'lost-response' && count === 1) throw new Error('connection reset');
  if (mode === 'reclaimed' && count <= 2) return new Response(null, { status: 409 });
  return new Response(null, { status: 204 });
}
