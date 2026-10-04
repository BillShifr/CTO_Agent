import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const valid = {
  AVTOPULT_AGENT_ID: 'station-agent',
  AVTOPULT_API_URL: 'https://cloud.example/api/v1/',
  AVTOPULT_AGENT_SECRET: 's'.repeat(32),
  ONE_C_WRITE_URL: 'http://127.0.0.1/base/hs/avtopult/v1/',
  ONE_C_USERNAME: 'agent',
  ONE_C_PASSWORD: 'secret',
  ONE_C_ODATA_URL: 'http://127.0.0.1/base/odata/standard.odata/',
  ONE_C_ODATA_USERNAME: 'reader',
  ONE_C_ODATA_PASSWORD: 'reader-secret',
  ONE_C_ALLOW_HTTP: '1',
  AVTOPULT_AGENT_STATE_DIR: 'C:\\ProgramData\\AvtoPult',
};

describe('agent configuration', () => {
  it('requires explicit local opt-in for writes', () => {
    expect(readConfig(valid).allowWrites).toBe(false);
    expect(readConfig({ ...valid, ONE_C_ALLOW_WRITES: '0' }).allowWrites).toBe(false);
    expect(readConfig({ ...valid, ONE_C_ALLOW_WRITES: '1' }).allowWrites).toBe(true);
    expect(() => readConfig({ ...valid, ONE_C_ALLOW_WRITES: 'true' })).toThrow();
  });
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
});
