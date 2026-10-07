import { z } from 'zod';
import { isIP } from 'node:net';

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
  KASPI_SMART_POS_URL: z.url().optional(),
  KASPI_SMART_POS_NAME: z.string().trim().min(1).max(128).optional(),
  KASPI_SMART_POS_TOKEN: z.string().min(16).optional(),
  KASPI_SMART_POS_REFRESH_TOKEN: z.string().min(16).optional(),
  KASPI_CALLBACK_SECRET: z.string().min(16).optional(),
});

export type AgentConfig = ReturnType<typeof readConfig>;
type ParsedConfig = z.infer<typeof schema>;

export function readConfig(input: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(input);
  const { local, odata } = parseOneCEndpoints(parsed);
  const cloudApiUrl = new URL(parsed.AVTOPULT_API_URL);
  validateEndpoint(cloudApiUrl);
  const smartPos = parseSmartPosConfig(parsed, cloudApiUrl);
  return {
    agentId: parsed.AVTOPULT_AGENT_ID,
    cloudUrl: new URL('integrations/one-c/agent/v1/', ensureSlash(parsed.AVTOPULT_API_URL)),
    callbackUrl: new URL('integrations/one-c/callback', ensureSlash(parsed.AVTOPULT_API_URL)),
    secret: parsed.AVTOPULT_AGENT_SECRET,
    oneCUrl: local,
    oneCUsername: parsed.ONE_C_USERNAME,
    oneCPassword: parsed.ONE_C_PASSWORD,
    oneCODataUrl: odata,
    oneCODataUsername: parsed.ONE_C_ODATA_USERNAME,
    oneCODataPassword: parsed.ONE_C_ODATA_PASSWORD,
    allowWrites: parsed.ONE_C_ALLOW_WRITES === '1',
    stateDir: parsed.AVTOPULT_AGENT_STATE_DIR,
    timeoutMs: parsed.AVTOPULT_AGENT_REQUEST_TIMEOUT_MS,
    smartPos,
  };
}

function parseOneCEndpoints(parsed: ParsedConfig): { local: URL; odata: URL } {
  const local = new URL(parsed.ONE_C_WRITE_URL);
  const odata = new URL(parsed.ONE_C_ODATA_URL);
  validateEndpoint(local);
  validateEndpoint(odata);
  if (local.protocol !== 'https:' && parsed.ONE_C_ALLOW_HTTP !== '1')
    throw new Error('local 1C HTTP requires explicit ONE_C_ALLOW_HTTP=1');
  if (!local.pathname.endsWith('/hs/avtopult/v1/'))
    throw new Error('ONE_C_WRITE_URL must end with /hs/avtopult/v1/');
  if (!odata.pathname.endsWith('/odata/standard.odata/'))
    throw new Error('ONE_C_ODATA_URL must end with /odata/standard.odata/');
  if (odata.protocol !== 'https:' && parsed.ONE_C_ALLOW_HTTP !== '1')
    throw new Error('local 1C OData requires explicit ONE_C_ALLOW_HTTP=1');
  return { local, odata };
}

function parseSmartPosConfig(parsed: ParsedConfig, cloudApiUrl: URL) {
  const urlValue = parsed.KASPI_SMART_POS_URL;
  const name = parsed.KASPI_SMART_POS_NAME;
  const token = parsed.KASPI_SMART_POS_TOKEN;
  const refreshToken = parsed.KASPI_SMART_POS_REFRESH_TOKEN;
  const callbackSecret = parsed.KASPI_CALLBACK_SECRET;
  const configuredValues = [urlValue, name, token, refreshToken, callbackSecret].filter(
    (value) => value !== undefined,
  ).length;
  if (configuredValues === 0) return undefined;
  if (configuredValues !== 5)
    throw new Error(
      'Kaspi Smart POS URL, name, access token, refresh token and callback secret must be configured together',
    );
  const url = new URL(requiredSmartPosValue(urlValue));
  validateEndpoint(url);
  if (url.protocol !== 'https:' || url.port !== '8080')
    throw new Error('Kaspi Smart POS must use local HTTPS on port 8080');
  if (isIP(url.hostname) !== 0 || !url.hostname.toLowerCase().endsWith('.kaspipos.kz'))
    throw new Error(
      'Kaspi Smart POS URL must use a local DNS name covered by the trusted *.kaspipos.kz certificate',
    );
  return {
    url,
    name: requiredSmartPosValue(name),
    token: requiredSmartPosValue(token),
    refreshToken: requiredSmartPosValue(refreshToken),
    callbackSecret: requiredSmartPosValue(callbackSecret),
    callbackUrl: new URL('payments/kaspi/callback', ensureSlash(cloudApiUrl.href)),
    terminalCallbackUrl: new URL('payments/terminal/callback', ensureSlash(cloudApiUrl.href)),
  };
}

function requiredSmartPosValue(value: string | undefined): string {
  if (value === undefined) throw new Error('incomplete Kaspi Smart POS configuration');
  return value;
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
