import {
  oneCAgentClaimResponseSchema,
  oneCInvoiceAcceptedSchema,
  oneCWorkOrderUpsertResponseSchema,
  oneCWriteProblemSchema,
  type OneCAgentCommand,
  type OneCAgentResult,
} from './protocol/index.js';
import type { AgentConfig } from './config.js';
import { boundedFetch, json } from './http.js';
import { ResultSpool } from './spool.js';
import { readODataOutcome } from './odata.js';

export class OneCAgent {
  private readonly startedAt = new Date().toISOString();
  private readonly spool: ResultSpool;
  constructor(private readonly config: AgentConfig) {
    this.spool = new ResultSpool(config.stateDir);
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
    await this.heartbeat();
    const claim = await this.claim();
    if (claim.command === null) return claim.retryAfterMs;
    await this.execute(claim.command);
    return undefined;
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
    const path = command.kind === 'work-order.upsert' ? 'work-orders' : 'invoices';
    // Enabling transport must not implicitly enable changes to the customer's database.
    if (!this.config.allowWrites) {
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
      };
      await this.spool.write(pending);
      await this.flush();
      return;
    }
    const response = await boundedFetch(this.config, new URL(path, this.config.oneCUrl), {
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
    const payload = await json(response);
    const outcome = response.ok
      ? {
          status: 'succeeded' as const,
          response:
            command.kind === 'work-order.upsert'
              ? oneCWorkOrderUpsertResponseSchema.parse(payload)
              : oneCInvoiceAcceptedSchema.parse(payload),
        }
      : { status: 'failed' as const, problem: oneCWriteProblemSchema.parse(payload) };
    const result = {
      kind: command.kind,
      leaseToken: command.leaseToken,
      outcome,
    } as OneCAgentResult;
    pending[command.id] = result;
    await this.spool.write(pending);
    await this.flush();
  }

  private async executeOData(
    command: Extract<OneCAgentCommand, { kind: 'odata.collection' }>,
  ): Promise<void> {
    const result: OneCAgentResult = {
      kind: command.kind,
      leaseToken: command.leaseToken,
      outcome: await readODataOutcome(this.config, command.request),
    };
    const pending = await this.spool.read();
    pending[command.id] = result;
    await this.spool.write(pending);
    await this.flush();
  }

  private async flush(): Promise<void> {
    const pending = await this.spool.read();
    for (const [id, result] of Object.entries(pending)) {
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
    }
  }

  private async heartbeat(): Promise<void> {
    const pending = await this.spool.read();
    const response = await this.cloud('heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: this.config.agentId,
        version: '0.1.0',
        startedAt: this.startedAt,
        pendingResults: Object.keys(pending).length,
      }),
    });
    if (!response.ok && response.status !== 204)
      throw new Error(`heartbeat HTTP ${response.status}`);
  }

  private async cloud(path: string, init: RequestInit): Promise<Response> {
    return await boundedFetch(this.config, new URL(path, this.config.cloudUrl), {
      ...init,
      headers: { ...init.headers, 'x-onec-secret': this.config.secret, accept: 'application/json' },
    });
  }
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
