---
title: Lifecycle and state ownership
description: Request, agent run, job, media, CRM aggregate, shutdown, and recovery state machines and their owners.
docId: crm.lifecycle
locale: en
audience: both
contentVersion: 0.1.0
---

## Request lifecycle

`RECEIVED → VALIDATED → TRANSCRIBING? → NORMALIZED → UNDERSTANDING → (NEEDS_REVIEW | CRM_EXECUTING) → CRM_COMMITTED → SYNTHESIZING? → RESPONDED`.

Terminal failures are `REJECTED` (invalid/auth), `FAILED` (provider/system), or `EXPIRED` (review/media/job retention). Every transition has an actor (`system`, `agent`, `human`, `worker`), timestamp, reason code and trace ID.

## Agent run lifecycle

`CREATED → CONTEXT_LOADED → TOOL_PROPOSED → TOOL_VALIDATED → TOOL_EXECUTED → COMPLETED|ABORTED`.

The agent may propose multiple read-only tools, but a mutation tool is single-command per approval boundary. Context is a bounded snapshot with a version; stale context causes a re-query or conflict, never a blind write.

## Job lifecycle

ASR/TTS/outbox/review jobs use `QUEUED → LEASED → RUNNING → SUCCEEDED|RETRY_WAIT|DEAD_LETTER|CANCELLED`.
Leases have expiry; workers renew only while healthy. Retry policy is exponential with jitter and a bounded attempt count. Dead letters require operator disposition.

## Media lifecycle

`UPLOADING → STORED → PROCESSING → AVAILABLE|QUARANTINED → EXPIRED → DELETED`.
Hash and MIME are checked at ingress; content is private; URL is signed and short-lived. Quarantine is mandatory for malware/invalid codec findings.

## CRM aggregate lifecycle

Each aggregate has `version`; command includes expected version or a safe merge policy. A command either commits all business changes + outbox in one transaction or none.
Projection/UI state is disposable and rebuilt from query/events.

## Shutdown and recovery

The composition root in `src/composition-root.mjs` owns process-singleton resources:
the environment snapshot, authenticator/JWKS cache, provider adapters and circuit
breakers, object storage client, PostgreSQL pool, and observability registry.
Each request gets an immutable context (`request_id`, traceparent, tenant/actor
identity, `AbortSignal`); each provider call is an operation scope with a
10-second cooperative deadline and a 2-second hard-stop grace; each
PostgreSQL command is a transaction scope. Provider network calls never hold a
database transaction open.

Interactions hold a renewable database lease. Checkpoint and completion updates
require the current owner and an unexpired lease. A new request may reclaim only
`processing` work whose lease expired, using one conditional database update;
the recovery transition and encrypted journal entry commit in the same
transaction. The journal establishes transition order and incident evidence. It
is not an event-sourcing log and does not replace the current interaction row.

On `SIGTERM`/`SIGINT`, readiness is removed first, the HTTP server drains
in-flight requests, and the composition root closes its resources. Workers finish
leased jobs or release their leases on cooperative cancellation; cancellation
does not consume a delivery attempt. The outbox relay resumes from
`published_at=NULL`;
review tasks remain actionable; media cleanup is retention-driven.
