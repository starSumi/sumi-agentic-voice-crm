---
title: Engineering checkpoints and checklists
description: Evidence-based stage gates from scope and contract freeze through security verification and release approval.
docId: crm.checkpoints
locale: en
audience: both
contentVersion: 0.1.0
---

## C0 — Scope and evidence freeze

- [ ] Product owner, tenant model, supported locales, risk classes and retention approved.
- [ ] Source inspirations pinned and attribution/non-copying note reviewed.
- [ ] ADR accepted; unknown runtime facts listed.
- [ ] Rollback owner and incident contact named.

## C1 — Contract freeze

- [ ] OpenAPI 3.1 parses; `/v1/ask` supports text + multipart audio.
- [ ] Error codes/status/retryability agree across docs, server and Postman.
- [ ] Understanding and event schema versions are explicit.
- [ ] Backward-compatibility and deprecation rules documented.

## C2 — Domain safety

- [ ] Every table/command includes tenant and actor context.
- [ ] CRM writes are schema/policy validated and transactional.
- [ ] Idempotency and optimistic version behavior tested.
- [ ] Low confidence/high risk routes to ReviewTask; no hidden auto-write.
- [ ] Audit record + outbox event are atomic with mutation.

## C3 — Media and provider readiness

- [ ] ASR validates bytes, MIME, duration, silence and language result.
- [ ] TTS validates text length, voice/locale, MIME, playback and TTL.
- [ ] Provider timeout/circuit/retry/fallback tested.
- [ ] No secret in source, fixtures, logs or URLs.

## C4 — Observability and resilience

- [ ] request/trace/event IDs correlate end-to-end.
- [ ] P50/P95/P99, error, confidence, queue lag and replay metrics emitted.
- [ ] Restart, duplicate, provider-down, dead-letter and restore drills pass.
- [ ] Alerts map to an owner and runbook.

## C5 — Security and privacy

- [ ] OIDC/JWT, RBAC, tenant isolation, CORS and rate limit verified.
- [ ] Prompt injection/tool allowlist tests pass.
- [ ] Media malware/SSRF/MIME/decompression tests pass.
- [ ] Retention/deletion/legal hold behavior verified.
- [ ] SAST/SCA/secret scan/SBOM/provenance evidence attached.

## C6 — Release approval

- [ ] Unit, contract, integration, E2E, fault, load and security reports green or waived by named owner.
- [ ] Normal voice, silence, no-source, low-confidence and TTS-fallback records include request IDs and timestamps.
- [ ] Staging smoke and rollback drill pass on release digest.
- [ ] `dist/BUILD-MANIFEST.json` binds every payload path, byte count and SHA-256 digest; a clean rebuild has the same content-set digest.
- [ ] Runtime SPDX SBOM, dependency audit and repository secret scan are attached; provenance is signed or the release is explicitly held.
- [ ] Manual release-candidate workflow checks the exact reviewed main commit, package version and completed C6 before packaging.
- [ ] Migration compatibility, dashboards, on-call and customer communication ready.
- [ ] Product/security/platform/operations approvals recorded.

No checkpoint is complete because code “looks finished”; it requires reproducible evidence and an explicit owner. Ordinary CI and the CI Operations Agent cannot mark C6 complete or publish a release.
