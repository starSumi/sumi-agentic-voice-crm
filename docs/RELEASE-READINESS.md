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
- Date: 2026-08-14
- Provider mode: deterministic mock
- Release candidate: **no**
- Production status: **not approved**

## Evidence captured

| Gate | Result | Evidence |
| --- | --- | --- |
| Syntax | PASS | `node --check src/*.mjs` via `npm run check` |
| Contract/unit | PASS | `npm test`: 20/20, including publisher, operations snapshot, incident reconciliation, and runtime boundary tests |
| Repository invariants | PASS | `npm run check`: 31 required files, OpenAPI markers, Postman JSON, server syntax |
| Agent governance | PASS | `npm run check:agent` and `npm run agent:health`: 9 phases, 7 checkpoints, 25 roles, maintainer registry and reviewed cursor current, live state external |
| Runtime build | PASS | `npm run build`: 8 runtime files plus a deterministic hash manifest |
| Runtime smoke | PASS | `npm run smoke:dist`: generated server reports ready in mock mode |
| Documentation build | PASS | `npm run docs:build`: Astro 0 diagnostics, 47 pages, 38 machine documents, 15 Chinese variants |
| MCP partner integration | PASS | `npm run verify:mcp`: four tools, bilingual queries, continuity discovery, OpenAPI, and all 38 human URLs |
| Dependency audit | PASS | `npm run audit:deps`: 0 vulnerabilities against the official npm registry |
| Package boundary | PASS | `npm pack --dry-run`: allowlisted runtime distribution plus repository metadata |
| GitHub CI baseline | PASS | Private `main` run `31811208140` at `e51fc7e927c4526381687e75351cb253ea7650ab`: `verify` and dependency audit completed successfully |
| CI operations workflow | PASS | `workflow_run` `31811267636` completed the read-only observation, freshness authorization, and issue reconciliation jobs; artifact `operations-snapshot-31811267636` expires 2026-09-13 |
| Remote branch protection | BLOCKED | GitHub returned `403`: the current account plan does not expose branch protection for this private repository; visibility remains private |
| Normal text ask | PASS | test `text ask returns CRM result and TTS asset` |
| Mock audio path | PASS | test `mock audio exercises ASR to intent to TTS` |
| No audio source | PASS | test `missing audio is a non-retryable boundary error` |
| Low confidence | PASS | test creates review task and does not commit CRM |
| Idempotency | PASS | repeated key returns same resource/version |
| Idempotency conflict | PASS | same key with a different command returns `IDEMPOTENCY_CONFLICT` |
| Event envelope/auth boundary | PASS | `/v1/events` requires tenant auth and emits CloudEvents-compatible fields |
| TTS auth/idempotency boundary | PASS | `/v1/tts/synthesize` rejects missing key and accepts scoped mock request |
| Real ASR/TTS quality | UNKNOWN | no production provider configured |
| PostgreSQL integration | NOT RUN | reference runtime uses in-memory store |
| Container build | NOT RUN | Docker CLI is not installed on the current validation host |
| Browser layout | PASS | English desktop 1440x900 and Chinese mobile 390x844; no viewport overflow or broken image; dark theme verified |
| Load/security/staging | NOT RUN | requires staging infrastructure, approved fixtures, and the C4-C5 owners |

## Release decision

There is no release approval for `0.1.0`. The current commit is suitable only for controlled source collaboration,
local contract exploration, and deterministic mock verification. Do not create a release tag, publish a package,
deploy the runtime to a public endpoint, or process production data. Release consideration starts only after C0–C6
in [CHECKPOINTS.md](CHECKPOINTS.md) are evidenced, especially identity/tenant isolation, real provider quality,
Postgres/outbox integration, security scans, load/fault tests, signed artifact/provenance, and a rollback drill.
