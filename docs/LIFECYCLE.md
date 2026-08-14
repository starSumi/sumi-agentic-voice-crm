# Lifecycle and state ownership

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

Readiness is removed before termination. The orchestrator drains in-flight requests; workers finish leased jobs or let leases expire; outbox relay resumes from `published_at=NULL`; review tasks remain actionable; media cleanup is retention-driven.
