---
title: Development and release readiness record
description: Current pre-alpha evidence, known production gaps, and the explicit hold on releasing version 0.1.0.
docId: crm.release-readiness
locale: en
audience: both
contentVersion: 0.1.0
---

## Development baseline

- Repository: `sumi-agentic-voice-crm`
- Working version: `0.1.0`
- Lifecycle: pre-alpha; active development
- Date: 2026-08-16
- Evidence basis: reviewed feature commit `8355cdf4b26b91931b795832de4d6a9b825646af`; GitHub Actions CI run [31945918723](https://github.com/starSumi/sumi-agentic-voice-crm/actions/runs/31945918723) completed successfully on that exact SHA
- Toolchain: Volta Node `24.18.0`, pnpm `10.33.4`
- Provider mode: deterministic development defaults; fail-closed production adapters available
- Release candidate: **no**
- Production status: **not approved**

## Evidence captured

| Gate | Result | Evidence |
| --- | --- | --- |
| Release verification | PASS (remote CI; release still held) | CI job [95161718522](https://github.com/starSumi/sumi-agentic-voice-crm/actions/runs/31945918723/job/95161718522) passed Node 24.18/pnpm 10.33.4, 122 tests, real PostgreSQL integration, protocol/repository gates, dist/Docker smoke, docs build, load/fault drills, SBOM and dependency audit |
| Authentication | PASS (local) | Real RSA JWKS verifies signature, algorithm, issuer, audience, subject, tenant and configured scope; forged, mismatched, underscoped and unsafe production configurations fail closed |
| Object storage | PASS (local) | S3-compatible adapter uploads checksummed, server-side-encrypted tenant keys, keeps object locators out of public assets, signs short-lived downloads, and rejects HTTP production endpoints |
| Interaction persistence | PASS | Input media, transcript, understanding, provider attempts, response/failure and latency checkpoints are encrypted with tenant/field AAD; same idempotency key replays without rerunning providers |
| PostgreSQL C2 fixture | PASS (remote CI) | The CI verify job ran `pnpm run test:postgres` on the exact reviewed SHA and passed migration, two-tenant `FORCE RLS`, atomic CRM/audit/outbox, encrypted interaction replay, durable TTS/assets/reviews, and outbox lease/retry/dead-letter/publish |
| Outbox relay | PASS (local) | Independent worker claims with leases, sends CloudEvents with event-ID idempotency and HMAC, retries with bounded backoff, and dead-letters exhausted rows |
| Repository invariants | PASS | `pnpm run check`: required files, contract/schema/SQL and repository secret markers, plus runtime syntax |
| Agent governance | PASS | `pnpm run check:agent` and `pnpm run agent:health`: versioned phases, checkpoints, roles, maintainer registry and reviewed cursor, with live state external |
| Runtime build | PASS | `pnpm run build`: protocol drift gate plus a content-bound generated manifest |
| Runtime build integrity | PASS | Atomic staging/promotion; `pnpm run check:dist` verifies path, byte-count and SHA-256 content-set binding; tamper and failed-staging regression tests pass |
| Runtime SPDX SBOM | PASS | `pnpm run sbom`: runtime-only SPDX 2.3 document under ignored `artifacts/release/` |
| Runtime smoke | PASS | `pnpm run smoke:dist`: generated server reports ready in mock mode |
| Documentation build | PASS | `pnpm run docs:build`: Astro diagnostics, human pages and the machine projection are built together |
| MCP partner integration | PASS | `pnpm run verify:mcp`: four tools, bilingual queries, continuity discovery and OpenAPI |
| Dependency audit | PASS | Official npm registry reports `0 vulnerabilities`; generator is pinned to `@hey-api/openapi-ts@0.99.0` and the lockfile overrides `js-yaml@4.3.1` |
| Load drill | PASS (local and remote CI) | 250 requests, concurrency 25, 250 success, 0 errors; the CI drill completed on the exact reviewed SHA |
| Fault drill | PASS (local and remote CI) | Three provider timeouts open the circuit, the next request fails fast, readiness returns 503, and a failed relay delivery reaches dead letter |
| Package boundary | PASS | `pnpm pack --dry-run`: the allowlisted artifact is inspectable while `private: true` prevents accidental registry publication |
| Container build and runtime smoke | PASS (local) | Docker Server built the production image, imported the production dependency closure, started the unprivileged default `/app/dist` command, observed readiness, and removed the ephemeral image/container |
| Real provider/object-store connectivity | PASS (historical local staging) | DashScope ASR, intent and WAV TTS plus private Aliyun OSS upload/list/signed download were exercised without committing endpoints or credentials; this is not evidence for production approval or this feature branch's remote CI |
| Real OIDC identity | NOT RUN | Static single-tenant authentication is available for private staging, but production OIDC/JWKS issuer, audience, tenant and scope verification still require an approved identity provider |
| Broad security/privacy gate | OPEN | OIDC, tenant RLS, encrypted persistence, HTTPS configuration, secret patterns, dependency audit and SBOM pass locally. Rate limiting/CORS, prompt-injection suite, media malware/decompression, retention/deletion, container scan and a full security review remain C5 evidence |
| Staging/rollback/remote CI | PASS (CI) / PARTIAL (release) | Remote CI is green and uploaded artifact `build-evidence-d49e924c1316bc6f36a36875133718bfd024d0cf` with archive digest `sha256:dccc0302d9a3d09edab02d4fdcbd6ed5c7eacb1e654df56aa4e2034bfb3bbd99`; release digest, progressive rollout, rollback drill, dashboard and on-call evidence remain required |
| Release candidate attestation and C6 | BLOCKED | Manual workflow is prepared, but exact reviewed-main acceptance, Docker smoke, signed provenance and named product/security/platform/operations approvals have not occurred |

## Release decision

There is no release approval for `0.1.0`. The feature branch is a locally verified
source candidate, not a production release. Do not create a release
tag, publish a package, deploy to a public endpoint, or process production data from this
evidence alone. Promotion requires an exact reviewed commit, real staging configuration,
OCI smoke and scan, provider/IdP/object-store tests, the remaining C5 controls, signed
provenance, rollback evidence, and explicit C6 approvals in [CHECKPOINTS.md](CHECKPOINTS.md).
