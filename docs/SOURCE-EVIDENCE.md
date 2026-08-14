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

The reference implementation confirms the control-flow seam with a deterministic
in-memory store. PostgreSQL, object storage, verified OIDC and real providers
are promotion targets, not runtime evidence for this commit.

## Fact classification

- **source-confirmed:** the pinned comparative paths and the Sumi files linked
  above exist at the recorded commits; Sumi contracts and docs are committed at
  `5c27022e6a819b8f0957782014dcbe56eb317f33`.
- **runtime-observed:** `npm test` 11/11, `npm run check`, and `npm run build`
  passed locally on Node `v24.18.0` with mock providers.
- **inferred/design:** four-plane ownership, policy-as-code, transactional
  outbox, CloudEvents envelope, review gate and expand/migrate/contract are
  Sumi decisions documented in ADR-0001.
- **unknown/not run:** production ASR/TTS quality, PostgreSQL/RLS integration,
  OIDC verification, object-store malware scanning, load/fault/security scans,
  signed provenance and rollback drill.

## Rejected interpretations

The existing projects are not treated as a shared runtime, API compatibility
source or database schema. Their implementation gaps (notably missing unified
TTS/ask and incomplete production identity controls) are design inputs for
Sumi's boundaries, not claims about their quality beyond the pinned source.
