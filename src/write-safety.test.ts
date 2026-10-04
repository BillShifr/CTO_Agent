import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OneCAgent } from './agent.js';
import { readConfig } from './config.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['invoice.request', 'work-order.upsert'])(
  'blocks %s before contacting 1C by default',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-readonly-'));
    const results: unknown[] = [];
    const transport = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      expect(url.hostname).toBe('cloud.example');
      if (url.pathname.endsWith('/heartbeat')) return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/result')) {
        results.push(JSON.parse(typeof init?.body === 'string' ? init.body : ''));
        return new Response(null, { status: 204 });
      }
      return Response.json({
        retryAfterMs: 250,
        command: {
          id: '11111111-1111-4111-8111-111111111111',
          kind,
          idempotencyKey: 'outbox:test-1',
          leaseToken: 'x'.repeat(32),
          leaseUntil: '2026-10-04T12:00:00.000Z',
          request:
            kind === 'invoice.request'
              ? {
                  contractVersion: '1.0',
                  workOrderExternalId: 'test-order',
                  amountTiyn: '100',
                  requestAttempt: 1,
                }
              : {
                  contractVersion: '1.0',
                  workOrder: {
                    workOrderId: 'test-order',
                    number: 'TEST',
                    version: 1,
                    stationExternalId: 'test-station',
                    client: { type: 'person', name: 'Test', phone: 'test' },
                    vehicle: { registrationNumber: 'TEST', brand: 'Test', model: 'Test' },
                    items: [],
                    totalTiyn: '0',
                    status: 'created',
                  },
                },
        },
      });
    });
    vi.stubGlobal('fetch', transport);
    try {
      const agent = new OneCAgent(
        readConfig({
          AVTOPULT_AGENT_ID: 'test',
          AVTOPULT_API_URL: 'https://cloud.example/api/v1/',
          AVTOPULT_AGENT_SECRET: 's'.repeat(32),
          ONE_C_WRITE_URL: 'https://one-c.example/base/hs/avtopult/v1/',
          ONE_C_USERNAME: 'writer',
          ONE_C_PASSWORD: 'test-secret',
          ONE_C_ODATA_URL: 'https://one-c.example/base/odata/standard.odata/',
          ONE_C_ODATA_USERNAME: 'reader',
          ONE_C_ODATA_PASSWORD: 'test-secret',
          AVTOPULT_AGENT_STATE_DIR: directory,
        }),
      );
      await agent.runOnce();
      expect(transport).toHaveBeenCalledTimes(3);
      expect(results).toEqual([
        expect.objectContaining({
          kind,
          outcome: {
            status: 'failed',
            problem: {
              contractVersion: '1.0',
              code: 'WRITES_DISABLED',
              message: 'Local administrator has not enabled writes to 1C',
              retryable: false,
            },
          },
        }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
