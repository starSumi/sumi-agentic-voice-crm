---
title: "ADR-0005: Managed lifecycle, Guardian governance, and conversation CAS"
description: Define bounded background-task teardown, semantic Guardian interruption, and optimistic conversation state replacement.
docId: crm.decision.0005-managed-lifecycle-guardian-cas
locale: en
audience: both
contentVersion: 0.1.0
---

**Status:** Accepted; runtime foundations implemented
**Date:** 2026-08-17
**Decision owner:** Sumi platform engineering

## Decision

The Control Engine owns a `ManagedTaskRegistry` for background work. Each task
has one stable name, one child `AbortSignal`, one observed result, and an
optional terminate hook supplied only by a trusted supervisor. Shutdown stops
admission, aborts all tasks concurrently, and waits at most three seconds by
default. The registry may request termination for a supervised process after
that budget; it cannot claim to kill arbitrary in-process JavaScript.

The API separately stops HTTP admission and drains active connections. At the
same three-second deadline it aborts request signals and closes remaining
connections before closing runtime resources. The outbox polling loop is the
first background workload owned by the managed-task registry. Other workers
must register rather than creating unowned top-level loops.

Guardian rejection governance is a semantic turn-level state machine, not an
upstream availability circuit. Standard policy interrupts after either three
consecutive denials or ten denials in the most recent fifty reviews. Cyber
policy interrupts on the first denial. A non-denial resets only the consecutive
counter; once a turn is interrupted it remains interrupted until the owner
explicitly clears that turn. State is bounded by count and idle TTL.

The current product has CRM mutation review but does not yet have a Guardian
adapter for network, file, or command permissions. The governor is therefore a
control primitive, not evidence that automatic permission review is deployed.
The transport-neutral coordinator gives an evaluator a 90-second cooperative
review deadline plus a two-second supervised hard-stop grace. Timeout,
unavailability, or malformed output fails closed to human review and never
becomes permission. No network/file/command adapter is registered yet.

Conversation state is a runtime-core concern. It is stored as a tenant-bound,
encrypted JSON object with a monotonically increasing revision. Replacement is
one database statement matching `(tenant_id, conversation_id,
expected_revision)` and returns only success plus the new revision. A stale
writer receives a conflict without the newer state. HTTP, SSE, MCP, desktop,
and TUI adapters must call `ConversationStateService`; they cannot update the
table directly.

## Boundaries

- Provider and outbox CAS circuit breakers measure upstream availability.
- Guardian denial windows decide when a safety review turn must stop.
- Conversation revision CAS prevents concurrent state overwrite.
- Interaction leases and the interaction journal recover request execution.

These mechanisms share compare-and-swap principles but not state, thresholds,
failure meanings, or operator actions.

## Consequences

Shutdown is observable and bounded, worker cancellation releases leases, and a
future agent runtime has an explicit place for managed work and session state.
Conversation state adds migration `003_conversation_revision_cas.sql`; it is
not exposed as a public API yet. The migration must be applied before a runtime
that calls the conversation service is promoted.

## Rollback

Stop using the conversation service and retain the additive table while the
previous application image runs. Disable future Guardian adapters without
removing the governor. Managed task registration can be removed per worker,
but the worker must regain an equivalent owned cancellation and teardown path.
