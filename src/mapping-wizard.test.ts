import { afterEach, expect, it, vi } from 'vitest';
import { runMappingWizard } from './mapping-wizard.js';
import { readMappingCatalog } from './mapping-catalogs.js';
import { readConfig } from './config.js';
import { validAgentEnvironment } from './test-environment.js';

const config = readConfig(validAgentEnvironment());
const id = '11111111-1111-4111-8111-111111111111';
const state = {
  connectionId: id,
  revision: 'a'.repeat(64),
  mappings: null,
  targets: [{ warehouseId: id, warehouseName: 'Склад СТО', stationId: id, stationName: 'СТО' }],
  nativeProfiles: 'configure_and_verify_in_1c',
};
afterEach(() => vi.unstubAllGlobals());

function server() {
  let saved: unknown = state;
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith('/mappings')) {
      if (init?.method === 'PUT')
        saved = { ...state, mappings: JSON.parse(String(init.body)).mappings };
      return new Response(JSON.stringify(saved));
    }
    return new Response(
      JSON.stringify({ value: [{ Ref_Key: id, Description: 'Реальная запись' }] }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('selects dictionary names and writes only after confirmation, then verifies readback', async () => {
  const fetch = server();
  const answers = ['1', '1', '1', '1', '1', '0,5', 'ДА'];
  const ask = vi.fn(async () => {
    expect(fetch.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
    return answers.shift() ?? '';
  });
  expect(await runMappingWizard(config, { ask, write: vi.fn() })).toBe(true);
  const writes = fetch.mock.calls.filter((call) => call[1]?.method === 'PUT');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({
    expectedRevision: state.revision,
    mappings: {
      organizationExternalId: id,
      defaultServiceNormHours: 0.5,
      warehouses: [{ warehouseId: id, externalId: id }],
    },
  });
  const localCalls = fetch.mock.calls.filter((call) => !call[0].pathname.endsWith('/mappings'));
  expect(localCalls).toHaveLength(3);
  expect(localCalls[0]?.[1]?.headers).not.toHaveProperty('x-onec-secret');
});

it.each(['', 'нет'])('cancels confirmation without a write: %s', async (confirmation) => {
  const fetch = server();
  const answers = ['1', '1', '1', '1', '1', '1', confirmation];
  expect(
    await runMappingWizard(config, { ask: async () => answers.shift() ?? '', write: vi.fn() }),
  ).toBe(false);
  expect(fetch.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false);
});

it('invalid selection never writes', async () => {
  const fetch = server();
  await expect(
    runMappingWizard(config, { ask: async () => '999', write: vi.fn() }),
  ).rejects.toThrow('Неверный номер');
  expect(fetch.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false);
});

it('rejects empty or malformed dictionaries before asking anything', async () => {
  const fetch = server();
  fetch.mockImplementation(async () => new Response(JSON.stringify({ value: [] })));
  await expect(readMappingCatalog(config, 'Склады')).rejects.toThrow('Empty catalog');
  await expect(readMappingCatalog(config, '../secret')).rejects.toThrow('Unsupported');
});
