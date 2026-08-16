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
- Evidence basis: the reviewed `main` source line plus the committed feature candidate verified locally on 2026-08-16; remote CI must bind the final reviewed commit
- Toolchain: Volta Node `24.18.0`, pnpm `10.33.4`
- Provider mode: deterministic development defaults; fail-closed production adapters available
- Release candidate: **no**
- Production status: **not approved**

## Evidence captured

| Gate | Result | Evidence |
| --- | --- | --- |
| Release verification | PARTIAL (local candidate) | Node 24.18 and pnpm 10.33.4 gates cover dependency audit, protocol drift/typecheck, 122 non-PostgreSQL tests, repository/agent checks, dist smoke, docs build, load drill and fault drill; the real PostgreSQL integration gate is intentionally delegated to remote CI for the final reviewed commit |
| Authentication | PASS (local) | Real RSA JWKS verifies signature, algorithm, issuer, audience, subject, tenant and configured scope; forged, mismatched, underscoped and unsafe production configurations fail closed |
| Object storage | PASS (local) | S3-compatible adapter uploads checksummed, server-side-encrypted tenant keys, keeps object locators out of public assets, signs short-lived downloads, and rejects HTTP production endpoints |
| Interaction persistence | PASS | Input media, transcript, understanding, provider attempts, response/failure and latency checkpoints are encrypted with tenant/field AAD; same idempotency key replays without rerunning providers |
| PostgreSQL C2 fixture | NOT RUN LOCALLY | `pnpm run test:postgres` is a required remote-CI gate for the final reviewed commit; it must prove PostgreSQL migration, two-tenant `FORCE RLS`, atomic CRM/audit/outbox, encrypted interaction replay, durable TTS/assets/reviews, and outbox lease/retry/dead-letter/publish |
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
| Load drill | PASS (local) | 250 requests, concurrency 25, 250 success, 0 errors; P50 14.74 ms, P95 54.61 ms, P99 65.95 ms, max 67.46 ms |
| Fault drill | PASS (local) | Three provider timeouts open the circuit, the next request fails fast, readiness returns 503, and a failed relay delivery reaches dead letter |
| Package boundary | PASS | `pnpm pack --dry-run`: the allowlisted artifact is inspectable while `private: true` prevents accidental registry publication |
| Container build and runtime smoke | PASS (local) | Docker Server built the production image, imported the production dependency closure, started the unprivileged default `/app/dist` command, observed readiness, and removed the ephemeral image/container |
| Real provider/object-store connectivity | PASS (historical local staging) | DashScope ASR, intent and WAV TTS plus private Aliyun OSS upload/list/signed download were exercised without committing endpoints or credentials; this is not evidence for production approval or this feature branch's remote CI |
| Real OIDC identity | NOT RUN | Static single-tenant authentication is available for private staging, but production OIDC/JWKS issuer, audience, tenant and scope verification still require an approved identity provider |
| Broad security/privacy gate | OPEN | OIDC, tenant RLS, encrypted persistence, HTTPS configuration, secret patterns, dependency audit and SBOM pass locally. Rate limiting/CORS, prompt-injection suite, media malware/decompression, retention/deletion, container scan and a full security review remain C5 evidence |
| Staging/rollback/remote CI | PARTIAL | Local WSL2 staging smoke exists, but remote CI for the final pushed commit, release digest, progressive rollout, rollback drill, dashboard and on-call evidence remain required |
| Release candidate attestation and C6 | BLOCKED | Manual workflow is prepared, but exact reviewed-main acceptance, Docker smoke, signed provenance and named product/security/platform/operations approvals have not occurred |

## Release decision

There is no release approval for `0.1.0`. The feature branch is a locally verified
source candidate, not a production release. Do not create a release
tag, publish a package, deploy to a public endpoint, or process production data from this
evidence alone. Promotion requires an exact reviewed commit, real staging configuration,
OCI smoke and scan, provider/IdP/object-store tests, the remaining C5 controls, signed
provenance, rollback evidence, and explicit C6 approvals in [CHECKPOINTS.md](CHECKPOINTS.md).
