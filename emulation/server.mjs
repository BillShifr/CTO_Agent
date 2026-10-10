import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';

const agentId = 'emulated-agent';
const agentSecret = 'emulated-agent-secret-000000000000';
const commandId = 'a3f63973-d63f-4f07-8279-57300f22b409';
let claimed = false;
let heartbeat = false;
let invoiceCalls = 0;
let result;

const json = (response, status, body) => {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.length),
    'x-avtopult-contract-version': '1.0',
  });
  response.end(encoded);
};

const cloud = createHttpsServer(
  { key: readFileSync('/certs/emulator.key'), cert: readFileSync('/certs/emulator.crt') },
  async (request, response) => {
    const body = await readBody(request);
    console.log(JSON.stringify({ side: 'cloud', method: request.method, url: request.url }));
    if (!authorizedAgent(request)) return json(response, 401, { error: 'unauthorized' });
    if (
      request.method === 'GET' &&
      request.url === '/api/v1/integrations/one-c/agent/v1/diagnostics'
    )
      return json(response, 200, { ok: true });
    if (request.method === 'GET' && request.url === '/acceptance')
      return json(response, 200, {
        ok: heartbeat && invoiceCalls === 1 && result !== undefined,
        heartbeat,
        invoiceCalls,
        result,
      });
    if (
      request.method === 'POST' &&
      request.url === '/api/v1/integrations/one-c/agent/v1/heartbeat'
    ) {
      heartbeat = JSON.parse(body).agentId === agentId;
      response.writeHead(204).end();
      return;
    }
    if (
      request.method === 'POST' &&
      request.url === '/api/v1/integrations/one-c/agent/v1/commands/claim'
    ) {
      if (claimed) return json(response, 200, { command: null, retryAfterMs: 1000 });
      claimed = true;
      return json(response, 200, {
        retryAfterMs: 250,
        command: {
          id: commandId,
          kind: 'invoice.request',
          idempotencyKey: 'outbox:emulation-1',
          leaseToken: 'l'.repeat(32),
          leaseUntil: '2099-01-01T00:00:00.000Z',
          request: {
            contractVersion: '1.0',
            workOrderExternalId: 'wo-emulated',
            amountTiyn: '50000',
            requestAttempt: 1,
          },
        },
      });
    }
    if (
      request.method === 'POST' &&
      request.url === `/api/v1/integrations/one-c/agent/v1/commands/${commandId}/result`
    ) {
      result = JSON.parse(body);
      response.writeHead(204).end();
      return;
    }
    json(response, 404, { error: 'not_found' });
  },
);

const oneC = createHttpServer(async (request, response) => {
  const body = await readBody(request);
  console.log(JSON.stringify({ side: 'one-c', method: request.method, url: request.url }));
  if (!authorizedOneC(request)) return json(response, 401, { error: 'unauthorized' });
  if (request.method === 'GET' && request.url === '/infobase/hs/avtopult/v1/diagnostics')
    return json(response, 200, { ok: true });
  if (request.method === 'GET' && request.url === '/infobase/odata/standard.odata/$metadata') {
    response.writeHead(200, { 'content-type': 'application/xml' }).end('<metadata/>');
    return;
  }
  if (request.method === 'POST' && request.url === '/infobase/hs/avtopult/v1/events/claim')
    return json(response, 200, { events: [] });
  if (
    request.method === 'POST' &&
    request.url === '/infobase/hs/avtopult/v1/invoice-documents/claim'
  )
    return json(response, 200, { documents: [] });
  if (request.method === 'POST' && request.url === '/infobase/hs/avtopult/v1/invoices') {
    invoiceCalls += 1;
    if (JSON.parse(body).contractVersion !== '1.0')
      return json(response, 400, { error: 'invalid_contract' });
    return json(response, 202, {
      contractVersion: '1.0',
      requestId: 'invoice-emulated',
      status: 'accepted',
    });
  }
  json(response, 404, { error: 'not_found' });
});

cloud.listen(8443, '0.0.0.0');
oneC.listen(8080, '0.0.0.0');

function authorizedAgent(request) {
  if (request.url === '/acceptance') return true;
  return (
    request.headers['x-onec-agent-id'] === agentId &&
    request.headers['x-onec-secret'] === agentSecret
  );
}

function authorizedOneC(request) {
  const expected = `Basic ${Buffer.from('avtopult-writer:emulated-write-password').toString('base64')}`;
  const odata = `Basic ${Buffer.from('avtopult-reader:emulated-read-password').toString('base64')}`;
  return request.headers.authorization === expected || request.headers.authorization === odata;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
