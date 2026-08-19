---
title: ADR-0007 Declarative agent control plane
description: Adopt controller reconciliation, explicit ownership, durable truth, and evidence-backed convergence for Sumi agents.
docId: crm.adr-0007
locale: en
audience: both
contentVersion: 0.1.0
---

**Status:** Accepted
**Date:** 2026-08-19
**Decision owner:** Sumi platform engineering

## Decision

Sumi models long-running agent work as declarative resources reconciled by small,
explicitly owned controllers. Intent is represented as desired state; controller
status is an observation of actual state. Events, queue notifications, watches,
and timers only wake a controller. Every decision re-reads authoritative state
before producing an effect.

The normative policy is `contracts/control-plane-policy.json`. Its schema and
CI checker require one status owner per resource, level-triggered decisions,
at-least-once delivery, idempotent or compare-and-swap guarded effects, expiring
leases, bounded finalization, and current evidence before a resource can be
reported as ready or verified.

The common `generation`, `observed_generation`, and Condition envelope is a
requirement for new public declarative resources. Existing internal interaction,
extension, Guardian, and managed-task state machines retain their versioned native
status until deliberately migrated. The policy records each surface's actual mode,
version fence, recovery scope, and verification tests instead of claiming that the
migration is already complete.

This follows the control-loop and API separation described by the official
[Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/)
and [API conventions](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-architecture/api-conventions.md).
It does not make Kubernetes a runtime dependency and does not expose Kubernetes
objects as the Sumi product API.

## Product semantics

Sumi extends generic controller semantics for probabilistic agents:

- Model output is an untrusted proposal, never authoritative business state.
- Server policy and the transactional policy enforcement point own authority.
- Irreversible effects require explicit policy or human review.
- Completion requires a current condition and durable evidence reference, not a
  successful process exit or a model assertion.
- Every run has bounded deadline, attempt, and cost budgets.
- Concurrent replacement uses a versioned CAS; committed external effects use
  compensation instead of pretending they can always be rolled back.
- Hidden reasoning is never required as audit evidence. Inputs, decisions,
  policy versions, effects, and artifact digests are the reviewable record.

## Resource and controller boundary

Message jobs, interactions, extensions, outbox events, conversation state,
managed tasks, and Guardian turns each have one declared status owner. Other
components may request work or consume projections but cannot write that
resource's status directly. Durable PostgreSQL state, the validated extension
registry, or the managed-task registry remains authoritative; SSE, CloudEvents,
and progress notifications are projections and wake-up hints.

Leases coordinate temporary work ownership and expire. Stale owners cannot
commit. Finalization releases leases, drains tasks, records a terminal result,
or invokes a trusted supervised termination within a bounded deadline. These
semantics correspond to the purpose, not the wire format, of Kubernetes
[Leases](https://kubernetes.io/docs/concepts/architecture/leases/) and
[finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/).

## Consequences

Controllers must tolerate duplicate and missing wake-ups, process restarts,
out-of-order observations, and retry. New controllers must be added to the
machine-readable policy with an implementation path, truth source, concurrency
guard, idempotency key, finalization behavior, and status evidence. A stream-only
workflow, unbounded shutdown, or multi-writer status resource is rejected by the
architecture gate.

Message and outbox retries currently use bounded exponential backoff. Jitter is a
required promotion gate before horizontally scaling competing workers. Extensions
and managed tasks use explicit-only restart policy: failed health affects status
and readiness but never causes an automatic replay of unknown side effects.

This policy does not require one universal scheduler or one monolithic controller.
The Control Engine owns shared lifecycle primitives; application controllers keep
their domain-specific state machines and transaction boundaries.

## Rollback

The policy and checker can be removed without a data migration. Runtime CAS,
leases, WAL, authorization, review, and managed teardown remain independent safety
mechanisms and must not be removed as part of that rollback.
