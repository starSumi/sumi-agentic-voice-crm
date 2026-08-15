---
title: Development workflow
description: Repository layout, local commands, change sequence, contract ownership, test expectations, and generated artifact boundaries.
docId: crm.development
locale: en
audience: both
contentVersion: 0.1.0
---

Use the repository's Volta pins: Node.js `24.18.0` and npm `11.15.0`. The runtime itself is JavaScript with explicit production dependencies; Astro and Starlight are development-only documentation dependencies.

## Repository map

| Path | Owner |
| --- | --- |
| `src/` | HTTP runtime, validation and provider adapters; memory is the deterministic default and PostgreSQL is an explicit durable deployment mode. |
| `contracts/` | Normative OpenAPI and event contracts. |
| `db/` | Production-target schema and row-level security migration. |
| `docs/` | Single reviewed source for human Web and agent MCP documentation. |
| `.agent/` | Versioned engineering governance and checkpoint routing. |
| User state root selected by `npm run agent:resume` | Machine-local session identity, agent edges, locks, and retries; never committed. |
| `test/` | Runtime and contract regression tests. |
| `scripts/` | Deterministic checks, builds, and cross-product verification. |
| `artifacts/docs-site/` | Generated documentation site and `_mcp` projection; ignored. |
| `dist/` | Generated runtime release candidate; ignored. |

## Local gates

```powershell
volta run npm ci
volta run npm run agent:health
volta run npm run agent:resume
volta run npm run verify:release
volta run npm run verify:mcp
volta run npm run smoke:docker
volta run npm run sbom
```

`verify:release` runs the dependency audit, `verify`, and bounded load/fault drills. `verify` covers protocol drift/typecheck, runtime and disposable-PostgreSQL tests, repository/agent checks, the reproducible runtime build, dist smoke, Astro type checks, and static-site projection verification. `verify:mcp` additionally requires a built sibling Sumi-Docs-MCP checkout and exercises all four MCP tools against the generated site. `smoke:docker` is intentionally separate because it requires a usable Docker daemon and remains mandatory release evidence.

`test:postgres` is the C2 database gate. It requires PostgreSQL client/server
binaries on `PATH`, creates an isolated temporary cluster and database, applies
the migration twice, exercises two-tenant `FORCE RLS`, commits and rolls back a
CRM + command + audit + outbox transaction, then destroys the cluster. It must
never target a shared database.

## Change sequence

1. Read `AGENTS.md`, the reviewed agent cursor, the owning contract or ADR, and the relevant checkpoint card; then re-probe Git and CI.
2. Add a failing test for an externally visible regression or contract change.
3. Update normative types or contracts before adapters and transport code.
4. Keep model output untrusted; validate authorization, schema, policy, idempotency, and transaction boundaries outside the model.
5. Update English and Chinese core documentation when behavior or operator workflow changes.
6. Run the gates above and record failures as failures.

## Protocol change sequence

`contracts/openapi.yaml` and `contracts/events.yaml` are normative sources.
After a contract change, run `npm run protocol:generate`, inspect source and
generated diffs together, then run `npm run protocol:check` and
`npm run protocol:typecheck`. Frontend code imports `@sumi/voice-crm-api-client`
and never declares a parallel request/response DTO. A breaking change requires
a major protocol/event version, consumer inventory, migration window and
rollback to the previous source/projection pair.

## Running both surfaces

```powershell
# Terminal 1: CRM reference API
npm start

# Terminal 2: documentation authoring
npm run docs:dev -- --host 127.0.0.1 --port 4321
```

The two processes are deliberately independent. Documentation must remain buildable when no CRM service or provider credential is available.
