---
title: Eventing, audit and observability
description: CloudEvents-compatible envelopes, audit records, trace correlation, service indicators, replay, and incident evidence.
docId: crm.events-audit
locale: en
audience: both
contentVersion: 0.1.0
---

## Event envelope

Events follow a CloudEvents 1.0-compatible shape. `contracts/events.yaml` is normative; the in-memory reference store emits the same envelope so contract tests exercise the actual boundary:

```json
{
  "specversion": "1.0",
  "id": "evt_01J",
  "type": "crm.command.committed.v1",
  "source": "urn:sumi:voice-crm/crm",
  "subject": "deal/d1",
  "time": "2026-08-14T01:02:03Z",
  "datacontenttype": "application/json",
  "tenant_id": "tenant_demo",
  "request_id": "req_01J",
  "traceparent": "00-...",
  "data": {"aggregate_version": 18}
}
```

`id` is the deduplication key. `subject + aggregate_version` provides ordering; consumers reject a gap and re-read the aggregate rather than guessing state.

The runtime emits `crm.command.committed.v1`, `crm.review.requested.v1`, and `tts.asset.created.v1` into the same PostgreSQL transaction as the corresponding durable state. `src/outbox-worker.mjs` delivers leased rows as structured CloudEvents with an event-ID idempotency header and optional bearer plus required production HMAC authentication.

## Audit trail

Audit records are append-only and cover:

- authentication and authorization decisions;
- input receipt, transcript and model version;
- intent proposal, confidence and policy decision;
- CRM command before/after hashes and aggregate version;
- review approval/rejection and corrections;
- TTS asset creation, access and expiry;
- provider failures, retries, circuit changes and operator actions.

Audit messages are redacted. Full customer text/audio belongs in encrypted stores with retention controls, not logs.

## Trace model

One trace per ask: `gateway.receive → media.persist → asr.transcribe → intent.extract → policy.evaluate → crm.command → outbox.append → answer.compose → tts.synthesize`.
Required attributes: `sumi.request_id`, `sumi.tenant_id` (non-PII opaque ID), `sumi.actor_id` (opaque), `sumi.provider`, `sumi.model`,
`sumi.schema_version`, `sumi.idempotency_hit`, `sumi.aggregate_version`, `error.type`. Never attach raw transcript, token, phone, key or audio bytes.

## Metrics and SLOs

- `sumi_http_requests_total{method,route,status}`
- `sumi_http_request_duration_seconds` summary, with IDs normalized out of route labels
- `asr_empty_total`, `asr_confidence`, `intent_confidence`
- `crm_command_total{intent,status}`, `idempotency_replay_total`
- `review_open_total`, `review_age_seconds`
- `tts_success_total`, `tts_fallback_total`, `tts_latency_ms`
- `outbox_pending`, `outbox_retry_total`, `event_consumer_lag`

`GET /metrics` exposes the implemented HTTP metrics and requires `METRICS_BEARER_TOKEN` when configured; production startup requires it. Explicit application/provider/storage/transaction spans are available in manual mode and can be exported through the opt-in OTLP adapter; durable audit/outbox trace propagation and provider/queue metric families remain C4 work rather than current claims.

## Replay and incident response

Replay starts from a request/event ID, loads immutable transcript/understanding, re-runs only the failed side-effect with the original idempotency key,
and records a new attempt. Never replay a destructive command without policy check and operator authorization. Incident artifacts include deploy digest,
trace ID, event ID, redacted request, provider status, decision and rollback action.
