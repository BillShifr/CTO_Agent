import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';
import { validAgentEnvironment } from './test-environment.js';

const valid = validAgentEnvironment();

describe('agent configuration', () => {
  it.each([
    'ftp://127.0.0.1/base/hs/avtopult/v1/',
    'http://user:password@127.0.0.1/base/hs/avtopult/v1/',
    'http://127.0.0.1/base/hs/avtopult/v1/?secret=value',
    'http://127.0.0.1/base/hs/avtopult/v1/#fragment',
  ])('rejects ambiguous or unsupported endpoints: %s', (url) => {
    expect(() => readConfig({ ...valid, ONE_C_WRITE_URL: url })).toThrow();
  });

  it('allows HTTP only for the explicitly local 1C hop', () => {
    expect(readConfig(valid).oneCUrl.origin).toBe('http://127.0.0.1');
    expect(() => readConfig({ ...valid, ONE_C_ALLOW_HTTP: '0' })).toThrow('explicit');
  });

  it('always requires HTTPS for AvtoPult Cloud', () => {
    expect(() =>
      readConfig({ ...valid, AVTOPULT_API_URL: 'http://cloud.example/api/v1/' }),
    ).toThrow();
  });

  it('keeps 1C writes disabled until the local administrator explicitly enables them', () => {
    const { ONE_C_ALLOW_WRITES: _allowWrites, ...withoutWriteFlag } = valid;
    expect(readConfig(withoutWriteFlag).allowWrites).toBe(false);
    expect(readConfig({ ...valid, ONE_C_ALLOW_WRITES: '1' }).allowWrites).toBe(true);
  });

  it('uses bounded storage defaults and rejects unsafe thresholds', () => {
    expect(readConfig(valid)).toMatchObject({
      maxStateBytes: 2_000_000_000n,
      minFreeBytes: 1_000_000_000n,
    });
    expect(() => readConfig({ ...valid, AVTOPULT_AGENT_MAX_STATE_BYTES: '99999999' })).toThrow();
  });

  it('builds the inbound 1C callback route from the Cloud API base', () => {
    expect(readConfig(valid).callbackUrl.href).toBe(
      'https://cloud.example/api/v1/integrations/one-c/callback',
    );
  });

  it('accepts Smart POS only as a complete local HTTPS configuration', () => {
    const config = readConfig({
      ...valid,
      KASPI_SMART_POS_URL: 'https://terminal-01.kaspipos.kz:8080/',
      KASPI_SMART_POS_NAME: 'AvtoPult-station-1',
      KASPI_SMART_POS_TOKEN: 'k'.repeat(16),
      KASPI_SMART_POS_REFRESH_TOKEN: 'r'.repeat(16),
      KASPI_CALLBACK_SECRET: 'c'.repeat(16),
    });
    expect(config.smartPos?.url.origin).toBe('https://terminal-01.kaspipos.kz:8080');
    expect(() =>
      readConfig({ ...valid, KASPI_SMART_POS_URL: 'https://192.168.1.50:8080/' }),
    ).toThrow('together');
    expect(() =>
      readConfig({
        ...valid,
        KASPI_SMART_POS_URL: 'http://terminal-01.kaspipos.kz:8080/',
        KASPI_SMART_POS_NAME: 'AvtoPult-station-1',
        KASPI_SMART_POS_TOKEN: 'k'.repeat(16),
        KASPI_SMART_POS_REFRESH_TOKEN: 'r'.repeat(16),
        KASPI_CALLBACK_SECRET: 'c'.repeat(16),
      }),
    ).toThrow('HTTPS');
    expect(() =>
      readConfig({
        ...valid,
        KASPI_SMART_POS_URL: 'https://192.168.1.50:8080/',
        KASPI_SMART_POS_NAME: 'AvtoPult-station-1',
        KASPI_SMART_POS_TOKEN: 'k'.repeat(16),
        KASPI_SMART_POS_REFRESH_TOKEN: 'r'.repeat(16),
        KASPI_CALLBACK_SECRET: 'c'.repeat(16),
      }),
    ).toThrow('certificate');
  });
});
