import { afterEach, expect, it, vi } from 'vitest';
import { configureMappings } from './mappings.js';
import { readConfig } from './config.js';
import { validAgentEnvironment } from './test-environment.js';

afterEach(() => vi.unstubAllGlobals());
const config = readConfig(validAgentEnvironment());
const state = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  revision: 'a'.repeat(64),
  mappings: null,
  targets: [],
  nativeProfiles: 'configure_and_verify_in_1c',
};
const id = state.connectionId;
const update = {
  expectedRevision: state.revision,
  mappings: {
    organizationExternalId: id,
    productRetailPriceTypeId: id,
    serviceRetailPriceTypeId: id,
    purchasePriceTypeId: id,
    defaultServiceNormHours: 0.5,
    warehouses: [{ warehouseId: id, externalId: id }],
  },
};

it('writes validated mappings and verifies the saved revision with a separate read', async () => {
  const saved = { ...state, mappings: update.mappings, revision: 'b'.repeat(64) };
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(saved)));
  vi.stubGlobal('fetch', fetch);
  expect(await configureMappings(config, update)).toEqual(saved);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify(update) });
  expect(fetch.mock.calls[1]?.[1].method).toBeUndefined();
});

it('does not send malformed input or retry a conflicting update', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('private detail', { status: 409 }));
  vi.stubGlobal('fetch', fetch);
  await expect(configureMappings(config, { ...update, companyId: id })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(configureMappings(config, update)).rejects.toThrow(
    'Mapping update failed: HTTP 409',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects a concurrent change during readback', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(state)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...state, revision: 'b'.repeat(64) })));
  vi.stubGlobal('fetch', fetch);
  await expect(configureMappings(config, update)).rejects.toThrow(
    'Mappings changed during verification',
  );
});

it('reads mappings using only enrolled agent credentials and does not disclose failed response bodies', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(state)));
  vi.stubGlobal('fetch', fetch);
  expect(await configureMappings(config)).toEqual(state);
  expect(fetch.mock.calls[0]?.[0].toString()).toBe(`${config.cloudUrl}mappings`);
  expect(fetch.mock.calls[0]?.[1].headers['x-onec-secret']).toBe(config.secret);
  fetch.mockResolvedValue(new Response('sensitive error', { status: 401 }));
  await expect(configureMappings(config)).rejects.toThrow('HTTP 401');
});
