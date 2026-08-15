---
title: Source evidence and traceability basis
description: Pinned comparative sources, connected architecture map, evidence classes, unknowns, and rejected interpretations.
docId: crm.source-evidence
locale: en
audience: both
contentVersion: 0.1.0
---

This document separates comparative evidence from Sumi-owned design. It is
reproducible against the pinned local checkouts observed on 2026-08-14.

## Pinned comparative sources

| Source | Identity | Evidence used | Boundary |
| --- | --- | --- | --- |
| Saathi CRM | `JagadeepPortfolio/saathi-crm`, `main@693ec2bd20e546a06238559cc4cb20e342080af2` | `app/api/intake/route.ts` (multipart intake), `lib/intake.ts` (`runIntake` orchestration), `lib/asr/whisper.ts` (`transcribe`), `lib/ai/adapter.ts` (typed adapter) | comparative only; no source files, prompts, fixtures or credentials copied |
| Northstar/Strands CRM | `CopilotKit/CopilotKit`, `main@2328062960a1e9b4b8bc2eb2817724fc624f8785`, showcase path `examples/showcases/strands-crm` | agent tool boundary, CRM state projection, AG-UI/HITL test organization | comparative only; checkout had pre-existing dirty overlay, preserved untouched |

## Connected map

`HTTP /v1/ask` → `request/tenant state` → `ASR + intent adapters` → `policy and
confidence decision` → `CRM command or durable review` → `transactional outbox
and audit` → `answer composer` → `TTS asset` → `scoped response`.

The runtime implements the connected path with deterministic development adapters plus PostgreSQL/RLS, OIDC/JWKS, S3-compatible objects, OpenAI-compatible providers, encrypted interaction checkpoints and an outbox worker. Local tests establish adapter behavior; they do not establish staging connectivity or provider quality.

## Fact classification

- **source-confirmed:** the pinned comparative paths exist at their recorded
  commits. This implementation round is based on Sumi `main@c9e88d19bf9808205f05380cdcc7ea60a13e93b7`
  plus an uncommitted working-tree candidate; it is not presented as upstream truth.
- **runtime-observed:** `npm run verify:release` passed locally on Volta Node
  `v24.18.0`: 50/50 tests, PostgreSQL 18.4 integration, deterministic 20-file
  runtime payload, dependency audit, 250-request load drill and provider/outbox
  fault drill. The exact reports remain under ignored `artifacts/release/`.
- **inferred/design:** four-plane ownership, policy-as-code, transactional
  outbox, CloudEvents envelope, review gate and expand/migrate/contract are
  Sumi decisions documented in ADR-0001.
- **unknown/not run:** production ASR/TTS quality, object-store malware scanning,
  broad security/staging scans, OCI smoke on this Docker-less host, signed
  provenance and staging rollback drill.

## Rejected interpretations

The existing projects are not treated as a shared runtime, API compatibility
source or database schema. Their implementation gaps (notably missing unified
TTS/ask and incomplete production identity controls) are design inputs for
Sumi's boundaries, not claims about their quality beyond the pinned source.
