import { z } from 'zod';

const schema = z.object({
  AVTOPULT_AGENT_ID: z.string().trim().min(1).max(128),
  AVTOPULT_API_URL: z
    .url()
    .refine((value) => value.startsWith('https://'), 'cloud API must use HTTPS'),
  AVTOPULT_AGENT_SECRET: z.string().min(32),
  ONE_C_WRITE_URL: z.url(),
  ONE_C_USERNAME: z.string().trim().min(1),
  ONE_C_PASSWORD: z.string().min(1),
  ONE_C_ODATA_URL: z.url(),
  ONE_C_ODATA_USERNAME: z.string().trim().min(1),
  ONE_C_ODATA_PASSWORD: z.string().min(1),
  ONE_C_ALLOW_HTTP: z.enum(['0', '1']).default('0'),
  ONE_C_ALLOW_WRITES: z.enum(['0', '1']).default('0'),
  AVTOPULT_AGENT_STATE_DIR: z
    .string()
    .trim()
    .min(1)
    .default('C:\\ProgramData\\AvtoPult\\OneCAgent'),
  AVTOPULT_AGENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
});

export type AgentConfig = ReturnType<typeof readConfig>;

export function readConfig(input: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(input);
  const local = new URL(parsed.ONE_C_WRITE_URL);
  const odata = new URL(parsed.ONE_C_ODATA_URL);
  [local, odata, new URL(parsed.AVTOPULT_API_URL)].forEach(validateEndpoint);
  if (local.protocol !== 'https:' && parsed.ONE_C_ALLOW_HTTP !== '1')
    throw new Error('local 1C HTTP requires explicit ONE_C_ALLOW_HTTP=1');
  if (!local.pathname.endsWith('/hs/avtopult/v1/'))
    throw new Error('ONE_C_WRITE_URL must end with /hs/avtopult/v1/');
  if (!odata.pathname.endsWith('/odata/standard.odata/'))
    throw new Error('ONE_C_ODATA_URL must end with /odata/standard.odata/');
  if (odata.protocol !== 'https:' && parsed.ONE_C_ALLOW_HTTP !== '1')
    throw new Error('local 1C OData requires explicit ONE_C_ALLOW_HTTP=1');
  return {
    agentId: parsed.AVTOPULT_AGENT_ID,
    allowWrites: parsed.ONE_C_ALLOW_WRITES === '1',
    cloudUrl: new URL('integrations/one-c/agent/v1/', ensureSlash(parsed.AVTOPULT_API_URL)),
    secret: parsed.AVTOPULT_AGENT_SECRET,
    oneCUrl: local,
    oneCUsername: parsed.ONE_C_USERNAME,
    oneCPassword: parsed.ONE_C_PASSWORD,
    oneCODataUrl: odata,
    oneCODataUsername: parsed.ONE_C_ODATA_USERNAME,
    oneCODataPassword: parsed.ONE_C_ODATA_PASSWORD,
    stateDir: parsed.AVTOPULT_AGENT_STATE_DIR,
    timeoutMs: parsed.AVTOPULT_AGENT_REQUEST_TIMEOUT_MS,
  };
}

function ensureSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function validateEndpoint(value: URL): void {
  if (
    !['https:', 'http:'].includes(value.protocol) ||
    value.username ||
    value.password ||
    value.search ||
    value.hash
  )
    throw new Error('agent URLs must use HTTP(S) without embedded credentials, query or fragment');
}
