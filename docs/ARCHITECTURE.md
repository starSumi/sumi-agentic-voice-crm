---
title: Architecture, patterns and ownership
description: System boundaries, bounded contexts, design patterns, ownership rules, agent contracts, and failure isolation.
docId: crm.architecture
locale: en
audience: both
contentVersion: 0.1.0
---

## System map

```mermaid
flowchart TB
  client[CRM web/mobile/voice client] --> gateway[API Gateway\nOIDC/JWT • tenant • rate limit]
  gateway --> ask[Ask Orchestrator\nrequest state machine]
  ask --> media[Media Intake\nprivate object store]
  media --> asr[ASR Adapter\nWhisper/Indic/provider]
  ask --> context[CRM Context Query]
  asr --> normalize[Normalizer + PII policy]
  context --> intent[Intent + Entity Agent\nJSON Schema + confidence]
  normalize --> intent
  intent --> policy[Policy Decision Point\nRBAC • risk • confirmation]
  policy -->|read| crmquery[CRM Query]
  policy -->|write| command[CRM Command Service\ntransaction + idempotency]
  policy -->|ambiguous| review[Review Task Queue]
  command --> db[(Postgres CRM)]
  command --> outbox[(Transactional Outbox)]
  outbox --> events[Event Bus / CloudEvents]
  ask --> answer[Answer Composer]
  answer --> tts[TTS Adapter\nprovider + cache]
  tts --> audio[(Private TTS Assets)]
  answer --> response[Text/audio response]
  gateway -.-> obs[OpenTelemetry traces/logs/metrics]
  events -.-> obs
```

## Bounded contexts

| Context | Owner | Source of truth | Input | Output |
| --- | --- | --- | --- | --- |
| Identity & Tenant | Platform | IdP/tenant DB | JWT/request | actor, tenant, scopes |
| Voice Media | Media Platform | object store + media metadata | bytes/MIME | asset, checksum, duration |
| Understanding | Agent Platform | versioned inference record | transcript + CRM context | intent/entity proposal |
| CRM Domain | CRM Team | Postgres aggregates | validated commands | committed aggregate/version |
| Review | CRM Operations | review task store | ambiguous proposals | approve/reject/corrections |
| Interaction | Experience Team | request/event projections | all prior results | answer, audio URL, UI events |

## Design patterns

- Hexagonal architecture: provider adapters implement `transcribe`, `understand`, `synthesize`; domain never imports provider SDKs.
- CQRS-lite: query context is separate from command path; commands return aggregate version.
- Transactional outbox: domain mutation and event record commit atomically; relay is retryable.
- Saga/compensation: external notification or TTS failure never silently rolls back a committed CRM transaction; status/event records describe compensation.
- State machine: explicit request/job states; invalid transitions fail closed.
- Policy-as-code: command risk, tenant scope, actor scope and approval requirements are deterministic before agent execution.
- Idempotent command: `(tenant_id, idempotency_key)` unique; repeated requests replay the original result.
- Anti-corruption layer: adapters translate Saathi/Northstar concepts without importing their source model.

## Ownership rules

1. Agent owns proposal and explanation, never authoritative CRM data.
2. CRM owns IDs, invariants, transaction, version and audit event.
3. Gateway owns authentication and request correlation, not model policy.
4. Media owns bytes, checksum and retention; product tables store references only.
5. Event consumers are at-least-once and must be idempotent; no consumer edits event history.

## Agent runtime contract

An agent run has `run_id`, `conversation_id`, `request_id`, `tenant_id`, `actor_id`, `model_id`, `model_version`,
`tool_policy_version`, `input_hash`, `deadline_at`, `budget`, `attempt`, `parent_run_id`. Context is selected through
authorized CRM query tools; prompt and tool definitions are versioned artifacts. Tool results are untrusted until schema/policy validation.

## Failure isolation

Each provider call has timeout, retry budget, circuit state, and redacted error mapping. The orchestrator has a deadline and never retries a non-idempotent CRM command without its idempotency key. TTS can degrade to text; ASR failure cannot invent transcript; intent ambiguity cannot mutate data. The `src/` runtime is a deterministic reference implementation: its in-memory store demonstrates the boundary and contract tests, while PostgreSQL, object storage, verified OIDC and real providers remain promotion work, not a claim of production readiness.
