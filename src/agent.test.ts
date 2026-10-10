import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
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
      await agent.runOnce();
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
  it('returns a terminal failure instead of leasing an unconfigured command forever', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-smart-pos-unconfigured-'));
    directories.push(directory);
    let claimed = false;
    let result: unknown;
    stubObservedFetch(async (url, init) => {
      const standard = agentPollResponse(url);
      if (standard !== null) return standard;
      if (url.endsWith('/commands/claim')) {
        if (claimed) return Response.json({ command: null, retryAfterMs: 2000 });
        claimed = true;
        return Response.json({ retryAfterMs: 250, command: smartPosCommand('kaspi_qr') });
      }
      if (url.endsWith('/result')) {
        result = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await agentFor(directory).runOnce();
    expect(result).toMatchObject({
      kind: 'kaspi.smart-pos.start',
      outcome: {
        status: 'failed',
        problem: { code: 'SMART_POS_NOT_CONFIGURED', retryable: false },
      },
    });
  });

  it('reports an independent settled payment when an earlier callback is rejected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-smart-pos-isolation-'));
    directories.push(directory);
    const settled = (processId: string) => ({
      processId,
      amountTiyn: '12500',
      method: 'kaspi_qr',
      createdAt: '2026-10-10T00:00:00.000Z',
      settlement: {
        status: 'paid',
        paidAt: '2026-10-10T00:01:00.000Z',
        actualMethod: 'kaspi_qr',
        transactionId: `transaction-${processId}`,
      },
    });
    await writeFile(
      join(directory, 'pending-smart-pos.json'),
      JSON.stringify({ bad: settled('bad'), good: settled('good') }),
    );
    const observed = stubObservedFetch(async (url, init) => {
      if (url.endsWith('/payments/kaspi/callback')) {
        const payload = JSON.parse(String(init?.body)) as { processId?: string; eventId: string };
        return new Response(null, { status: payload.eventId.includes(':bad:') ? 500 : 200 });
      }
      return agentPollResponse(url) ?? noCommandOrUnexpected(url);
    });

    await expect(new OneCAgent(smartPosConfig(directory)).runOnce()).resolves.toBe(1000);
    expect(JSON.parse(await readFile(join(directory, 'pending-smart-pos.json'), 'utf8'))).toEqual({
      bad: settled('bad'),
    });
    const callbacks = observed.filter((entry) => entry.url.endsWith('/payments/kaspi/callback'));
    expect(callbacks).toHaveLength(2);
    const heartbeat = observed.find((entry) => entry.url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeat?.init?.body))).toMatchObject({ failures: ['smart_pos'] });
  });

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

  it('continues with later documents when one claimed PDF is invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-invoice-isolation-'));
    directories.push(directory);
    const validPdf = Buffer.from('%PDF-1.4\nvalid\n', 'utf8');
    const observed = stubObservedFetch(async (url, init) => {
      if (url.endsWith('/invoice-documents/claim'))
        return Response.json({
          documents: [
            ...invoiceDocumentClaim('invoice-document-bad', '0'.repeat(64)).documents,
            ...invoiceDocumentClaim(
              'invoice-document-good',
              createHash('sha256').update(validPdf).digest('hex'),
            ).documents,
          ],
        });
      if (url.endsWith('/invoice-documents/invoice-document-bad/content'))
        return pdfResponse(Buffer.from('%PDF-1.4\nbad\n', 'utf8'));
      if (url.endsWith('/invoice-documents/invoice-document-good/content'))
        return pdfResponse(validPdf);
      if (url.endsWith('/integrations/one-c/invoice-document')) {
        const eventId = new Headers(init?.headers).get('x-onec-event-id');
        return Response.json({ accepted: true, eventId });
      }
      if (url.endsWith('/invoice-documents/invoice-document-good/ack'))
        return new Response(null, { status: 204 });
      return agentPollResponse(url) ?? noCommandOrUnexpected(url);
    });

    await expect(agentFor(directory).runOnce()).resolves.toBe(2000);
    expect(
      observed.some((entry) => entry.url.endsWith('/invoice-documents/invoice-document-good/ack')),
    ).toBe(true);
    expect(
      observed.some((entry) => entry.url.endsWith('/invoice-documents/invoice-document-bad/ack')),
    ).toBe(false);
  });
});

describe('durable result isolation and storage backpressure', () => {
  it('delivers later results when an earlier result is rejected by Cloud', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-result-isolation-'));
    directories.push(directory);
    const first = 'a3f63973-d63f-4f07-8279-57300f22b409';
    const second = 'b3f63973-d63f-4f07-8279-57300f22b409';
    const result = (externalId: string) => ({
      kind: 'payroll.export',
      leaseToken: 'x'.repeat(32),
      outcome: { status: 'succeeded', response: { externalId } },
    });
    await writeFile(
      join(directory, 'pending-results.json'),
      JSON.stringify({ [first]: result('first'), [second]: result('second') }),
    );
    const observed = stubObservedFetch(async (url) => {
      if (url.endsWith(`/commands/${first}/result`)) return new Response(null, { status: 500 });
      if (url.endsWith(`/commands/${second}/result`)) return new Response(null, { status: 204 });
      return agentPollResponse(url) ?? noCommandOrUnexpected(url);
    });

    await expect(agentFor(directory).runOnce()).resolves.toBe(2000);
    expect(JSON.parse(await readFile(join(directory, 'pending-results.json'), 'utf8'))).toEqual({
      [first]: result('first'),
    });
    const heartbeat = observed.find((entry) => entry.url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeat?.init?.body))).toMatchObject({
      components: { resultDelivery: 'degraded' },
      failures: ['result_delivery'],
    });
  });

  it('reports depleted state capacity and does not claim more work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-state-limit-'));
    directories.push(directory);
    const capacityFile = join(directory, 'capacity.bin');
    await writeFile(capacityFile, '');
    await truncate(capacityFile, 100_000_000);
    const observed = stubObservedFetch(
      async (url) => agentPollResponse(url) ?? noCommandOrUnexpected(url),
    );
    const agent = new OneCAgent(
      readConfig(
        validAgentEnvironment({
          AVTOPULT_AGENT_STATE_DIR: directory,
          AVTOPULT_AGENT_MAX_STATE_BYTES: '100000000',
          AVTOPULT_AGENT_MIN_FREE_BYTES: '100000000',
        }),
      ),
    );

    await expect(agent.runOnce()).resolves.toBe(5_000);
    expect(observed.some((entry) => entry.url.endsWith('/commands/claim'))).toBe(false);
    const heartbeat = observed.find((entry) => entry.url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeat?.init?.body))).toMatchObject({
      storage: { status: 'degraded', stateBytes: '100000000' },
      components: { storage: 'degraded' },
      failures: ['agent_storage'],
    });
  });
});

describe('1C relay order isolation', () => {
  it('continues after a committed native ACK response is lost and the agent restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-committed-ack-'));
    directories.push(directory);
    const pending = new Set(['first', 'successor', 'independent']);
    const observed = stubObservedFetch(async (url, init) => {
      if (url.endsWith('/events/claim')) {
        const claim = isolatedOrderClaim(pending);
        // Model the native queue: only the first pending revision per order is leased.
        claim.events = claim.events.filter(
          ({ event }) => event.eventId !== 'successor' || !pending.has('first'),
        );
        return Response.json(claim);
      }
      if (url.endsWith('/integrations/one-c/callback')) {
        const event = JSON.parse(String(init?.body)) as { eventId: string };
        return isolationReceipt(event.eventId, 'none');
      }
      for (const id of pending) {
        if (!url.endsWith(`/events/${id}/ack`)) continue;
        // This stub models a committed 1C transaction, not execution inside 1C.
        pending.delete(id);
        if (id === 'first') throw new Error('response lost after native ACK commit');
        return new Response(null, { status: 204 });
      }
      return agentPollResponse(url) ?? noCommandOrUnexpected(url);
    });
    await agentFor(directory).runOnce();
    expect([...pending]).toEqual(['successor']);
    expectDegradedEventRelay(observed);

    await agentFor(directory).runOnce();
    expect(pending.size).toBe(0);
    const callbacks = observed
      .filter((entry) => entry.url.endsWith('/integrations/one-c/callback'))
      .map((entry) => (JSON.parse(String(entry.init?.body)) as { eventId: string }).eventId);
    expect(callbacks).toEqual(['first', 'independent', 'successor']);
    expect(observed.filter((entry) => entry.url.endsWith('/events/first/ack'))).toHaveLength(1);
    const heartbeats = observed.filter((entry) => entry.url.endsWith('/heartbeat'));
    expect(JSON.parse(String(heartbeats[1]?.init?.body))).toMatchObject({ failures: [] });
  });

  it.each(['conflict', 'unavailable', 'lost-ack', 'wrong-receipt'])(
    'blocks successors but delivers another order after %s and retries on restart',
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-isolation-'));
      directories.push(directory);
      const pending = new Set(['first', 'successor', 'independent']);
      let recovered = false;
      const observed = stubObservedFetch(async (url, init) => {
        if (url.endsWith('/events/claim')) return Response.json(isolatedOrderClaim(pending));
        if (url.endsWith('/integrations/one-c/callback')) {
          const event = JSON.parse(String(init?.body)) as { eventId: string };
          return isolationReceipt(event.eventId, recovered ? 'none' : failure);
        }
        for (const id of pending) {
          if (!url.endsWith(`/events/${id}/ack`)) continue;
          if (losesAcknowledgement(recovered, id, failure)) throw new Error('lost acknowledgement');
          pending.delete(id);
          return new Response(null, { status: 204 });
        }
        return agentPollResponse(url) ?? noCommandOrUnexpected(url);
      });
      await agentFor(directory).runOnce();
      const callbacks = () =>
        observed
          .filter((entry) => entry.url.endsWith('/integrations/one-c/callback'))
          .map((entry) => (JSON.parse(String(entry.init?.body)) as { eventId: string }).eventId);
      expect(callbacks()).toEqual(['first', 'independent']);
      expect([...pending]).toEqual(['first', 'successor']);
      expectDegradedEventRelay(observed);
      recovered = true;
      await agentFor(directory).runOnce();
      expect(callbacks()).toEqual(['first', 'independent', 'first', 'successor']);
      expect(pending.size).toBe(0);
    },
  );
});

function expectDegradedEventRelay(observed: ObservedFetch[]): void {
  const heartbeat = observed.find((entry) => entry.url.endsWith('/heartbeat'));
  expect(JSON.parse(String(heartbeat?.init?.body))).toMatchObject({ failures: ['one_c_events'] });
}

function isolationFailure(failure: string): Response | null {
  if (failure === 'conflict') return new Response(null, { status: 409 });
  if (failure === 'unavailable') return new Response(null, { status: 503 });
  if (failure === 'wrong-receipt')
    return Response.json({ accepted: true, eventId: 'other', workOrderVersion: 5 });
  return null;
}

function losesAcknowledgement(recovered: boolean, id: string, failure: string): boolean {
  return !recovered && id === 'first' && failure === 'lost-ack';
}

function isolationReceipt(eventId: string, failure: string): Response {
  if (eventId === 'first') {
    const failed = isolationFailure(failure);
    if (failed !== null) return failed;
  }
  return Response.json({
    accepted: true,
    eventId,
    workOrderVersion: eventId === 'successor' ? 6 : 5,
  });
}

function isolatedOrderClaim(pending: Set<string>) {
  const original = orderEventClaim().events[0]!;
  return {
    events: ['first', 'successor', 'independent']
      .filter((id) => pending.has(id))
      .map((id) => ({
        ...original,
        event: {
          ...original.event,
          eventId: id,
          baseVersion: id === 'successor' ? 5 : 4,
          workOrderId: id === 'independent' ? 'wo-2' : 'wo-1',
          workOrderExternalId: id === 'independent' ? 'native-2' : 'native-1',
        },
      })),
  };
}

describe('1C outbound event relay', () => {
  it('resends the original version after losing the native ACK response and restarting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-revision-restart-'));
    directories.push(directory);
    let attempts = 0;
    let claims = 0;
    const observed = stubObservedFetch(async (url) => {
      if (url.endsWith('/events/claim')) {
        const claim = orderEventClaim();
        claim.events[0]!.leaseToken = (++claims === 1 ? 'l' : 'm').repeat(32);
        return Response.json(claim);
      }
      if (url.endsWith('/integrations/one-c/callback'))
        return Response.json({ accepted: true, eventId: 'order-revision-1', workOrderVersion: 7 });
      if (url.endsWith('/events/order-revision-1/ack')) {
        attempts++;
        if (attempts === 1) throw new Error('lost ACK response');
        return new Response(null, { status: 204 });
      }
      return agentPollResponse(url) ?? noCommandOrUnexpected(url);
    });
    await agentFor(directory).runOnce();
    await agentFor(directory).runOnce();
    const acknowledgements = observed.filter((entry) =>
      entry.url.endsWith('/events/order-revision-1/ack'),
    );
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements.map((entry) => JSON.parse(String(entry.init?.body)))).toEqual([
      { leaseToken: 'l'.repeat(32), workOrderVersion: 7 },
      { leaseToken: 'm'.repeat(32), workOrderVersion: 7 },
    ]);
  });

  it('returns the durable cloud version to 1C after an order revision', async () => {
    const observed = await relayOrderVersion(7);
    const ack = observed.find((entry) => entry.url.endsWith('/events/order-revision-1/ack'));
    expect(JSON.parse(String(ack?.init?.body))).toEqual({
      leaseToken: 'l'.repeat(32),
      workOrderVersion: 7,
    });
  });

  it.each([undefined, 4])(
    'does not acknowledge an order with unusable result version %s',
    async (version) => {
      const observed = await relayOrderVersion(version);
      expect(observed.some((entry) => entry.url.endsWith('/events/order-revision-1/ack'))).toBe(
        false,
      );
      expectDegradedEventRelay(observed);
    },
  );

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

function pdfResponse(content: Buffer): Response {
  return new Response(new Uint8Array(content), {
    headers: { 'cache-control': 'private, no-store', 'content-type': 'application/pdf' },
  });
}

async function relayOrderVersion(version: number | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'avtopult-one-c-revision-'));
  directories.push(directory);
  const observed = stubObservedFetch(async (url) => {
    if (url.endsWith('/events/claim')) return Response.json(orderEventClaim());
    if (url.endsWith('/integrations/one-c/callback'))
      return Response.json({
        accepted: true,
        eventId: 'order-revision-1',
        workOrderVersion: version,
      });
    if (url.endsWith('/events/order-revision-1/ack')) return new Response(null, { status: 204 });
    return agentPollResponse(url) ?? noCommandOrUnexpected(url);
  });
  await agentFor(directory).runOnce();
  return observed;
}

function orderEventClaim() {
  return {
    events: [
      {
        leaseToken: 'l'.repeat(32),
        event: {
          event: 'workorder.changed',
          eventId: 'order-revision-1',
          workOrderId: 'wo-1',
          workOrderExternalId: 'one-c-order-1',
          baseVersion: 4,
          externalVersion: 'native-v1',
          changedAt: '2026-10-09T00:00:00Z',
          items: [],
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
