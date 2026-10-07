import type { AgentConfig } from './config.js';

export async function boundedFetch(
  config: AgentConfig,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('request timed out'));
      controller.abort();
    }, config.timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
        const body =
          response.body === null
            ? null
            : await bytes(response, 10 * 1024 * 1024, controller.signal);
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })(),
      expired,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function json(response: Response, maxBytes = 1_000_000): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await bytes(response, maxBytes))) as unknown;
}

async function bytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error('response exceeds size limit');
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('response exceeds size limit');
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
