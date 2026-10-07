# 1C write API v1: deployment and acceptance

This runbook is the release contract between AvtoPult and the 1C extension installed into the
customer infobase. A deployment is not production-ready until every acceptance case below passes
against the copied infobase and the approved production gateway.

## Network boundary

The 1C HTTP service stays on localhost or the customer's LAN. The Windows Integration Agent opens
outbound HTTPS to AvtoPult, pulls commands and calls only `/hs/avtopult/v1/` plus the configured
read-only OData endpoint locally. The Agent is installed on the 1C server or in the same trusted
LAN with direct access to these local endpoints. No inbound Internet route, VPN or remote-network
bridge to 1C is part of the production data path. OData read credentials, write credentials and
the agent callback secret are different values.

Production must not expose the 1C web client, standard OData or the native 1C HTTP port directly
to the Internet.

The server component must be delivered as a configuration extension so the vendor configuration
is not edited directly. After attaching it, the local web publication must explicitly enable HTTP
services from extensions (`publishExtensionsByDefault`) and expose the service only to the agent
host/LAN, never to the public Internet.

## Common protocol

- Base path: `/hs/avtopult/v1/`.
- Request and response header: `X-AvtoPult-Contract-Version: 1.0`.
- Mutation header: `Idempotency-Key: outbox:<uuid>`.
- Authentication: HTTP Basic over verified TLS, using the dedicated write-only account.
- Encoding: UTF-8 JSON; money is a canonical non-negative decimal string in tiyn.
- Redirects are forbidden.
- Maximum JSON response: 1 MiB; maximum PDF: 10 MiB.
- The idempotency ledger is durable 1C data, not process memory. It stores the key, operation,
  request hash, response body and completion time in the same transaction as the business effect.
- Repeating the same key and identical body returns the exact stored status and response body.
  Domain-level replay of an equal work-order version or invoice attempt may return
  `result/status = replayed`. Repeating a key with another body returns
  `409 IDEMPOTENCY_CONFLICT`.

## Local 1C outbox for the Agent

The extension must not call Cloud directly and must not require a VPN as a data path. It keeps
Cloud-bound data in a durable 1С outbox and
implements these local, Basic-authenticated endpoints:

| Endpoint                                  | Result                                                   | Rule                                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST events/claim`                       | `{ "events": [{ "leaseToken", "event" }] }` (max 50)     | Atomically lease one JSON event. Supported events are `invoice.error`, `invoice.paid`, `invoice.payment`, `invoice.refund`, `cash.payment`, `cash.refund`, `payment.refund`, `workorder.ack` and `workorder.changed`. |
| `POST events/<eventId>/ack`               | `204`                                                    | Mark event delivered only if the unexpired lease token matches.                                                                                                                                                       |
| `POST invoice-documents/claim`            | `{ "documents": [{ "leaseToken", "upload" }] }` (max 10) | Atomically lease one invoice upload metadata record.                                                                                                                                                                  |
| `GET invoice-documents/<eventId>/content` | PDF bytes                                                | Return the original PDF only for the current lease; require `X-AvtoPult-Lease-Token`.                                                                                                                                 |
| `POST invoice-documents/<eventId>/ack`    | `204`                                                    | Mark document delivered only if the unexpired lease token matches.                                                                                                                                                    |

The Agent calls the Cloud callback using the connection secret, and only then acknowledges the
local row. It verifies that the Cloud receipt has the same `eventId`; for PDFs it also verifies
the received bytes against `documentSha256`. On timeout, crash or any non-2xx response it sends
no acknowledgement. The lease must expire, so the same immutable event can be retried. Cloud
deduplicates by `eventId`; 1С must never make a second business document while retrying delivery.

`invoice.issued` with a Cloud-reachable `documentUrl` is the legacy direct/VPN path. For the
outbound-only Agent path, enqueue the PDF metadata defined by `oneCInvoiceDocumentUploadSchema`
instead; the Agent sends it to `/integrations/one-c/invoice-document`, which creates the same
`invoice.issued` business effect atomically with document storage.

## `POST work-orders`

The body is validated by `oneCWorkOrderUpsertRequestSchema`. The service must:

1. Resolve the organization, subdivision, warehouse and agreement from installation settings.
2. Resolve or create a person by the approved phone/IIN rule, or a legal entity by BIN. Fuzzy
   name matching is forbidden.
3. Resolve or create the vehicle by VIN, otherwise by normalized registration number within the
   resolved client.
4. Resolve every item only by its supplied 1C `externalId`; a missing mapping is a terminal error.
5. Create or update `Document_ЗаказКлиента`, including its `Автомобиль` attribute and `Товары`
   rows, in one 1C transaction.
6. Reject a request version lower than the stored AvtoPult version with `409 STALE_VERSION` and
   `currentVersion`. Equal version with the same canonical payload is an idempotent replay. Equal
   version with another payload is `409 VERSION_PAYLOAD_CONFLICT`.
7. Return the stable 1C GUID and the applied AvtoPult version. The extension must keep the
   AvtoPult work-order ID and version in extension-owned attributes/registers; document number is
   never used as identity.

Canonical request:

```json
{
  "contractVersion": "1.0",
  "workOrder": {
    "workOrderId": "11111111-1111-4111-8111-111111111111",
    "number": "WO-000042",
    "version": 7,
    "stationExternalId": "22222222-2222-4222-8222-222222222222",
    "client": {
      "type": "legal_entity",
      "legalName": "Example LLP",
      "bin": "000000000000",
      "legalAddress": "Sanitized address",
      "iban": "KZ000000000000000000",
      "bik": "EXAMPLE",
      "kbe": "17"
    },
    "vehicle": {
      "vin": "SANITIZEDVIN00001",
      "registrationNumber": "000AAA00",
      "brand": "Toyota",
      "model": "Camry"
    },
    "items": [
      {
        "itemId": "33333333-3333-4333-8333-333333333333",
        "externalId": "44444444-4444-4444-8444-444444444444",
        "type": "service",
        "name": "Sanitized service",
        "quantity": 1,
        "priceTiyn": "2340000",
        "normHours": 1.5
      }
    ],
    "totalTiyn": "2340000",
    "status": "created"
  }
}
```

Successful response:

```json
{
  "contractVersion": "1.0",
  "externalId": "55555555-5555-4555-8555-555555555555",
  "version": 7,
  "result": "created"
}
```

## `POST invoices`

The body is validated by `oneCInvoiceRequestSchema`. The service must atomically create or locate
the invoice for the supplied work-order GUID and request attempt, enqueue generation of its print
form, and return `202` with `oneCInvoiceAcceptedSchema`. The same request attempt cannot produce a
second active invoice.

Canonical request and immediate response:

```json
{
  "contractVersion": "1.0",
  "workOrderExternalId": "55555555-5555-4555-8555-555555555555",
  "amountTiyn": "2340000",
  "requestAttempt": 1
}
```

```json
{
  "contractVersion": "1.0",
  "requestId": "invoice-request-000042-1",
  "status": "accepted"
}
```

After completion, 1C sends exactly one canonical callback to AvtoPult:

- `invoice.issued` with number, GUID, amount, timestamp and a gateway URL under
  `/hs/avtopult/v1/invoices/<guid>/pdf`; or
- `invoice.error` with the same `workOrderExternalId` and `requestAttempt`.

For an outbound-only customer network, place the PDF and its metadata in the local outbox above.
The Agent sends `POST /api/v1/integrations/one-c/invoice-document` with
`Content-Type: application/pdf` and the headers `X-Onec-Secret`, `X-Onec-Event-Id`,
`X-Onec-Work-Order-Id`, `X-Onec-Request-Attempt`, `X-Onec-Invoice-Id`,
`X-Onec-Invoice-Number`, `X-Onec-Issued-At`, `X-Onec-Amount-Tiyn`, and
`X-Content-Sha256`. The SHA-256 is lowercase hexadecimal. AvtoPult never opens a reverse
connection to the customer network to download a short-lived document URL.

The callback uses the dedicated `callback.secretRef`, not the OData or write password. Retrying a
callback preserves `eventId`.

## Reverse work-order changes

1C sends `workorder.changed` with stable `workOrderId`, 1C GUID, local `baseVersion`, durable
`externalVersion`, and either a full item snapshot, a workflow transition, or both. AvtoPult locks
the order and accepts the event only when `baseVersion` equals the current local version. Every
transition is executed through the same state machine as the UI; 1C cannot assign a status
directly. A legal-entity item snapshot is rejected after invoice creation. Rejected callbacks are
recorded as failed inbound `SyncJob` rows with the exact conflict reason and can be replayed only
after reconciliation with a new event ID/version.

Every item contains the stable AvtoPult line `itemId` and the 1C catalog `externalId`. The latter
is resolved through the connection-scoped `ExternalReference`; accepting an AvtoPult database ID
from 1C is forbidden. Missing mappings are terminal conflicts. For product snapshots AvtoPult
atomically reserves new lines, adjusts changed quantities and releases removed lines before the
order update commits.

## Payments and refunds

- `cash.payment` records a posted cash receipt for an individual work order using stable
  `paymentExternalId`, `workOrderExternalId`, UTC `occurredAt`, positive `amountTiyn` and
  `eventId`. `cash.refund` uses `refundExternalId` with the same envelope. These use the
  existing authenticated callback and durable replay path; the 1C adapter must actually
  emit/deliver them. Choosing cash in the kiosk does not create a confirmed receipt.
  Cash refunds cannot consume card/invoice money. Full coverage changes workflow once;
  refunds never rewind completed work. Test the actual 1C cashier before production.
- `invoice.payment` records one partial or final payment using a stable `paymentExternalId`.
- `invoice.refund` records a financial correction using a stable `refundExternalId`.
- `payment.refund` records a QR or terminal return already completed by the cashier. It carries
  `method` (`kaspi_qr` or `card_terminal`), the original `paymentExternalId`, a distinct
  `refundExternalId`, UTC `occurredAt`, positive `amountTiyn` and `eventId`. AvtoPult accepts it
  only when the original payment is confirmed and the net refundable amount for that method is
  sufficient. It never asks Smart POS to issue the return.
- Net coverage is confirmed payments minus refunds and may never be negative or exceed the
  invoice amount.
- Only full net coverage runs the paid workflow transition. A later refund never rewinds work
  already performed; it remains an audited financial correction requiring an explicit operational
  decision if the vehicle/work must also be rolled back.

## Warehouse and reservation ownership

AvtoPult owns the operational reservation required by the product specification: adding a product
line reserves it in AvtoPult, removal/cancellation releases it, and completion consumes it. 1C is
the accounting stock source and must mirror the order/reservation, but the extension must not
create a second independent reservation for the same line. `stationExternalId` is a station
identity; one or more 1C warehouse GUIDs are mapped explicitly to local warehouse IDs. Missing or
ambiguous mappings are terminal conflicts, never a fallback to a station ID.

## `GET invoices/<guid>/pdf`

The service returns only a generated invoice associated with the authenticated integration and
the expected work order. Required response properties:

- `200`;
- `Content-Type: application/pdf`;
- body starts with `%PDF-` and is no larger than 10 MiB;
- `Cache-Control: private, no-store`;
- no redirect to another origin.

## Error envelope

Every non-2xx response is `application/json` and follows `oneCWriteProblemSchema`:

```json
{
  "contractVersion": "1.0",
  "code": "CATALOG_MAPPING_MISSING",
  "message": "Item service-1 is not mapped",
  "retryable": false
}
```

`retryable=false` goes directly to the AvtoPult DLQ. Only temporary lock, timeout, gateway
overload and unavailable dependency errors are retryable. Validation, missing mapping, stale
version, duplicate identity and forbidden business operation errors are terminal.

## Required acceptance evidence

The release bundle must contain sanitized request/response fixtures and logs proving:

1. create a work order, then update the same GUID with the next version;
2. replay both requests after the response is deliberately dropped; no duplicate document;
3. reject the same idempotency key with a changed body;
4. reject stale version and a missing catalog mapping without retry;
5. resolve person, legal entity and vehicle using the approved deterministic rules;
6. create one invoice, replay its request and receive one `invoice.issued` callback;
7. download a valid PDF, reject wrong MIME, oversized content and foreign origin;
8. process partial payment, full payment and full refund with stable event IDs;
9. restart 1C and the Windows gateway between request and replay without losing idempotency;
10. interrupt/reconnect the actual Agent-to-1C transport and Cloud HTTPS separately; demonstrate
    that JSON events and PDF invoices remain in the 1С outbox, reappear after lease expiry and
    create one Cloud effect after replay, plus heartbeat alerting.

No production credentials, personal data, real document GUIDs or complete PDFs may be included in
the evidence bundle.
