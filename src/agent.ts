import {
  canonicalAgentJson,
  oneCAgentInvoiceDocumentClaimResponseSchema,
  oneCAgentODataManifestSchema,
  oneCAgentInboundAckSchema,
  oneCAgentInboundClaimResponseSchema,
  oneCAgentInboundReceiptSchema,
  oneCAgentClaimResponseSchema,
  oneCInvoiceAcceptedSchema,
  oneCPayrollExportResponseSchema,
  oneCWorkOrderUpsertResponseSchema,
  oneCWriteProblemSchema,
  type OneCAgentCommand,
  type OneCAgentInvoiceDocumentClaimResponse,
  type OneCAgentODataManifest,
  type OneCAgentResult,
} from './protocol/index.js';
import { createHash } from 'node:crypto';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';
import { ResultSpool } from './spool.js';
import { readODataOutcome } from './odata.js';
import { KaspiSmartPosClient } from './kaspi-smart-pos.js';
import { SmartPosSpool, type SmartPosPending } from './smart-pos-spool.js';
import { ODataChunkSpool } from './odata-chunk-spool.js';

type ClaimedInvoiceDocument = OneCAgentInvoiceDocumentClaimResponse['documents'][number];
type OneCWriteCommand = Exclude<
  OneCAgentCommand,
  { kind: 'odata.collection' | 'kaspi.smart-pos.start' }
>;

export class OneCAgent {
  private readonly startedAt = new Date().toISOString();
  private readonly spool: ResultSpool;
  private readonly smartPosSpool: SmartPosSpool;
  private readonly odataChunkSpool: ODataChunkSpool;
  private readonly smartPos: KaspiSmartPosClient;
  private hasPendingSmartPos = false;
  constructor(private readonly config: AgentConfig) {
    this.spool = new ResultSpool(config.stateDir);
    this.smartPosSpool = new SmartPosSpool(config.stateDir);
    this.odataChunkSpool = new ODataChunkSpool(config.stateDir);
    this.smartPos = new KaspiSmartPosClient(config);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const retryAfterMs = await this.runOnce();
        if (retryAfterMs !== undefined) await delay(retryAfterMs, signal);
      } catch {
        // Upstream validation/JSON errors may contain customer data or credentials.
        console.error(JSON.stringify({ event: 'agent_cycle_failed' }));
        await delay(2_000, signal);
      }
    }
  }

  async runOnce(): Promise<number | undefined> {
    await this.flush();
    const failures: Array<'smart_pos' | 'one_c_events' | 'one_c_documents'> = [];
    await this.runIndependent('smart_pos', failures, async () => await this.pollSmartPos());
    await this.runIndependent(
      'one_c_events',
      failures,
      async () => await this.relayInboundEvents(),
    );
    await this.runIndependent(
      'one_c_documents',
      failures,
      async () => await this.relayInvoiceDocuments(),
    );
    await this.heartbeat(failures);
    const claim = await this.claim();
    if (claim.command === null)
      return this.hasPendingSmartPos ? Math.min(claim.retryAfterMs, 1_000) : claim.retryAfterMs;
    await this.execute(claim.command);
    return undefined;
  }

  private async runIndependent(
    name: 'smart_pos' | 'one_c_events' | 'one_c_documents',
    failures: Array<'smart_pos' | 'one_c_events' | 'one_c_documents'>,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch {
      failures.push(name);
      console.error(JSON.stringify({ event: 'agent_component_degraded', component: name }));
    }
  }

  private async claim() {
    const response = await this.cloud('commands/claim', { method: 'POST' });
    if (!response.ok) throw new Error(`claim HTTP ${response.status}`);
    return oneCAgentClaimResponseSchema.parse(await json(response));
  }

  private async execute(command: OneCAgentCommand): Promise<void> {
    const pending = await this.spool.read();
    const saved = pending[command.id];
    if (saved !== undefined) {
      if (saved.kind !== command.kind) throw new Error('spooled command kind mismatch');
      pending[command.id] = { ...saved, leaseToken: command.leaseToken };
      await this.spool.write(pending);
      await this.flush();
      return;
    }
    if (command.kind === 'odata.collection') {
      await this.executeOData(command);
      return;
    }
    if (command.kind === 'kaspi.smart-pos.start') {
      await this.executeSmartPos(command);
      return;
    }
    await this.executeWrite(command);
  }

  private async executeWrite(command: OneCWriteCommand): Promise<void> {
    if (!this.config.allowWrites) {
      const pending = await this.spool.read();
      pending[command.id] = {
        kind: command.kind,
        leaseToken: command.leaseToken,
        outcome: {
          status: 'failed',
          problem: {
            contractVersion: '1.0',
            code: 'WRITES_DISABLED',
            message: 'Local administrator has not enabled writes to 1C',
            retryable: false,
          },
        },
      } as OneCAgentResult;
      await this.spool.write(pending);
      await this.flush();
      return;
    }
    const target = oneCWriteTarget(command);
    const response = await this.local(target.path, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.oneCUsername}:${this.config.oneCPassword}`).toString('base64')}`,
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json',
        'idempotency-key': command.idempotencyKey,
        'x-avtopult-contract-version': '1.0',
      },
      body: JSON.stringify(command.request),
    });
    if (response.ok && response.status !== target.expectedStatus)
      throw new Error(`1C ${command.kind} unexpected success HTTP ${response.status}`);
    const payload = await json(response);
    const outcome = response.ok
      ? { status: 'succeeded' as const, response: target.parse(payload) }
      : { status: 'failed' as const, problem: oneCWriteProblemSchema.parse(payload) };
    const result = {
      kind: command.kind,
      leaseToken: command.leaseToken,
      outcome,
    } as OneCAgentResult;
    const pending = await this.spool.read();
    pending[command.id] = result;
    await this.spool.write(pending);
    await this.flush();
  }

  private async executeOData(
    command: Extract<OneCAgentCommand, { kind: 'odata.collection' }>,
  ): Promise<void> {
    const read = await readODataOutcome(this.config, command.request);
    const chunks = await this.odataChunkSpool.read();
    if (read.chunks.length === 0) delete chunks[command.id];
    else chunks[command.id] = read.chunks.map((chunk) => [...chunk]);
    await this.odataChunkSpool.write(chunks);
    const result: OneCAgentResult = {
      kind: command.kind,
      leaseToken: command.leaseToken,
      outcome: read.outcome,
    };
    const pending = await this.spool.read();
    pending[command.id] = result;
    await this.spool.write(pending);
    await this.flush();
  }

  private async executeSmartPos(
    command: Extract<OneCAgentCommand, { kind: 'kaspi.smart-pos.start' }>,
  ): Promise<void> {
    const pending = await this.smartPosSpool.read();
    const current = pending[command.request.externalId];
    if (
      current !== undefined &&
      (current.amountTiyn !== command.request.amountTiyn ||
        current.method !== command.request.method)
    )
      throw new Error('Smart POS external id conflicts with the durable request');
    const processId =
      current?.processId ??
      (await this.smartPos.startPayment(BigInt(command.request.amountTiyn))).processId;
    if (current === undefined) {
      pending[command.request.externalId] = {
        processId,
        amountTiyn: command.request.amountTiyn,
        method: command.request.method,
        createdAt: new Date().toISOString(),
      };
      await this.smartPosSpool.write(pending);
    }
    const results = await this.spool.read();
    results[command.id] = {
      kind: command.kind,
      leaseToken: command.leaseToken,
      outcome: { status: 'succeeded', response: { processId } },
    };
    await this.spool.write(results);
    await this.flush();
  }

  private async pollSmartPos(): Promise<void> {
    if (this.config.smartPos === undefined) {
      this.hasPendingSmartPos = false;
      return;
    }
    const pending = await this.smartPosSpool.read();
    for (const [externalId, entry] of Object.entries(pending)) {
      let terminalResult;
      if (entry.settlement === undefined && !isSmartPosExpired(entry)) {
        terminalResult = await this.smartPos.status(entry.processId);
        if (terminalResult.status === 'unknown' && canActualize(entry)) {
          const lastActualizeAt = new Date().toISOString();
          pending[externalId] = { ...entry, lastActualizeAt };
          await this.smartPosSpool.write(pending);
          terminalResult = await this.smartPos.actualize(entry.processId);
        }
      }
      const settlement = entry.settlement ?? this.resolveSmartPosSettlement(entry, terminalResult);
      if (settlement === undefined) continue;
      if (entry.settlement === undefined) {
        pending[externalId] = { ...entry, settlement };
        await this.smartPosSpool.write(pending);
      }
      await this.reportSmartPos({
        externalId,
        amountTiyn: entry.amountTiyn,
        method: entry.method,
        processId: entry.processId,
        settlement,
      });
      delete pending[externalId];
      await this.smartPosSpool.write(pending);
    }
    this.hasPendingSmartPos = Object.keys(pending).length > 0;
  }

  private resolveSmartPosSettlement(
    entry: SmartPosPending[string],
    terminalResult: Awaited<ReturnType<KaspiSmartPosClient['status']>> | undefined,
  ) {
    if (isSmartPosExpired(entry)) return { status: 'expired' as const };
    if (terminalResult === undefined || ['wait', 'unknown'].includes(terminalResult.status))
      return undefined;
    if (terminalResult.status !== 'success') return { status: 'failed' as const };
    return {
      status: 'paid' as const,
      paidAt: new Date().toISOString(),
      actualMethod: terminalResult.method,
      transactionId: terminalResult.transactionId,
      ...(terminalResult.terminalId === undefined ? {} : { terminalId: terminalResult.terminalId }),
      ...(terminalResult.cardMask === undefined
        ? {}
        : { cardMask: lastFour(terminalResult.cardMask) }),
      ...(terminalResult.rrn === undefined ? {} : { rrn: terminalResult.rrn }),
    };
  }

  private async reportSmartPos(input: {
    readonly externalId: string;
    readonly amountTiyn: string;
    readonly method: 'kaspi_qr' | 'card_terminal';
    readonly processId: string;
    readonly settlement: NonNullable<SmartPosPending[string]['settlement']>;
  }): Promise<void> {
    const smartPos = this.config.smartPos;
    if (smartPos === undefined) return;
    const callbackUrl =
      input.method === 'kaspi_qr' ? smartPos.callbackUrl : smartPos.terminalCallbackUrl;
    const response = await boundedFetch(this.config, callbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kaspi-secret': smartPos.callbackSecret,
        accept: 'application/json',
      },
      body: JSON.stringify({
        eventId: `smart-pos:${input.processId}:${input.settlement.status}`,
        externalId: input.externalId,
        amountTiyn: input.amountTiyn,
        ...input.settlement,
        ...(input.settlement.status === 'paid'
          ? {}
          : { errorCode: `SMART_POS_${input.settlement.status.toUpperCase()}` }),
      }),
    });
    if (!response.ok) throw new Error(`Kaspi callback HTTP ${response.status}`);
  }

  private async relayInboundEvents(): Promise<void> {
    const response = await this.local('events/claim', { method: 'POST' });
    if (response.status !== 200) throw new Error(`1C event claim HTTP ${response.status}`);
    const claimed = oneCAgentInboundClaimResponseSchema.parse(await json(response));
    for (const claimedEvent of claimed.events) {
      const receipt = await this.cloud(this.config.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: jsonBody(claimedEvent.event),
      });
      if (!receipt.ok) throw new Error(`1C callback HTTP ${receipt.status}`);
      const accepted = oneCAgentInboundReceiptSchema.parse(await json(receipt));
      if (accepted.eventId !== claimedEvent.event.eventId)
        throw new Error('1C callback receipt event id mismatch');
      const acknowledgement = await this.local(
        `events/${encodeURIComponent(claimedEvent.event.eventId)}/ack`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(
            oneCAgentInboundAckSchema.parse({ leaseToken: claimedEvent.leaseToken }),
          ),
        },
      );
      if (acknowledgement.status !== 204)
        throw new Error(`1C event acknowledgement HTTP ${acknowledgement.status}`);
    }
  }

  private async relayInvoiceDocuments(): Promise<void> {
    const response = await this.local('invoice-documents/claim', { method: 'POST' });
    if (response.status !== 200)
      throw new Error(`1C invoice document claim HTTP ${response.status}`);
    const claimed = oneCAgentInvoiceDocumentClaimResponseSchema.parse(await json(response));
    for (const claimedDocument of claimed.documents)
      await this.relayInvoiceDocument(claimedDocument);
  }

  private async relayInvoiceDocument(claimedDocument: ClaimedInvoiceDocument): Promise<void> {
    const eventId = claimedDocument.upload.eventId;
    const content = await this.readInvoiceDocument(eventId, claimedDocument.leaseToken);
    this.assertInvoiceDocumentHash(content, claimedDocument.upload.documentSha256);
    await this.sendInvoiceDocument(claimedDocument.upload, content);
    await this.acknowledgeLocalInvoiceDocument(eventId, claimedDocument.leaseToken);
  }

  private async readInvoiceDocument(eventId: string, leaseToken: string): Promise<Buffer> {
    const response = await this.local(`invoice-documents/${encodeURIComponent(eventId)}/content`, {
      method: 'GET',
      headers: { accept: 'application/pdf', 'x-avtopult-lease-token': leaseToken },
    });
    if (response.status !== 200)
      throw new Error(`1C invoice document content HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.startsWith('application/pdf'))
      throw new Error('1C invoice document content type invalid');
    if (response.headers.get('cache-control') !== 'private, no-store')
      throw new Error('1C invoice document cache policy invalid');
    const content = Buffer.from(await response.arrayBuffer());
    if (!content.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new Error('1C invoice document signature invalid');
    return content;
  }

  private assertInvoiceDocumentHash(content: Buffer, expected: string): void {
    if (createHash('sha256').update(content).digest('hex') !== expected)
      throw new Error('1C invoice document SHA-256 mismatch');
  }

  private async sendInvoiceDocument(
    upload: ClaimedInvoiceDocument['upload'],
    content: Buffer,
  ): Promise<void> {
    const receipt = await this.cloud(new URL('invoice-document', this.config.callbackUrl), {
      method: 'POST',
      headers: invoiceDocumentHeaders(upload),
      body: new Uint8Array(content),
    });
    if (!receipt.ok) throw new Error(`1C invoice document callback HTTP ${receipt.status}`);
    const accepted = oneCAgentInboundReceiptSchema.parse(await json(receipt));
    if (accepted.eventId !== upload.eventId)
      throw new Error('1C invoice document receipt event id mismatch');
  }

  private async acknowledgeLocalInvoiceDocument(
    eventId: string,
    leaseToken: string,
  ): Promise<void> {
    const acknowledgement = await this.local(
      `invoice-documents/${encodeURIComponent(eventId)}/ack`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(oneCAgentInboundAckSchema.parse({ leaseToken })),
      },
    );
    if (acknowledgement.status !== 204)
      throw new Error(`1C invoice document acknowledgement HTTP ${acknowledgement.status}`);
  }

  private async flush(): Promise<void> {
    const pending = await this.spool.read();
    const odataChunks = await this.odataChunkSpool.read();
    for (const [id, result] of Object.entries(pending)) {
      if (!(await this.flushODataChunks(id, result, odataChunks[id]))) continue;
      const response = await this.cloud(`commands/${encodeURIComponent(id)}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.avtopult.onec-agent+json' },
        body: JSON.stringify(result),
      });
      // Keep the durable result for re-claim/reconciliation, but do not starve other commands.
      if (response.status === 409) continue;
      if (!response.ok && response.status !== 204)
        throw new Error(`result HTTP ${response.status}`);
      delete pending[id];
      await this.spool.write(pending);
      if (odataChunks[id] !== undefined) {
        delete odataChunks[id];
        await this.odataChunkSpool.write(odataChunks);
      }
    }
  }

  private async flushODataChunks(
    id: string,
    result: OneCAgentResult,
    chunks: unknown[][] | undefined,
  ): Promise<boolean> {
    const manifest = odataManifest(result);
    if (manifest === undefined) return true;
    if (chunks === undefined || chunks.length !== manifest.chunkCount)
      throw new Error('OData chunk spool does not match its result manifest');
    for (const [index, values] of chunks.entries()) {
      const response = await this.cloud(
        `commands/${encodeURIComponent(id)}/odata-chunks/${String(index)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/vnd.avtopult.onec-agent+json' },
          body: JSON.stringify({
            leaseToken: result.leaseToken,
            index,
            values,
            sha256: createHash('sha256').update(canonicalAgentJson(values)).digest('hex'),
          }),
        },
      );
      if (response.status === 409) return false;
      if (!response.ok && response.status !== 204)
        throw new Error(`OData chunk HTTP ${response.status}`);
    }
    return true;
  }

  private async heartbeat(
    failures: readonly ('smart_pos' | 'one_c_events' | 'one_c_documents')[],
  ): Promise<void> {
    const pending = await this.spool.read();
    const response = await this.cloud('heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: this.config.agentId,
        version: '0.1.0',
        startedAt: this.startedAt,
        pendingResults: Object.keys(pending).length,
        components: {
          smartPos:
            this.config.smartPos === undefined
              ? 'disabled'
              : failures.includes('smart_pos')
                ? 'degraded'
                : 'ok',
          oneCEvents: failures.includes('one_c_events') ? 'degraded' : 'ok',
          oneCDocuments: failures.includes('one_c_documents') ? 'degraded' : 'ok',
        },
        failures,
      }),
    });
    if (!response.ok && response.status !== 204)
      throw new Error(`heartbeat HTTP ${response.status}`);
  }

  private async cloud(path: string | URL, init: RequestInit): Promise<Response> {
    const url = path instanceof URL ? path : new URL(path, this.config.cloudUrl);
    return await boundedFetch(this.config, url, {
      ...init,
      headers: { ...init.headers, 'x-onec-secret': this.config.secret, accept: 'application/json' },
    });
  }

  private async local(path: string, init: RequestInit): Promise<Response> {
    const response = await boundedFetch(this.config, new URL(path, this.config.oneCUrl), {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.oneCUsername}:${this.config.oneCPassword}`).toString('base64')}`,
        accept: 'application/json',
        'x-avtopult-contract-version': '1.0',
        ...init.headers,
      },
    });
    if (response.headers.get('x-avtopult-contract-version') !== '1.0')
      throw new Error('1C contract version response missing or unsupported');
    return response;
  }
}

function oneCWriteTarget(command: OneCWriteCommand): {
  readonly path: string;
  readonly expectedStatus: number;
  readonly parse: (payload: unknown) => unknown;
} {
  switch (command.kind) {
    case 'work-order.upsert':
      return {
        path: 'work-orders',
        expectedStatus: 200,
        parse: oneCWorkOrderUpsertResponseSchema.parse,
      };
    case 'invoice.request':
      return { path: 'invoices', expectedStatus: 202, parse: oneCInvoiceAcceptedSchema.parse };
    case 'payroll.export':
      return {
        path: 'payroll-periods',
        expectedStatus: 200,
        parse: oneCPayrollExportResponseSchema.parse,
      };
  }
}

function isSmartPosExpired(entry: SmartPosPending[string]): boolean {
  return Date.now() - new Date(entry.createdAt).getTime() >= 24 * 60 * 60 * 1_000;
}

function canActualize(entry: SmartPosPending[string]): boolean {
  return (
    entry.lastActualizeAt === undefined ||
    Date.now() - new Date(entry.lastActualizeAt).getTime() >= 10_000
  );
}

function odataManifest(result: OneCAgentResult): OneCAgentODataManifest | undefined {
  if (result.kind !== 'odata.collection' || result.outcome.status !== 'succeeded') return undefined;
  const parsed = oneCAgentODataManifestSchema.safeParse(result.outcome.response);
  return parsed.success ? parsed.data : undefined;
}

function lastFour(mask: string): string {
  const digits = mask.replace(/\D/g, '');
  if (digits.length < 4) throw new Error('Smart POS returned invalid card mask');
  return digits.slice(-4);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    typeof current === 'bigint' ? current.toString() : current,
  );
}

function invoiceDocumentHeaders(upload: {
  readonly eventId: string;
  readonly workOrderExternalId: string;
  readonly requestAttempt: number;
  readonly invoiceExternalId: string;
  readonly invoiceNumber: string;
  readonly issuedAt: string;
  readonly amountTiyn: bigint;
  readonly documentSha256: string;
}): Record<string, string> {
  return {
    'content-type': 'application/pdf',
    'x-onec-event-id': upload.eventId,
    'x-onec-work-order-id': upload.workOrderExternalId,
    'x-onec-request-attempt': String(upload.requestAttempt),
    'x-onec-invoice-id': upload.invoiceExternalId,
    'x-onec-invoice-number': upload.invoiceNumber,
    'x-onec-issued-at': upload.issuedAt,
    'x-onec-amount-tiyn': upload.amountTiyn.toString(),
    'x-content-sha256': upload.documentSha256,
  };
}
