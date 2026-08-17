---
title: "ADR-0003: AG-UI compatibility boundary"
description: Decision and adoption gates for exposing Sumi through AG-UI without replacing durable CRM contracts.
docId: crm.decision.0003-ag-ui-compatibility
locale: en
audience: both
contentVersion: 0.1.0
---

**Status:** Accepted; defer the runtime dependency until a real AG-UI consumer exists
**Date:** 2026-08-16
**Decision owner:** Sumi platform engineering
**Scope:** optional agent-to-UI streaming, tool visibility, UI state projection and human-in-the-loop presentation

## Current boundary

Sumi currently exposes a synchronous OpenAPI `/v1/ask`, durable review decisions,
private audio assets and tenant-scoped CloudEvents. `/v1/events` returns persisted
domain events; it is not an AG-UI SSE stream. Ask, TTS and review orchestration now
run behind transport-independent application services. The Node HTTP adapter owns
request parsing, authentication projection and response mapping, while an optional
progress sink exposes bounded internal milestones for a future streaming adapter.

## Decision

1. OpenAPI commands, ReviewTask records, PostgreSQL transactions, audit records,
   outbox messages and CloudEvents remain the business source of truth.
2. Do not add AG-UI packages to the runtime merely to wrap the existing final JSON
   response. That would add a second transport contract without delivering real
   streaming or frontend tool execution.
3. When a concrete AG-UI consumer is selected, add an optional authenticated
   `/v1/ag-ui` adapter over the existing application services and progress sink.
4. The adapter may emit `RUN_STARTED`, bounded step/activity events, assistant
   text events, tenant-scoped UI projections and `RUN_FINISHED`/`RUN_ERROR`.
   It must never emit hidden chain-of-thought or treat an AG-UI state snapshot as
   durable CRM state.
5. Frontend tool results cannot bypass authorization, schema validation,
   idempotency, policy, ReviewTask approval, transaction or audit/outbox writes.
6. Voice input remains the bounded `/v1/ask` media contract. Generated speech is
   represented by a private, expiring asset reference or a named custom event;
   raw customer audio is not streamed through state snapshots.
7. AG-UI package versions must be pinned exactly and covered by protocol-order,
   disconnect, cancellation, tenant-isolation and compatibility tests before the
   endpoint is enabled.

## Adoption gates

Introduce the adapter only when all of these are true:

- a named frontend consumer and user journey require incremental output, tool
  visibility, generative UI, or interactive resume;
- the application service refactor avoids duplicating `/v1/ask` business logic;
- SSE behavior is verified through the selected reverse proxy, including abort,
  timeout, backpressure and client disconnect handling;
- `threadId`, `runId`, request ID, tenant, actor and idempotency identities have an
  explicit correlation and replay policy;
- ReviewTask approval remains durable and fail-closed;
- the existing OpenAPI, CloudEvents, audit, outbox and rollback gates still pass.

## Consequences

This keeps the high-value AG-UI option without paying its runtime and compatibility
cost before there is a consumer. A future adapter is additive and reversible; the
core CRM remains usable by API, batch, audit and worker consumers that do not speak
AG-UI.

## Rollback

Disable or remove `/v1/ag-ui` and its packages. No database rollback is required
because AG-UI state and messages are projections, not business truth. Existing
OpenAPI and CloudEvents consumers continue unchanged.
