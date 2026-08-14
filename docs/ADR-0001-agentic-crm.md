---
title: "ADR-0001: Agent-native voice CRM platform"
description: The accepted architecture decision for text and voice CRM orchestration, safety boundaries, ownership, and rollback.
docId: crm.decision.0001-agentic-crm
locale: en
audience: both
contentVersion: 0.1.0
---

**Status:** Accepted for implementation  
**Date:** 2026-08-14  
**Decision owner:** Sumi platform engineering  
**Scope:** text/voice CRM interaction, intent extraction, structured commands, optional TTS

## Context

Traditional CRMs treat AI as a chat sidebar while forms and manual actions still drive business state. This project makes the agent a workflow orchestrator, but natural-language reasoning is never business truth: a model can be ambiguous, hallucinate, repeat a call, or exceed its authority. Voice adds MIME, duration, transcoding, empty-audio, ASR-quality, retention, and TTS-provider failure modes.

The pinned comparative evidence shows that Saathi has an ASR-to-structured-CRM input path and Northstar has CRM tools, event projections, HITL, and test organization. Neither supplies the complete TTS, unified `/ask`, enterprise identity, tenant, and high-availability control plane required here. They are evidence and inspiration, not implementation sources.

## Decision

Adopt a four-plane, contract-first, provider-neutral architecture:

1. The Gateway owns authentication, tenant resolution, rate limiting, request IDs, and the idempotency boundary.
2. The Ask Orchestrator coordinates work but never writes directly to the CRM.
3. ASR, Intent, and TTS are replaceable adapters or services with independent timeouts, model versions, and metrics.
4. The CRM Service is the sole business-write authority and combines commands, transactions, and an outbox for consistency.
5. Low-confidence or high-risk actions create durable `ReviewTask` records.
6. Domain events use a CloudEvents-compatible envelope; tracing follows W3C Trace Context and OpenTelemetry semantics.
7. APIs use OpenAPI 3.1, with shared schemas feeding clients, Postman, and contract tests.
8. Deterministic mock providers keep offline verification possible. Production providers require secret management and capability health checks.

## Alternatives rejected

| Alternative | Reason rejected |
| --- | --- |
| Chain ASR, LLM, database, and TTS directly in a Next.js route | Mixes trust and ownership boundaries and prevents independent scaling, replay, and audit |
| Let the LLM call SQL or a CRM SDK directly | Bypasses schemas, RBAC, idempotency, and transactions |
| Rely only on AG-UI or a chat protocol | UI events are not a durable CRM contract and do not cover API, batch, or audit consumers |
| Write to the CRM before user confirmation | Creates incorrect data and irreversible side effects; use review and command gates |
| Store permanent base64 audio in business tables | Inflates data, increases exposure, and complicates TTL; use references to private object storage |

## Consequences

The benefits are explicit service boundaries, independently testable providers, recoverability, auditability, and shared business semantics for text and voice. The cost is additional schema, outbox, review-queue, authorization, observability, and release-governance work beyond a showcase.

## Compatibility and migration

- Map Saathi Customer, Visit, and Message records to Customer, Activity, and VoiceInteraction while preserving raw transcripts and AI metadata under the retention policy.
- Map Northstar `CrmState` to CRM aggregates. A full snapshot is only a migration adapter; versioned queries and events are the target.
- Existing text CRM calls can enter through `/v1/ask`; voice support does not weaken the existing API security boundary.

## Rollback

Roll back the application by image digest. Database changes use expand, migrate, and contract rather than rolling back committed business state. TTS can be disabled by feature flag while text responses remain available. A failed Intent release routes the affected `schema_version` to the previous compatible version. Unconsumed outbox, review, and media records must not be deleted.

## Checkpoint

This ADR can advance to production approval only after the C0-C6 evidence in [CHECKPOINTS.md](CHECKPOINTS.md) is complete.
