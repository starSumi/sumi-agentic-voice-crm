---
title: Source evidence and traceability basis
description: Pinned comparative sources, connected architecture map, evidence classes, unknowns, and rejected interpretations.
docId: crm.source-evidence
locale: en
audience: both
contentVersion: 0.1.0
---

This document separates comparative evidence from Sumi-owned design. It is
reproducible against the pinned local checkouts observed through 2026-08-16.

## Pinned comparative sources

| Source | Identity | Evidence used | Boundary |
| --- | --- | --- | --- |
| Saathi CRM | `JagadeepPortfolio/saathi-crm`, `main@693ec2bd20e546a06238559cc4cb20e342080af2` | `app/api/intake/route.ts` (multipart intake), `lib/intake.ts` (`runIntake` orchestration), `lib/asr/whisper.ts` (`transcribe`), `lib/ai/adapter.ts` (typed adapter) | comparative only; no source files, prompts, fixtures or credentials copied |
| CopilotKit AG-UI | Local reference snapshot of Windows checkout `main@6a5bb62b62b0d351abb35a2fe3bb0fed547a275d`; reviewed paths `skills/copilotkit-agui` and `packages/runtime` | AG-UI 0.0.57 event families, SSE ordering, RunAgentInput, tool/state/HITL adapter boundary | comparative protocol evidence only; snapshot contains tracked source and no Git directory |
| Northstar/Strands CRM | Local sparse reference snapshot of Windows checkout `main@2328062960a1e9b4b8bc2eb2817724fc624f8785`; reviewed showcase `examples/showcases/strands-crm`; overlay SHA-256 `af1ae662870fbef78885d357981b0039039844d09d56fa5c8caeccf43d20d548` | StrandsAgent boundary, state projection after mutating tools, generative UI/HITL organization | comparative only; the two-file pre-existing overlay is preserved and its values are not treated as Sumi configuration |

## Connected map

`HTTP /v1/ask` → `request/tenant state` → `ASR + intent adapters` → `policy and
confidence decision` → `CRM command or durable review` → `transactional outbox
and audit` → `answer composer` → `TTS asset` → `scoped response`.

The runtime implements the connected path with deterministic development adapters plus PostgreSQL/RLS, OIDC/JWKS, S3-compatible objects, OpenAI-compatible providers, encrypted interaction checkpoints and an outbox worker. Local tests establish adapter behavior; they do not establish staging connectivity or provider quality.

## Fact classification

- **source-confirmed:** the pinned comparative paths exist at their recorded
  commits. The Sumi implementation is owned by this repository and is not
  presented as upstream truth; CI and the versioned handoff bind exact commits.
- **runtime-observed:** local gates passed on Node `v24.18.0` and pnpm
  `10.33.4`, and CI run [31945918723](https://github.com/starSumi/sumi-agentic-voice-crm/actions/runs/31945918723)
  passed on reviewed commit `8355cdf4b26b91931b795832de4d6a9b825646af`:
  122 tests, real PostgreSQL migration/RLS/transaction integration, protocol
  and consumer checks, deterministic runtime payload, dependency audit, OCI
  smoke, documentation build, 250-request load drill and provider/outbox fault
  drill. CI uploaded build evidence with archive digest
  `sha256:dccc0302d9a3d09edab02d4fdcbd6ed5c7eacb1e654df56aa4e2034bfb3bbd99`.
- **inferred/design:** four-plane ownership, policy-as-code, transactional
  outbox, CloudEvents envelope, review gate and expand/migrate/contract are
  Sumi decisions documented in ADR-0001.
- **unknown/not run:** production OIDC, production ASR/TTS quality,
  object-store malware scanning,
  broad security scans, signed provenance and staging rollback drill. Local WSL2
  staging and OCI evidence do not replace these gates.

## Rejected interpretations

The existing projects are not treated as a shared runtime, API compatibility
source or database schema. Their implementation gaps (notably missing unified
TTS/ask and incomplete production identity controls) are design inputs for
Sumi's boundaries, not claims about their quality beyond the pinned source.
