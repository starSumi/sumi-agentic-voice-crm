---
title: Operations runbook
description: Health signals, common voice and CRM incidents, safe operator actions, and evidence-preserving recovery steps.
docId: crm.operations
locale: en
audience: both
contentVersion: 0.1.0
---

## Health

- `/health/live`: process only.
- `/health/ready`: database migration, object store and provider capability readiness.
- `/metrics`: Prometheus request count and latency; production requires `Authorization: Bearer <METRICS_BEARER_TOKEN>`.
- `/v1/events`: reference-only diagnostic view; production requires authenticated operator scope and pagination.

Run the API and relay as separate processes from the same immutable artifact: `npm start` and `npm run start:outbox`. Relay instances use database leases, HMAC-sign each CloudEvent, retain idempotency by event ID, retry with bounded backoff, and move exhausted rows to dead letter for operator review.

## Common incidents

| Symptom | First checks | Safe action |
| --- | --- | --- |
| `ASR_TIMEOUT` | provider latency, queue, model load, trace | retry same request/idempotency key; preserve media |
| `EMPTY_TRANSCRIPT` | audio bytes/duration/codec, microphone | ask user to record again; no CRM write |
| `needs_review` spike | intent model version, locale WER, entity resolver | pause risky command rollout; inspect redacted samples |
| duplicate CRM | idempotency store/outbox uniqueness | stop consumer, replay by key, never manual duplicate insert |
| TTS failure | provider health/voice capability | keep text response; retry TTS job |
| event lag | relay lease/dead-letter/DB | scale relay; preserve order and deduplicate |

Every incident gets a timeline, affected tenant scope, trace/event IDs, decision, remediation and follow-up checkpoint.
