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

## Evidence

The WSL-native reference snapshot of CopilotKit is pinned to Windows checkout
`main@6a5bb62b62b0d351abb35a2fe3bb0fed547a275d`. Its AG-UI reference defines a
`RunAgentInput` POST followed by ordered SSE lifecycle, text, tool, state and
activity events. The pinned runtime uses `@ag-ui/core`, `@ag-ui/client` and
`@ag-ui/encoder` version `0.0.57`.

The Northstar sparse snapshot is based on
`main@2328062960a1e9b4b8bc2eb2817724fc624f8785` plus the pre-existing local
overlay whose SHA-256 is
`af1ae662870fbef78885d357981b0039039844d09d56fa5c8caeccf43d20d548`.
Its Strands CRM adapter exposes an AG-UI app and emits full CRM state snapshots
after selected mutating tools.

Sumi currently exposes a synchronous OpenAPI `/v1/ask`, durable review decisions,
private audio assets and tenant-scoped CloudEvents. `/v1/events` returns persisted
domain events; it is not an AG-UI SSE stream. The current `ask` orchestration is
still coupled to the Node HTTP request/response objects.

## Decision

1. OpenAPI commands, ReviewTask records, PostgreSQL transactions, audit records,
   outbox messages and CloudEvents remain the business source of truth.
2. Do not add AG-UI packages to the runtime merely to wrap the existing final JSON
   response. That would add a second transport contract without delivering real
   streaming or frontend tool execution.
3. When a concrete CopilotKit or other AG-UI consumer is selected, first extract
   the `/v1/ask` workflow into a transport-independent application service. Then
   add an optional authenticated `/v1/ag-ui` adapter which calls that same service.
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
