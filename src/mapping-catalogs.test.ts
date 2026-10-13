import { afterEach, expect, it, vi } from 'vitest';
import { readMappingCatalog } from './mapping-catalogs.js';
import { readConfig } from './config.js';
import { validAgentEnvironment } from './test-environment.js';

const config = readConfig(validAgentEnvironment());
afterEach(() => vi.unstubAllGlobals());
const rows = Array.from({ length: 200 }, (_, index) => ({
  Ref_Key: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
  Description: `Warehouse ${index}`,
}));

it('reads subsequent pages when the publication omits nextLink', async () => {
  const fetch = vi.fn(
    async (url: URL) =>
      new Response(
        JSON.stringify({
          value: url.searchParams.get('$skip') === '0' ? rows : [],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  expect(await readMappingCatalog(config, 'Склады')).toEqual(rows);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[0].searchParams.get('$skip')).toBe('200');
});

it('rejects an ignored skip instead of looping or returning partial data', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ value: rows })));
  vi.stubGlobal('fetch', fetch);
  await expect(readMappingCatalog(config, 'Склады')).rejects.toThrow('Catalog changed');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not return a partial dictionary after a later request fails', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: rows })))
    .mockResolvedValueOnce(new Response('private details', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  await expect(readMappingCatalog(config, 'Склады')).rejects.toThrow('Cannot read catalog');
});
