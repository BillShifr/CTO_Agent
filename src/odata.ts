import { createHash } from 'node:crypto';
import {
  canonicalAgentJson,
  type OneCAgentCommand,
  type OneCAgentResult,
} from './protocol/index.js';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';

type Request = Extract<OneCAgentCommand, { kind: 'odata.collection' }>['request'];
type Outcome = Extract<OneCAgentResult, { kind: 'odata.collection' }>['outcome'];
export interface ODataReadResult {
  readonly outcome: Outcome;
  readonly chunks: readonly (readonly unknown[])[];
}

const INLINE_COLLECTION_BYTES = 8_000_000;
const CHUNK_BYTES = 1_000_000;
const MAX_COLLECTION_BYTES = 100_000_000;
const MAX_CHUNKS = 128;

class ODataFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export async function readODataOutcome(
  config: AgentConfig,
  request: Request,
): Promise<ODataReadResult> {
  try {
    return await collect(config, request);
  } catch (error) {
    return {
      chunks: [],
      outcome: {
        status: 'failed',
        problem: {
          contractVersion: '1.0',
          code: error instanceof ODataFailure ? error.code : 'ODATA_INVALID_RESPONSE',
          retryable: error instanceof ODataFailure && error.retryable,
          message: 'OData collection could not be read; check connection and publication settings',
        },
      },
    };
  }
}

async function collect(config: AgentConfig, request: Request): Promise<ODataReadResult> {
  const url = initialUrl(request.relativePath, config.oneCODataUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  const builder = new ODataCollectionBuilder();
  let next: URL | undefined = url;
  for (let page = 0; page < 500 && next !== undefined; page++) {
    const payload = await readPage(config, next);
    for (const value of payload.value) builder.add(value);
    const link = payload['odata.nextLink'];
    next = link === undefined ? undefined : checkedUrl(link, config.oneCODataUrl);
  }
  if (next !== undefined) throw new ODataFailure('ODATA_PAGE_LIMIT', false);
  return builder.finish();
}

class ODataCollectionBuilder {
  private readonly values: unknown[] = [];
  private readonly chunks: unknown[][] = [];
  private chunk: unknown[] = [];
  private chunkBytes = 2;
  private size = 2;
  private readonly hash = createHash('sha256').update('[');

  add(value: unknown): void {
    const encoded = canonicalAgentJson(value);
    const valueBytes = Buffer.byteLength(encoded);
    if (valueBytes > 8_000_000) throw new ODataFailure('ODATA_ITEM_TOO_LARGE', false);
    const separator = this.values.length === 0 ? 0 : 1;
    this.size += valueBytes + separator;
    if (this.size > MAX_COLLECTION_BYTES)
      throw new ODataFailure('ODATA_COLLECTION_TOO_LARGE', false);
    if (this.chunk.length > 0 && this.chunkBytes + valueBytes + 1 > CHUNK_BYTES) this.closeChunk();
    if (this.chunks.length >= MAX_CHUNKS)
      throw new ODataFailure('ODATA_COLLECTION_TOO_LARGE', false);
    this.chunk.push(value);
    this.chunkBytes += valueBytes + (this.chunk.length === 1 ? 0 : 1);
    this.values.push(value);
    if (separator > 0) this.hash.update(',');
    this.hash.update(encoded);
  }

  finish(): ODataReadResult {
    this.hash.update(']');
    if (this.size <= INLINE_COLLECTION_BYTES)
      return { chunks: [], outcome: { status: 'succeeded', response: this.values } };
    this.closeChunk();
    return {
      chunks: this.chunks,
      outcome: {
        status: 'succeeded',
        response: {
          transfer: 'chunks',
          chunkCount: this.chunks.length,
          itemCount: this.values.length,
          sha256: this.hash.digest('hex'),
        },
      },
    };
  }

  private closeChunk(): void {
    if (this.chunk.length === 0) return;
    this.chunks.push(this.chunk);
    this.chunk = [];
    this.chunkBytes = 2;
  }
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
