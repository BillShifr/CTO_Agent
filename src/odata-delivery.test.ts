import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OneCAgent } from './agent.js';
import type { AgentConfig } from './config.js';

it('persists an OData failure and replays it after a lost cloud response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avtopult-odata-'));
  let reads = 0;
  let claims = 0;
  let replies = 0;
  const received: unknown[] = [];
  const config = {
    agentId: 'agent',
    stateDir: directory,
    timeoutMs: 1000,
    secret: 's'.repeat(32),
    cloudUrl: new URL('https://cloud.example/agent/'),
    oneCODataUrl: new URL('http://127.0.0.1/base/odata/standard.odata/'),
    oneCODataUsername: 'reader',
    oneCODataPassword: 'secret',
  } as AgentConfig;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL, init: RequestInit) => {
      if (url.pathname.endsWith('/heartbeat')) return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/claim')) {
        claims++;
        return Response.json({
          retryAfterMs: 250,
          command:
            claims > 1
              ? null
              : {
                  id: 'a3f63973-d63f-4f07-8279-57300f22b409',
                  kind: 'odata.collection',
                  idempotencyKey: 'odata:1',
                  leaseToken: 'x'.repeat(32),
                  leaseUntil: new Date().toISOString(),
                  request: { relativePath: 'Catalog_Items' },
                },
        });
      }
      if (url.pathname.endsWith('/result')) {
        received.push(JSON.parse(typeof init.body === 'string' ? init.body : ''));
        if (++replies === 1) throw new Error('connection reset');
        return new Response(null, { status: 204 });
      }
      reads++;
      return new Response('private upstream body', { status: 404 });
    }),
  );
  try {
    await expect(new OneCAgent(config).runOnce()).rejects.toThrow('connection reset');
    const pending = await readFile(join(directory, 'pending-results.json'), 'utf8');
    expect(pending).toContain('ODATA_HTTP_404');
    expect(pending).not.toContain('private upstream body');
    await new OneCAgent(config).runOnce();
    expect(reads).toBe(1);
    expect(received[0]).toEqual(received[1]);
    expect(JSON.parse(await readFile(join(directory, 'pending-results.json'), 'utf8'))).toEqual({});
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
