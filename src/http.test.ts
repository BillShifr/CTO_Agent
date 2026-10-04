import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bounded agent HTTP', () => {
  it('limits streamed bodies before buffering an unbounded response', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16));
        },
        cancel,
      }),
    );
    await expect(json(response, 8)).rejects.toThrow('response exceeds size limit');
    expect(cancel).toHaveBeenCalled();
  });

  it('keeps the deadline active after headers while the body is stalled', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const pending = boundedFetch(
      { timeoutMs: 100 } as AgentConfig,
      new URL('https://cloud.example'),
      {},
    );
    const assertion = expect(pending).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });
});
