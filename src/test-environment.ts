export function validAgentEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
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
    ONE_C_ALLOW_WRITES: '1',
    AVTOPULT_AGENT_STATE_DIR: 'C:\\ProgramData\\AvtoPult',
    ...overrides,
  };
}
