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
- Date: 2026-08-15
- Evidence basis: the reviewed `main` source line and local verification recorded on 2026-08-15; remote CI must bind the final pushed commit
- Toolchain: Volta Node `24.18.0`, npm `11.15.0`
- Provider mode: deterministic development defaults; fail-closed production adapters available
- Release candidate: **no**
- Production status: **not approved**

## Evidence captured

| Gate | Result | Evidence |
| --- | --- | --- |
| Release verification | PASS (local) | Node 24 gates cover dependency audit, protocol drift/typecheck, 65 tests, PostgreSQL integration, repository/agent checks, dist smoke, docs build, load drill and fault drill; remote CI must repeat the final pushed commit |
| Authentication | PASS (local) | Real RSA JWKS verifies signature, algorithm, issuer, audience, subject, tenant and configured scope; forged, mismatched, underscoped and unsafe production configurations fail closed |
| Object storage | PASS (local) | S3-compatible adapter uploads checksummed, server-side-encrypted tenant keys, keeps object locators out of public assets, signs short-lived downloads, and rejects HTTP production endpoints |
| Interaction persistence | PASS | Input media, transcript, understanding, provider attempts, response/failure and latency checkpoints are encrypted with tenant/field AAD; same idempotency key replays without rerunning providers |
| PostgreSQL C2 fixture | PASS | PostgreSQL 18.4 disposable cluster; migration applied twice; two-tenant `FORCE RLS`; atomic CRM/audit/outbox; encrypted interaction replay; durable TTS/assets/reviews; outbox lease/retry/dead-letter/publish; cluster stopped and deleted |
| Outbox relay | PASS (local) | Independent worker claims with leases, sends CloudEvents with event-ID idempotency and HMAC, retries with bounded backoff, and dead-letters exhausted rows |
| Repository invariants | PASS | `npm run check`: 57 required files, contract/schema/SQL and repository secret markers, plus syntax for all 17 runtime modules |
| Agent governance | PASS | `npm run check:agent` and `npm run agent:health`: 9 phases, 7 checkpoints, 27 roles, maintainer registry and reviewed cursor current, live state external |
| Runtime build | PASS | `npm run build`: protocol drift gate plus 24 payload files; the generated manifest binds every payload and the content-set digest |
| Runtime build integrity | PASS | Atomic staging/promotion; `npm run check:dist` verifies path, byte-count and SHA-256 content-set binding; tamper and failed-staging regression tests pass |
| Runtime SPDX SBOM | PASS | `npm run sbom`: runtime-only SPDX 2.3 document under ignored `artifacts/release/` |
| Runtime smoke | PASS | `npm run smoke:dist`: generated server reports ready in mock mode |
| Documentation build | PASS | `npm run docs:build`: Astro 0 diagnostics, 50 pages, 38 machine documents, 15 Chinese variants |
| MCP partner integration | PASS | `npm run verify:mcp`: four tools, bilingual queries, continuity discovery, OpenAPI, and all 38 human URLs |
| Dependency audit | PASS | Official npm registry reports `0 vulnerabilities`; generator is pinned to `@hey-api/openapi-ts@0.99.0` and the lockfile overrides `js-yaml@4.3.1` |
| Load drill | PASS (local) | 250 requests, concurrency 25, 250 success, 0 errors; P50 14.74 ms, P95 54.61 ms, P99 65.95 ms, max 67.46 ms |
| Fault drill | PASS (local) | Three provider timeouts open the circuit, the next request fails fast, readiness returns 503, and a failed relay delivery reaches dead letter |
| Package boundary | PASS | `npm pack --dry-run`: 28 allowlisted files, 41.6 kB compressed, 170.7 kB unpacked; `private: true` prevents accidental npm publication |
| Container build and runtime smoke | PASS (local) | Docker Server built the production image, imported the production dependency closure, started the unprivileged default `/app/dist` command, observed readiness, and removed the ephemeral image/container |
| Real provider/object-store connectivity | PASS (local staging) | DashScope ASR, intent and WAV TTS plus private Aliyun OSS upload/list/signed download were exercised without committing endpoints or credentials; this is not production approval |
| Real OIDC identity | NOT RUN | Static single-tenant authentication is available for private staging, but production OIDC/JWKS issuer, audience, tenant and scope verification still require an approved identity provider |
| Broad security/privacy gate | OPEN | OIDC, tenant RLS, encrypted persistence, HTTPS configuration, secret patterns, dependency audit and SBOM pass locally. Rate limiting/CORS, prompt-injection suite, media malware/decompression, retention/deletion, container scan and a full security review remain C5 evidence |
| Staging/rollback/remote CI | PARTIAL | Local WSL2 staging smoke exists, but remote CI for the final pushed commit, release digest, progressive rollout, rollback drill, dashboard and on-call evidence remain required |
| Release candidate attestation and C6 | BLOCKED | Manual workflow is prepared, but exact reviewed-main acceptance, Docker smoke, signed provenance and named product/security/platform/operations approvals have not occurred |

## Release decision

There is no release approval for `0.1.0`. The working tree is now a locally verified,
production-hardened source candidate, not a production release. Do not create a release
tag, publish a package, deploy to a public endpoint, or process production data from this
evidence alone. Promotion requires an exact reviewed commit, real staging configuration,
OCI smoke and scan, provider/IdP/object-store tests, the remaining C5 controls, signed
provenance, rollback evidence, and explicit C6 approvals in [CHECKPOINTS.md](CHECKPOINTS.md).
