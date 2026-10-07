import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from './config.js';
import { KaspiSmartPosClient } from './kaspi-smart-pos.js';
import { validAgentEnvironment } from './test-environment.js';

const directories: string[] = [];
const config = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avtopult-smart-pos-client-'));
  directories.push(directory);
  return readConfig(
    validAgentEnvironment({
      AVTOPULT_AGENT_STATE_DIR: directory,
      KASPI_SMART_POS_URL: 'https://terminal-01.kaspipos.kz:8080/',
      KASPI_SMART_POS_NAME: 'AvtoPult-station-1',
      KASPI_SMART_POS_TOKEN: 'k'.repeat(16),
      KASPI_SMART_POS_REFRESH_TOKEN: 'r'.repeat(16),
      KASPI_CALLBACK_SECRET: 'c'.repeat(16),
    }),
  );
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
  );
});

describe('Kaspi Smart POS client', () => {
  it('starts one whole-tenge payment on the local terminal only', async () => {
    const fetch = vi.fn(async () => Response.json({ statusCode: 0, data: { processId: 'p-1' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(new KaspiSmartPosClient(await config()).startPayment(12_500n)).resolves.toEqual({
      processId: 'p-1',
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://terminal-01.kaspipos.kz:8080/v2/payment?amount=125&owncheque=false',
    );
    expect(new Headers(init.headers).get('accesstoken')).toBe('k'.repeat(16));
  });

  it('rejects an amount that Smart POS cannot charge exactly', async () => {
    await expect(new KaspiSmartPosClient(await config()).startPayment(12_501n)).rejects.toThrow(
      'tiyn',
    );
  });

  it('retains the actual QR transaction identity returned by Smart POS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          statusCode: 0,
          data: {
            status: 'success',
            subStatus: 'QrTransactionSuccess',
            transactionId: '504711333',
            chequeInfo: { method: 'qr', orderNumber: '504711333', terminalId: '31452963' },
          },
        }),
      ),
    );
    await expect(new KaspiSmartPosClient(await config()).status('p-1')).resolves.toEqual({
      status: 'success',
      method: 'kaspi_qr',
      transactionId: '504711333',
      terminalId: '31452963',
    });
  });

  it('settles Kaspi Alaqan through the Kaspi payment domain instead of stranding the payment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          statusCode: 0,
          data: {
            status: 'success',
            transactionId: '504711334',
            chequeInfo: { method: 'alaqan', orderNumber: '504711334' },
          },
        }),
      ),
    );
    await expect(new KaspiSmartPosClient(await config()).status('p-1')).resolves.toMatchObject({
      status: 'success',
      method: 'kaspi_qr',
      transactionId: '504711334',
    });
  });
});

describe('Kaspi Smart POS authorization and card evidence', () => {
  it('retains the actual card evidence returned by Smart POS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          statusCode: 0,
          data: {
            status: 'success',
            subStatus: 'CardTransactionSuccess',
            transactionId: '307208187011',
            chequeInfo: {
              method: 'card',
              cardMask: '440043******6389',
              rrn: '307208187011',
              terminalId: '31452963',
            },
          },
        }),
      ),
    );
    await expect(new KaspiSmartPosClient(await config()).status('p-1')).resolves.toEqual({
      status: 'success',
      method: 'card_terminal',
      transactionId: '307208187011',
      cardMask: '440043******6389',
      rrn: '307208187011',
      terminalId: '31452963',
    });
  });

  it('rotates an expired access token once and persists both replacement tokens', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({
          statusCode: 0,
          data: { accessToken: 'a'.repeat(16), refreshToken: 'b'.repeat(16) },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ statusCode: 0, data: { processId: 'p-1', status: 'wait' } }),
      )
      .mockResolvedValueOnce(
        Response.json({ statusCode: 0, data: { processId: 'p-1', status: 'wait' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const client = new KaspiSmartPosClient(await config());
    await expect(client.status('p-1')).resolves.toEqual({ status: 'wait' });
    await expect(client.status('p-1')).resolves.toEqual({ status: 'wait' });
    const [revokeUrl, revokeInit] = fetch.mock.calls[1] as [URL, RequestInit];
    expect(revokeUrl.pathname).toBe('/v2/revoke');
    expect(revokeUrl.searchParams.get('name')).toBe('AvtoPult-station-1');
    expect(revokeUrl.searchParams.get('refreshToken')).toBe('r'.repeat(16));
    expect(new Headers(revokeInit.headers).has('accesstoken')).toBe(false);
    expect(
      new Headers((fetch.mock.calls[2] as [URL, RequestInit])[1].headers).get('accesstoken'),
    ).toBe('a'.repeat(16));
    expect(
      new Headers((fetch.mock.calls[3] as unknown as [URL, RequestInit])[1].headers).get(
        'accesstoken',
      ),
    ).toBe('a'.repeat(16));
  });

  it('uses the dedicated actualization endpoint for an unknown process', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ statusCode: 0, data: { processId: 'p-1', status: 'fail' } }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(new KaspiSmartPosClient(await config()).actualize('p-1')).resolves.toEqual({
      status: 'fail',
    });
    expect((fetch.mock.calls[0] as unknown as [URL, RequestInit])[0].pathname).toBe(
      '/v2/actualize',
    );
  });
});
