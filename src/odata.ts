import type { OneCAgentCommand, OneCAgentResult } from './protocol/index.js';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';

type Request = Extract<OneCAgentCommand, { kind: 'odata.collection' }>['request'];
type Outcome = Extract<OneCAgentResult, { kind: 'odata.collection' }>['outcome'];

class ODataFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export async function readODataOutcome(config: AgentConfig, request: Request): Promise<Outcome> {
  try {
    return { status: 'succeeded', response: await collect(config, request) };
  } catch (error) {
    return {
      status: 'failed',
      problem: {
        contractVersion: '1.0',
        code: error instanceof ODataFailure ? error.code : 'ODATA_INVALID_RESPONSE',
        retryable: error instanceof ODataFailure && error.retryable,
        message: 'OData collection could not be read; check connection and publication settings',
      },
    };
  }
}

async function collect(config: AgentConfig, request: Request): Promise<unknown[]> {
  const url = initialUrl(request.relativePath, config.oneCODataUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  const values: unknown[] = [];
  let next: URL | undefined = url;
  // Leave room for the enclosing result envelope within the cloud's 10 MB body limit.
  let size = 2;
  for (let page = 0; page < 500 && next !== undefined; page++) {
    const payload = await readPage(config, next);
    for (const value of payload.value) {
      size += Buffer.byteLength(JSON.stringify(value)) + 1;
      if (size > 9_900_000) throw new ODataFailure('ODATA_COLLECTION_TOO_LARGE', false);
      values.push(value);
    }
    const link = payload['odata.nextLink'];
    next = link === undefined ? undefined : checkedUrl(link, config.oneCODataUrl);
  }
  if (next !== undefined) throw new ODataFailure('ODATA_PAGE_LIMIT', false);
  return values;
}

function initialUrl(path: string, base: URL): URL {
  if (path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path))
    throw new ODataFailure('ODATA_INVALID_PATH', false);
  return checkedUrl(path, base);
}

function checkedUrl(value: unknown, base: URL): URL {
  if (typeof value !== 'string') throw new ODataFailure('ODATA_INVALID_LINK', false);
  const url = new URL(value, base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ODataFailure('ODATA_INVALID_LINK', false);
  return url;
}

async function readPage(
  config: AgentConfig,
  url: URL,
): Promise<{ value: unknown[]; 'odata.nextLink'?: unknown }> {
  let response: Response;
  try {
    response = await boundedFetch(config, url, {
      headers: {
        authorization: `Basic ${Buffer.from(`${config.oneCODataUsername}:${config.oneCODataPassword}`).toString('base64')}`,
        accept: 'application/json',
      },
    });
  } catch {
    throw new ODataFailure('ODATA_TRANSPORT_ERROR', true);
  }
  if (!response.ok)
    throw new ODataFailure(
      `ODATA_HTTP_${response.status}`,
      response.status >= 500 || [408, 429].includes(response.status),
    );
  const payload = (await json(response, 10_000_000)) as {
    value?: unknown;
    'odata.nextLink'?: unknown;
  } | null;
  if (!Array.isArray(payload?.value)) throw new ODataFailure('ODATA_INVALID_COLLECTION', false);
  return { value: payload.value, 'odata.nextLink': payload['odata.nextLink'] };
}
