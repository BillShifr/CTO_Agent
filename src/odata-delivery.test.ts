import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OneCAgent } from './agent.js';
import type { AgentConfig } from './config.js';

function agentConfig(directory: string, timeoutMs: number): AgentConfig {
  return {
    agentId: 'agent',
    stateDir: directory,
    timeoutMs,
    secret: 's'.repeat(32),
    cloudUrl: new URL('https://cloud.example/agent/'),
    callbackUrl: new URL('https://cloud.example/integrations/one-c/callback'),
    oneCUrl: new URL('http://127.0.0.1/base/hs/avtopult/v1/'),
    oneCUsername: 'writer',
    oneCPassword: 'writer-secret',
    oneCODataUrl: new URL('http://127.0.0.1/base/odata/standard.odata/'),
    oneCODataUsername: 'reader',
    oneCODataPassword: 'secret',
  } as AgentConfig;
}

function passiveAgentEndpoint(url: URL): Response | undefined {
  if (url.pathname.endsWith('/events/claim')) return Response.json({ events: [] });
  if (url.pathname.endsWith('/invoice-documents/claim')) return Response.json({ documents: [] });
  if (url.pathname.endsWith('/heartbeat')) return new Response(null, { status: 204 });
  return undefined;
}

function stubAgentFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      const passive = passiveAgentEndpoint(url);
      const response = passive ?? (await handler(url, init));
      if (url.origin === 'http://127.0.0.1' && url.pathname.includes('/hs/avtopult/v1/'))
        response.headers.set('x-avtopult-contract-version', '1.0');
      return response;
    }),
  );
}

it('persists an OData failure and replays it after a lost cloud response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avtopult-odata-'));
  let reads = 0;
  let claims = 0;
  let replies = 0;
  const received: unknown[] = [];
  const config = agentConfig(directory, 1000);
  stubAgentFetch(async (url, init) => {
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
      received.push(JSON.parse(String(init.body)));
      if (++replies === 1) throw new Error('connection reset');
      return new Response(null, { status: 204 });
    }
    reads++;
    return new Response('private upstream body', { status: 404 });
  });
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

it('uploads a large OData collection in bounded chunks before its manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avtopult-odata-chunks-'));
  const commandId = 'a3f63973-d63f-4f07-8279-57300f22b409';
  const uploaded: unknown[] = [];
  let finalResult: unknown;
  const config = agentConfig(directory, 5000);
  stubAgentFetch(async (url, init) => {
    if (url.pathname.endsWith('/claim'))
      return Response.json({
        retryAfterMs: 250,
        command: {
          id: commandId,
          kind: 'odata.collection',
          idempotencyKey: 'odata:large',
          leaseToken: 'x'.repeat(32),
          leaseUntil: new Date().toISOString(),
          request: { relativePath: 'Catalog_Items' },
        },
      });
    if (url.pathname.includes('/odata-chunks/')) {
      expect(Buffer.byteLength(String(init.body))).toBeLessThan(10_000_000);
      uploaded.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/result')) {
      finalResult = JSON.parse(String(init.body));
      return new Response(null, { status: 204 });
    }
    return Response.json({ value: ['x'.repeat(4_100_000), 'y'.repeat(4_100_000)] });
  });
  try {
    await new OneCAgent(config).runOnce();
    expect(uploaded).toHaveLength(2);
    expect(finalResult).toMatchObject({
      kind: 'odata.collection',
      outcome: {
        status: 'succeeded',
        response: { transfer: 'chunks', chunkCount: 2, itemCount: 2 },
      },
    });
    expect(JSON.parse(await readFile(join(directory, 'pending-results.json'), 'utf8'))).toEqual({});
    expect(
      JSON.parse(await readFile(join(directory, 'pending-odata-chunks.json'), 'utf8')),
    ).toEqual({});
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});
