# Eventing, audit and observability

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

The currently emitted reference events are `crm.command.committed.v1` and
`crm.review.requested.v1`. The remaining lifecycle names in the registry are
reserved for the durable worker implementation and must not be claimed as
runtime evidence until C2/C4 integration tests observe them.

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

- `ask_requests_total{input_type,status,intent}`
- `ask_latency_ms{stage}` and P50/P95/P99
- `asr_empty_total`, `asr_confidence`, `intent_confidence`
- `crm_command_total{intent,status}`, `idempotency_replay_total`
- `review_open_total`, `review_age_seconds`
- `tts_success_total`, `tts_fallback_total`, `tts_latency_ms`
- `outbox_pending`, `outbox_retry_total`, `event_consumer_lag`

Initial target: 99.9% API availability, 99% CRM command success, 100% no-duplicate command under repeated key, warm voice P95 ≤8s.

## Replay and incident response

Replay starts from a request/event ID, loads immutable transcript/understanding, re-runs only the failed side-effect with the original idempotency key,
and records a new attempt. Never replay a destructive command without policy check and operator authorization. Incident artifacts include deploy digest,
trace ID, event ID, redacted request, provider status, decision and rollback action.
