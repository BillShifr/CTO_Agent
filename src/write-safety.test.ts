import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OneCAgent } from './agent.js';
import { readConfig } from './config.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['invoice.request', 'work-order.upsert', 'payroll.export'])(
  'blocks %s before contacting 1C by default',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-readonly-'));
    const results: unknown[] = [];
    const transport = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.endsWith('/events/claim'))
        return Response.json({ events: [] }, { headers: { 'x-avtopult-contract-version': '1.0' } });
      if (url.pathname.endsWith('/invoice-documents/claim'))
        return Response.json(
          { documents: [] },
          { headers: { 'x-avtopult-contract-version': '1.0' } },
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
          idempotencyKey:
            kind === 'payroll.export'
              ? 'payroll:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
              : 'outbox:test-1',
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
              : kind === 'work-order.upsert'
                ? {
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
                  }
                : {
                    periodId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    dateFrom: '2026-09-01T00:00:00.000Z',
                    dateTo: '2026-10-01T00:00:00.000Z',
                    stationId: null,
                    lines: [],
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
      expect(transport).toHaveBeenCalledTimes(5);
      expect(
        transport.mock.calls.some(([input]) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          return ['/invoices', '/work-orders', '/payroll-periods'].some((path) =>
            url.pathname.endsWith(path),
          );
        }),
      ).toBe(false);
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
