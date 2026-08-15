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
- Evidence basis: `main@c9e88d19bf9808205f05380cdcc7ea60a13e93b7` plus the current uncommitted working-tree candidate
- Toolchain: Volta Node `24.18.0`, npm `11.15.0`
- Provider mode: deterministic development defaults; fail-closed production adapters available
- Release candidate: **no**
- Production status: **not approved**

## Evidence captured

| Gate | Result | Evidence |
| --- | --- | --- |
| Release verification | PASS | `npm run verify:release`: dependency audit, protocol drift/typecheck, 50/50 tests, PostgreSQL integration, repository/agent checks, dist smoke, docs build, load drill and fault drill |
| Authentication | PASS (local) | Real RSA JWKS verifies signature, algorithm, issuer, audience, subject, tenant and configured scope; forged, mismatched, underscoped and unsafe production configurations fail closed |
| Object storage | PASS (local) | S3-compatible adapter uploads checksummed, server-side-encrypted tenant keys, keeps object locators out of public assets, signs short-lived downloads, and rejects HTTP production endpoints |
| Interaction persistence | PASS | Input media, transcript, understanding, provider attempts, response/failure and latency checkpoints are encrypted with tenant/field AAD; same idempotency key replays without rerunning providers |
| PostgreSQL C2 fixture | PASS | PostgreSQL 18.4 disposable cluster; migration applied twice; two-tenant `FORCE RLS`; atomic CRM/audit/outbox; encrypted interaction replay; durable TTS/assets/reviews; outbox lease/retry/dead-letter/publish; cluster stopped and deleted |
| Outbox relay | PASS (local) | Independent worker claims with leases, sends CloudEvents with event-ID idempotency and HMAC, retries with bounded backoff, and dead-letters exhausted rows |
| Repository invariants | PASS | `npm run check`: 53 required files, contract/schema/SQL and repository secret markers, plus syntax for all 13 runtime modules |
| Agent governance | PASS | `npm run check:agent` and `npm run agent:health`: 9 phases, 7 checkpoints, 27 roles, maintainer registry and reviewed cursor current, live state external |
| Runtime build | PASS | `npm run build`: protocol drift gate plus 20 payload files; content-set SHA-256 `d63c524a8693361954d12d4d3d3c712de39a43802ecdf17e29751858ff03d2f0` |
| Runtime build integrity | PASS | Atomic staging/promotion; `npm run check:dist` verifies path, byte-count and SHA-256 content-set binding; tamper and failed-staging regression tests pass |
| Runtime SPDX SBOM | PASS | `npm run sbom`: runtime-only SPDX 2.3 document under ignored `artifacts/release/` |
| Runtime smoke | PASS | `npm run smoke:dist`: generated server reports ready in mock mode |
| Documentation build | PASS | `npm run docs:build`: Astro 0 diagnostics, 50 pages, 38 machine documents, 15 Chinese variants |
| MCP partner integration | PASS | `npm run verify:mcp`: four tools, bilingual queries, continuity discovery, OpenAPI, and all 38 human URLs |
| Dependency audit | PASS | Official npm registry reports `0 vulnerabilities`; generator is pinned to `@hey-api/openapi-ts@0.99.0` and the lockfile overrides `js-yaml@4.3.1` |
| Load drill | PASS (local) | 250 requests, concurrency 25, 250 success, 0 errors; P50 14.74 ms, P95 54.61 ms, P99 65.95 ms, max 67.46 ms |
| Fault drill | PASS (local) | Three provider timeouts open the circuit, the next request fails fast, readiness returns 503, and a failed relay delivery reaches dead letter |
| Package boundary | PASS | `npm pack --dry-run`: 24 allowlisted files, 35.3 kB compressed, 144.6 kB unpacked |
| Container build and runtime smoke | BLOCKED (local host) | `test/docker-release.test.mjs` statically verifies lockfile production-only install, `/app/dist` command, unprivileged user and the smoke contract. `npm run smoke:docker` explicitly failed before build because this host has no Docker CLI/daemon (`spawnSync docker ENOENT`); CI and release-candidate acceptance run the real OCI build, dependency import, default-command readiness, and cleanup gate. |
| Real provider/IdP/object-store connectivity and quality | NOT RUN | No approved staging endpoint or credentials were supplied; local contract tests do not establish remote availability, model quality or IAM correctness |
| Broad security/privacy gate | OPEN | OIDC, tenant RLS, encrypted persistence, HTTPS configuration, secret patterns, dependency audit and SBOM pass locally. Rate limiting/CORS, prompt-injection suite, media malware/decompression, retention/deletion, container scan and a full security review remain C5 evidence |
| Staging/rollback/remote CI | NOT RUN | The working-tree candidate has not been pushed or deployed; no release digest, staging smoke, progressive rollout, rollback drill, dashboard or on-call evidence exists |
| Release candidate attestation and C6 | BLOCKED | Manual workflow is prepared, but exact reviewed-main acceptance, Docker smoke, signed provenance and named product/security/platform/operations approvals have not occurred |

## Release decision

There is no release approval for `0.1.0`. The working tree is now a locally verified,
production-hardened source candidate, not a production release. Do not create a release
tag, publish a package, deploy to a public endpoint, or process production data from this
evidence alone. Promotion requires an exact reviewed commit, real staging configuration,
OCI smoke and scan, provider/IdP/object-store tests, the remaining C5 controls, signed
provenance, rollback evidence, and explicit C6 approvals in [CHECKPOINTS.md](CHECKPOINTS.md).
