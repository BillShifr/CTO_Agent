import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';
import { SmartPosCredentialStore } from './smart-pos-credentials.js';

type SmartPosResponse = { readonly statusCode: number; readonly data?: Record<string, unknown> };

export type SmartPosStatus =
  | { readonly status: 'wait' | 'fail' | 'unknown'; readonly message?: string }
  | {
      readonly status: 'success';
      readonly method: 'kaspi_qr' | 'card_terminal';
      readonly transactionId: string;
      readonly terminalId?: string;
      readonly cardMask?: string;
      readonly rrn?: string;
    };

export class KaspiSmartPosClient {
  private readonly credentials: SmartPosCredentialStore;

  constructor(private readonly config: AgentConfig) {
    this.credentials = new SmartPosCredentialStore(config);
  }

  async startPayment(amountTiyn: bigint): Promise<{ readonly processId: string }> {
    const smartPos = this.requiredConfig();
    if (amountTiyn % 100n !== 0n) throw new Error('Smart POS does not support tiyn');
    const amount = amountTiyn / 100n;
    if (amount <= 0n || amount > 2_147_483_647n) throw new Error('Smart POS amount is invalid');
    const url = new URL('/v2/payment', smartPos.url);
    url.searchParams.set('amount', amount.toString());
    url.searchParams.set('owncheque', 'false');
    const payload = await this.authorizedRequest(url);
    const processId = payload.data?.processId;
    if (payload.statusCode !== 0 || typeof processId !== 'string' || processId.length === 0)
      throw new Error('Smart POS did not start payment');
    return { processId };
  }

  async status(processId: string): Promise<SmartPosStatus> {
    return await this.readStatus('/v2/status', processId);
  }

  async actualize(processId: string): Promise<SmartPosStatus> {
    return await this.readStatus('/v2/actualize', processId);
  }

  private async readStatus(path: '/v2/status' | '/v2/actualize', processId: string) {
    const smartPos = this.requiredConfig();
    const url = new URL(path, smartPos.url);
    url.searchParams.set('processId', processId);
    const payload = await this.authorizedRequest(url);
    const data = payload.data;
    const status = data?.status;
    if (!['wait', 'success', 'fail', 'unknown'].includes(String(status)))
      throw new Error('Smart POS returned invalid status');
    if (status !== 'success') {
      const message = typeof data?.message === 'string' ? data.message : undefined;
      return message === undefined
        ? ({ status } as SmartPosStatus)
        : ({ status, message } as SmartPosStatus);
    }
    if (data === undefined) throw new Error('Smart POS returned invalid success payload');
    return successfulStatus(data);
  }

  private async authorizedRequest(url: URL): Promise<SmartPosResponse> {
    const credentials = await this.credentials.read();
    const response = await this.rawRequest(url, credentials.accessToken);
    if (response.status !== 403) return await responsePayload(response);
    const rotated = await this.rotate(credentials.refreshToken);
    return await responsePayload(await this.rawRequest(url, rotated.accessToken));
  }

  private async rotate(refreshToken: string) {
    const smartPos = this.requiredConfig();
    const url = new URL('/v2/revoke', smartPos.url);
    url.searchParams.set('name', smartPos.name);
    url.searchParams.set('refreshToken', refreshToken);
    const payload = await responsePayload(await this.rawRequest(url));
    const data = payload.data;
    if (payload.statusCode !== 0) throw new Error('Smart POS did not refresh authorization');
    const rotated = {
      accessToken: requiredText(data?.accessToken, 'access token'),
      refreshToken: requiredText(data?.refreshToken, 'refresh token'),
    };
    await this.credentials.write(rotated);
    return rotated;
  }

  private requiredConfig() {
    if (this.config.smartPos === undefined) throw new Error('Kaspi Smart POS is not configured');
    return this.config.smartPos;
  }

  private async rawRequest(url: URL, token?: string): Promise<Response> {
    return await boundedFetch(this.config, url, {
      headers: {
        ...(token === undefined ? {} : { accesstoken: token }),
        accept: 'application/json',
      },
    });
  }
}

async function responsePayload(response: Response): Promise<SmartPosResponse> {
  if (!response.ok) throw new Error(`Smart POS HTTP ${response.status}`);
  const payload = (await json(response)) as SmartPosResponse;
  if (payload.statusCode !== 0) throw new Error(`Smart POS API ${String(payload.statusCode)}`);
  return payload;
}

function successfulStatus(data: Record<string, unknown>): SmartPosStatus {
  const cheque = record(data.chequeInfo);
  const rawMethod = cheque.method;
  const method =
    rawMethod === 'qr' || rawMethod === 'alaqan'
      ? 'kaspi_qr'
      : rawMethod === 'card'
        ? 'card_terminal'
        : null;
  if (method === null) throw new Error('Smart POS returned unsupported payment method');
  const transactionId = requiredText(data.transactionId, 'transaction id');
  const terminalId = optionalText(cheque.terminalId);
  const cardMask = optionalText(cheque.cardMask);
  const rrn = optionalText(cheque.rrn);
  return {
    status: 'success',
    method,
    transactionId,
    ...(terminalId === undefined ? {} : { terminalId }),
    ...(cardMask === undefined ? {} : { cardMask }),
    ...(rrn === undefined ? {} : { rrn }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
  const text = optionalText(value);
  if (text === undefined) throw new Error(`Smart POS returned invalid ${name}`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
