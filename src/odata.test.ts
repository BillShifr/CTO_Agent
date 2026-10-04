import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from './config.js';
import { readODataOutcome } from './odata.js';

const config = {
  oneCODataUrl: new URL('http://127.0.0.1/base/odata/standard.odata/'),
  oneCODataUsername: 'reader',
  oneCODataPassword: 'secret',
  timeoutMs: 1000,
} as AgentConfig;
afterEach(() => vi.unstubAllGlobals());

describe('OData collection boundaries', () => {
  it('collects multiple pages without changing the configured credentials', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ value: [{ id: 1 }], 'odata.nextLink': 'Catalog_Items?$skip=1' }),
      )
      .mockResolvedValueOnce(Response.json({ value: [{ id: 2 }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await readODataOutcome(config, { relativePath: 'Catalog_Items' })).toEqual({
      status: 'succeeded',
      response: [{ id: 1 }, { id: 2 }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops an oversized collection before fetching its next page', async () => {
    const fetch = vi.fn().mockImplementation(() =>
      Response.json({
        value: ['x'.repeat(5_000_000)],
        'odata.nextLink': 'Catalog_Items?$skip=1',
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await readODataOutcome(config, { relativePath: 'Catalog_Items' })).toMatchObject({
      status: 'failed',
      problem: { code: 'ODATA_COLLECTION_TOO_LARGE', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('OData command outcomes', () => {
  it.each([
    [401, false],
    [403, false],
    [404, false],
    [408, true],
    [429, true],
    [503, true],
  ])(
    'classifies HTTP %i retryability as %s without disclosing response data',
    async (status, retryable) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response('private customer data', { status: Number(status) })),
      );
      const outcome = await readODataOutcome(config, { relativePath: 'Catalog_Items' });
      expect(outcome).toMatchObject({
        status: 'failed',
        problem: { code: `ODATA_HTTP_${status}`, retryable },
      });
      expect(JSON.stringify(outcome)).not.toContain('private customer data');
    },
  );

  it('reports transient connection failures as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private connection detail')));
    expect(await readODataOutcome(config, { relativePath: 'Catalog_Items' })).toMatchObject({
      status: 'failed',
      problem: { retryable: true, code: 'ODATA_TRANSPORT_ERROR' },
    });
  });

  it('does not retry malformed collections forever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ unexpected: 'secret' })));
    expect(await readODataOutcome(config, { relativePath: 'Catalog_Items' })).toMatchObject({
      status: 'failed',
      problem: { retryable: false },
    });
  });

  it('rejects pagination escaping the configured publication', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ value: [], 'odata.nextLink': 'https://outside.example' }));
    vi.stubGlobal('fetch', fetch);
    expect(await readODataOutcome(config, { relativePath: 'Catalog_Items' })).toMatchObject({
      status: 'failed',
      problem: { retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
