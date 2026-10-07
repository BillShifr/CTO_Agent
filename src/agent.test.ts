import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneCAgent } from './agent.js';
import { readConfig } from './config.js';
import { validAgentEnvironment } from './test-environment.js';

interface ObservedFetch {
  readonly url: string;
  readonly init?: RequestInit;
}

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe('1C agent delivery', () => {
  it.each(['normal', 'lost-response', 'reclaimed'])(
    'spools and recovers delivery without executing 1C again: %s',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-agent-'));
      directories.push(directory);
      let claims = 0;
      let acknowledgements = 0;
      const observed = stubObservedFetch(async (url) => {
        const standard = agentPollResponse(url);
        if (standard !== null) return standard;
        if (url.endsWith('/commands/claim')) {
          claims++;
          if (claims > 1 && mode !== 'reclaimed')
            return Response.json({ command: null, retryAfterMs: 2000 });
          return Response.json({
            retryAfterMs: 250,
            command: {
              id: 'a3f63973-d63f-4f07-8279-57300f22b409',
              kind: 'invoice.request',
              idempotencyKey: 'outbox:message-1',
              leaseToken: (claims === 1 ? 'x' : 'y').repeat(32),
              leaseUntil: '2026-10-03T05:00:00.000Z',
              request: {
                contractVersion: '1.0',
                workOrderExternalId: 'wo-1',
                amountTiyn: '50000',
                requestAttempt: 1,
              },
            },
          });
        }
        if (url.endsWith('/hs/avtopult/v1/invoices'))
          return Response.json(
            {
              contractVersion: '1.0',
              requestId: 'invoice-request-1',
              status: 'accepted',
            },
            { status: 202 },
          );
        if (url.endsWith('/result')) {
          acknowledgements++;
          return acknowledgement(mode, acknowledgements);
        }
        throw new Error(`unexpected URL ${url}`);
      });

      const agent = new OneCAgent(
        readConfig(
          validAgentEnvironment({
            AVTOPULT_AGENT_ID: 'station-1',
            AVTOPULT_AGENT_STATE_DIR: directory,
          }),
        ),
      );
      if (mode === 'lost-response') await expect(agent.runOnce()).rejects.toThrow();
      else await agent.runOnce();
      if (mode !== 'normal') await agent.runOnce();

      const local = observed.find((entry) => entry.url.endsWith('/invoices'));
      expect(new Headers(local?.init?.headers).get('idempotency-key')).toBe('outbox:message-1');
      expect(new Headers(local?.init?.headers).get('x-avtopult-contract-version')).toBe('1.0');
      expect(observed.filter((entry) => entry.url.endsWith('/invoices'))).toHaveLength(1);
      expect(acknowledgements).toBe(mode === 'normal' ? 1 : mode === 'lost-response' ? 2 : 3);
      expect(JSON.parse(await readFile(join(directory, 'pending-results.json'), 'utf8'))).toEqual(
        {},
      );
    },
  );

  it('sends payroll only to the local 1C endpoint and returns the typed receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-agent-'));
    directories.push(directory);
    let claimed = false;
    const observed = stubObservedFetch(async (url) => {
      const standard = agentPollResponse(url);
      if (standard !== null) return standard;
      if (url.endsWith('/commands/claim')) {
        if (claimed) return Response.json({ command: null, retryAfterMs: 2000 });
        claimed = true;
        return Response.json({
          retryAfterMs: 250,
          command: {
            id: 'a3f63973-d63f-4f07-8279-57300f22b409',
            kind: 'payroll.export',
            idempotencyKey: 'payroll:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            leaseToken: 'x'.repeat(32),
            leaseUntil: '2026-10-03T05:00:00.000Z',
            request: {
              periodId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              dateFrom: '2026-09-01T00:00:00.000Z',
              dateTo: '2026-10-01T00:00:00.000Z',
              stationId: null,
              lines: [],
            },
          },
        });
      }
      if (url.endsWith('/hs/avtopult/v1/payroll-periods'))
        return Response.json({ externalId: 'accrual-2026-09' });
      if (url.endsWith('/result')) return Response.json({ accepted: true });
      throw new Error(`unexpected URL ${url}`);
    });
    const agent = new OneCAgent(
      readConfig(
        validAgentEnvironment({
          AVTOPULT_AGENT_ID: 'station-1',
          AVTOPULT_AGENT_STATE_DIR: directory,
        }),
      ),
    );
    await agent.runOnce();
    const local = observed.find((entry) => entry.url.endsWith('/payroll-periods'));
    expect(local).toBeDefined();
    expect(new Headers(local?.init?.headers).get('idempotency-key')).toContain('payroll:');
  });
});

describe('Kaspi QR Smart POS delivery', () => {
  it('persists the local process and reports a confirmed payment only after terminal success', async () => {
    const { agent, observed } = await smartPosAgent('kaspi_qr', 'payments/kaspi/callback');
    await agent.runOnce();
    await agent.runOnce();

    const callback = observed.find((entry) => entry.url.endsWith('/payments/kaspi/callback'));
    expect(JSON.parse(String(callback?.init?.body))).toMatchObject({
      externalId: 'SMARTPOS-payment-1',
      amountTiyn: '12500',
      status: 'paid',
      actualMethod: 'kaspi_qr',
      transactionId: 'transaction-1',
      terminalId: 'terminal-1',
    });
    expect(new Headers(callback?.init?.headers).get('x-kaspi-secret')).toBe('c'.repeat(16));
  });

  it('replays the exact durable callback after the cloud response is lost', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    const { agent, observed } = await smartPosAgent('kaspi_qr', 'payments/kaspi/callback', true);
    await agent.runOnce();
    await agent.runOnce();
    vi.setSystemTime(new Date('2026-10-07T00:05:00.000Z'));
    await agent.runOnce();

    const callbacks = observed.filter((entry) => entry.url.endsWith('/payments/kaspi/callback'));
    expect(callbacks).toHaveLength(2);
    expect(callbacks[0]?.init?.body).toBe(callbacks[1]?.init?.body);
    expect(JSON.parse(String(callbacks[1]?.init?.body))).toMatchObject({
      eventId: 'smart-pos:process-1:paid',
      paidAt: '2026-10-07T00:00:00.000Z',
    });
    expect(observed.filter((entry) => entry.url.includes('/v2/status'))).toHaveLength(1);
  });

  it('polls a pending process each second and rate-limits unknown-status actualization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-smart-pos-unknown-'));
    directories.push(directory);
    const state = { claims: 0, actualizations: 0 };
    stubObservedFetch(async (url) => unknownSmartPosResponse(url, state));
    const agent = new OneCAgent(smartPosConfig(directory));

    await agent.runOnce();
    await expect(agent.runOnce()).resolves.toBe(1_000);
    expect(state.actualizations).toBe(1);
    vi.setSystemTime(new Date('2026-10-07T00:00:05.000Z'));
    await expect(agent.runOnce()).resolves.toBe(1_000);
    expect(state.actualizations).toBe(1);
    vi.setSystemTime(new Date('2026-10-07T00:00:11.000Z'));
    await expect(agent.runOnce()).resolves.toBe(1_000);
    expect(state.actualizations).toBe(2);
  });
});

describe('terminal Smart POS delivery', () => {
  it('returns a card, Apple Pay or Google Pay terminal outcome only to the terminal callback', async () => {
    const { agent, observed } = await smartPosAgent('card_terminal', 'payments/terminal/callback');
    await agent.runOnce();
    await agent.runOnce();

    const callback = observed.find((entry) => entry.url.endsWith('/payments/terminal/callback'));
    expect(JSON.parse(String(callback?.init?.body))).toMatchObject({
      externalId: 'SMARTPOS-payment-1',
      amountTiyn: '12500',
      status: 'paid',
      actualMethod: 'card_terminal',
      transactionId: 'transaction-1',
      cardMask: '6389',
      rrn: '307208187011',
    });
    expect(observed.some((entry) => entry.url.endsWith('/payments/kaspi/callback'))).toBe(false);
  });
});

describe('successful 1C invoice document relay', () => {
  it('uploads a verified local PDF and only then acknowledges its 1C outbox item', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-invoice-document-'));
    directories.push(directory);
    const pdf = Buffer.from('%PDF-1.4\ninvoice\n', 'utf8');
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const observed = stubObservedFetch(async (url) => {
      if (url.endsWith('/invoice-documents/claim'))
        return Response.json(invoiceDocumentClaim('invoice-document-1', sha256));
      const standard = agentPollResponse(url);
      if (standard !== null) return standard;
      if (url.endsWith('/invoice-documents/invoice-document-1/content'))
        return new Response(pdf, {
          headers: {
            'cache-control': 'private, no-store',
            'content-type': 'application/pdf',
          },
        });
      if (url.endsWith('/integrations/one-c/invoice-document'))
        return Response.json({ accepted: true, eventId: 'invoice-document-1' });
      if (url.endsWith('/invoice-documents/invoice-document-1/ack'))
        return new Response(null, { status: 204 });
      return noCommandOrUnexpected(url);
    });

    await agentFor(directory).runOnce();

    const upload = observed.find((entry) =>
      entry.url.endsWith('/integrations/one-c/invoice-document'),
    );
    const headers = new Headers(upload?.init?.headers);
    expect(headers.get('x-onec-secret')).toBe('s'.repeat(32));
    expect(headers.get('x-content-sha256')).toBe(sha256);
    expect(Buffer.from(upload?.init?.body as Buffer)).toEqual(pdf);
    const contentRequest = observed.find((entry) =>
      entry.url.endsWith('/invoice-documents/invoice-document-1/content'),
    );
    expect(new Headers(contentRequest?.init?.headers).get('x-avtopult-lease-token')).toBe(
      'd'.repeat(32),
    );
    expect(new Headers(contentRequest?.init?.headers).get('x-avtopult-contract-version')).toBe(
      '1.0',
    );
    expect(
      observed.some((entry) => entry.url.endsWith('/invoice-documents/invoice-document-1/ack')),
    ).toBe(true);
  });
});

describe('1C invoice document relay integrity failure', () => {
  it('keeps the local invoice document unacknowledged if the digest is wrong', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-invoice-document-failure-'));
    directories.push(directory);
    const observed = stubObservedFetch(async (url) => {
      if (url.endsWith('/invoice-documents/claim'))
        return Response.json(invoiceDocumentClaim('invoice-document-2', '0'.repeat(64)));
      const standard = agentPollResponse(url);
      if (standard !== null) return standard;
      if (url.endsWith('/invoice-documents/invoice-document-2/content'))
        return new Response('%PDF-1.4\ninvoice\n', {
          headers: {
            'cache-control': 'private, no-store',
            'content-type': 'application/pdf',
          },
        });
      return noCommandOrUnexpected(url);
    });

    await expect(agentFor(directory).runOnce()).resolves.toBe(2000);
    expect(
      observed.some((entry) => entry.url.endsWith('/invoice-documents/invoice-document-2/ack')),
    ).toBe(false);
    const heartbeat = observed.find((entry) => entry.url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeat?.init?.body))).toMatchObject({
      components: { oneCDocuments: 'degraded' },
      failures: ['one_c_documents'],
    });
  });
});

describe('1C outbound event relay', () => {
  it('acknowledges the local outbox only after Cloud accepts the exact event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-events-'));
    directories.push(directory);
    const observed = stubObservedFetch(async (url) => {
      if (url.endsWith('/events/claim')) return Response.json(cashEventClaim('cash-payment-1'));
      const standard = agentPollResponse(url);
      if (standard !== null) return standard;
      if (url.endsWith('/integrations/one-c/callback'))
        return Response.json({ accepted: true, eventId: 'cash-payment-1' });
      if (url.endsWith('/events/cash-payment-1/ack')) return new Response(null, { status: 204 });
      return noCommandOrUnexpected(url);
    });
    await agentFor(directory).runOnce();

    const callback = observed.find((entry) => entry.url.endsWith('/integrations/one-c/callback'));
    expect(new Headers(callback?.init?.headers).get('x-onec-secret')).toBe('s'.repeat(32));
    expect(JSON.parse(String(callback?.init?.body))).toMatchObject({ event: 'cash.payment' });
    const acknowledgement = observed.find((entry) =>
      entry.url.endsWith('/events/cash-payment-1/ack'),
    );
    expect(JSON.parse(String(acknowledgement?.init?.body))).toEqual({ leaseToken: 'l'.repeat(32) });
  });

  it('keeps the event unacknowledged but continues heartbeat and command polling', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-events-failure-'));
    directories.push(directory);
    const observed = stubObservedFetch(async (url) => {
      if (url.endsWith('/events/claim')) return Response.json(cashEventClaim('cash-payment-2'));
      const standard = agentPollResponse(url);
      if (standard !== null) return standard;
      if (url.endsWith('/integrations/one-c/callback')) return new Response(null, { status: 503 });
      return noCommandOrUnexpected(url);
    });
    await expect(agentFor(directory).runOnce()).resolves.toBe(2000);
    expect(observed.some((entry) => entry.url.endsWith('/events/cash-payment-2/ack'))).toBe(false);
    const heartbeat = observed.find((entry) => entry.url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeat?.init?.body))).toMatchObject({
      components: { oneCEvents: 'degraded', oneCDocuments: 'ok' },
      failures: ['one_c_events'],
    });
    expect(observed.some((entry) => entry.url.endsWith('/commands/claim'))).toBe(true);
  });
});

function acknowledgement(mode: string, count: number): Response {
  if (mode === 'lost-response' && count === 1) throw new Error('connection reset');
  if (mode === 'reclaimed' && count <= 2) return new Response(null, { status: 409 });
  return new Response(null, { status: 204 });
}

async function smartPosAgent(
  method: 'kaspi_qr' | 'card_terminal',
  callbackPath: 'payments/kaspi/callback' | 'payments/terminal/callback',
  loseFirstCallback = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'avtopult-smart-pos-agent-'));
  directories.push(directory);
  const state = { claims: 0, callbacks: 0 };
  const observed = stubObservedFetch(async (url) => {
    const standard = agentPollResponse(url);
    if (standard !== null) return standard;
    return smartPosResponse(url, { method, callbackPath, loseFirstCallback, state });
  });
  return {
    agent: new OneCAgent(smartPosConfig(directory)),
    observed,
  };
}

function smartPosConfig(directory: string) {
  return readConfig(
    validAgentEnvironment({
      AVTOPULT_AGENT_ID: 'station-1',
      AVTOPULT_AGENT_STATE_DIR: directory,
      KASPI_SMART_POS_URL: 'https://terminal-01.kaspipos.kz:8080/',
      KASPI_SMART_POS_NAME: 'AvtoPult-station-1',
      KASPI_SMART_POS_TOKEN: 'k'.repeat(16),
      KASPI_SMART_POS_REFRESH_TOKEN: 'r'.repeat(16),
      KASPI_CALLBACK_SECRET: 'c'.repeat(16),
    }),
  );
}

function unknownSmartPosResponse(
  url: string,
  state: { claims: number; actualizations: number },
): Response {
  const common = smartPosCommonResponse(url, 'kaspi_qr', state);
  if (common !== null) return common;
  if (url.includes('/v2/actualize')) state.actualizations++;
  if (url.includes('/v2/status') || url.includes('/v2/actualize'))
    return Response.json({ statusCode: 0, data: { processId: 'process-1', status: 'unknown' } });
  if (url.endsWith('/result')) return new Response(null, { status: 204 });
  throw new Error(`unexpected URL ${url}`);
}

function smartPosResponse(
  url: string,
  options: {
    method: 'kaspi_qr' | 'card_terminal';
    callbackPath: 'payments/kaspi/callback' | 'payments/terminal/callback';
    loseFirstCallback: boolean;
    state: { claims: number; callbacks: number };
  },
): Response {
  const { method, callbackPath, loseFirstCallback, state } = options;
  const common = smartPosCommonResponse(url, method, state);
  if (common !== null) return common;
  if (url.includes('/v2/status')) return smartPosSuccess(method);
  if (url.endsWith(`/${callbackPath}`)) {
    state.callbacks++;
    if (loseFirstCallback && state.callbacks === 1) throw new Error('connection reset');
    return Response.json({ applied: true });
  }
  throw new Error(`unexpected URL ${url}`);
}

function smartPosCommonResponse(
  url: string,
  method: 'kaspi_qr' | 'card_terminal',
  state: { claims: number },
): Response | null {
  const standard = agentPollResponse(url);
  if (standard !== null) return standard;
  if (url.endsWith('/commands/claim')) {
    state.claims++;
    return Response.json(
      state.claims === 1
        ? { retryAfterMs: 250, command: smartPosCommand(method) }
        : { command: null, retryAfterMs: 2000 },
    );
  }
  if (url.includes('/v2/payment'))
    return Response.json({ statusCode: 0, data: { processId: 'process-1' } });
  if (url.endsWith('/result')) return new Response(null, { status: 204 });
  return null;
}

function smartPosSuccess(method: 'kaspi_qr' | 'card_terminal'): Response {
  return Response.json({
    statusCode: 0,
    data: {
      status: 'success',
      transactionId: 'transaction-1',
      chequeInfo:
        method === 'kaspi_qr'
          ? { method: 'qr', terminalId: 'terminal-1' }
          : {
              method: 'card',
              terminalId: 'terminal-1',
              cardMask: '440043******6389',
              rrn: '307208187011',
            },
    },
  });
}

function smartPosCommand(method: 'kaspi_qr' | 'card_terminal') {
  return {
    id: 'a3f63973-d63f-4f07-8279-57300f22b409',
    kind: 'kaspi.smart-pos.start',
    idempotencyKey: `kaspi-smart-pos:${method === 'card_terminal' ? 'terminal:' : ''}payment-1`,
    leaseToken: 'x'.repeat(32),
    leaseUntil: '2026-10-03T05:00:00.000Z',
    request: { externalId: 'SMARTPOS-payment-1', amountTiyn: '12500', method },
  };
}

function agentPollResponse(url: string): Response | null {
  if (url.endsWith('/events/claim')) return Response.json({ events: [] });
  if (url.endsWith('/invoice-documents/claim')) return Response.json({ documents: [] });
  if (url.endsWith('/heartbeat')) return new Response(null, { status: 204 });
  return null;
}

function noCommandOrUnexpected(url: string): Response {
  if (url.endsWith('/commands/claim')) return Response.json({ command: null, retryAfterMs: 2000 });
  throw new Error(`unexpected URL ${url}`);
}

function agentFor(directory: string) {
  return new OneCAgent(readConfig(validAgentEnvironment({ AVTOPULT_AGENT_STATE_DIR: directory })));
}

function invoiceDocumentClaim(eventId: string, documentSha256: string) {
  return {
    documents: [
      {
        leaseToken: 'd'.repeat(32),
        upload: {
          eventId,
          workOrderExternalId: 'wo-1',
          requestAttempt: 1,
          invoiceExternalId: eventId.replace('invoice-document', 'invoice'),
          invoiceNumber: 'INV-1',
          issuedAt: '2026-10-06T10:00:00.000Z',
          amountTiyn: '50000',
          documentSha256,
        },
      },
    ],
  };
}

function cashEventClaim(eventId: string) {
  return {
    events: [
      {
        leaseToken: 'l'.repeat(32),
        event: {
          event: 'cash.payment',
          eventId,
          workOrderExternalId: 'wo-1',
          occurredAt: '2026-10-06T10:00:00.000Z',
          amountTiyn: '50000',
          paymentExternalId: eventId.replace('payment', 'document'),
        },
      },
    ],
  };
}

function stubObservedFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ObservedFetch[] {
  const observed: ObservedFetch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input.toString();
      observed.push({ url, init });
      const response = await respond(url, init);
      if (url.startsWith('http://127.0.0.1') && url.includes('/hs/avtopult/v1/'))
        response.headers.set('x-avtopult-contract-version', '1.0');
      return response;
    }),
  );
  return observed;
}
