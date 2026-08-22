---
title: Development workflow
description: Repository layout, local commands, change sequence, contract ownership, test expectations, and generated artifact boundaries.
docId: crm.development
locale: en
audience: both
contentVersion: 0.1.0
---

Use Node.js `24.19.0` or newer, the repository `packageManager` pin
`pnpm@10.33.4`, and the exact Rust toolchain in `rust-toolchain.toml`. The
application runtime is native ESM migrating to TypeScript's erasable syntax;
Node executes the typed modules directly while `typecheck:runtime` enforces the
same boundary statically. The Linux process-lifecycle supervisor is a small
Rust workspace member. pnpm owns the JavaScript workspace and Nx owns its
cross-language project/task graph; Cargo remains the Rust build and dependency
authority. Astro and Starlight are development-only documentation dependencies.

## Optional Nix shell

Linux and WSL2 contributors may enter the pinned development shell with
`nix develop`. The flake supplies Node 24, Git, jq, OpenSSL, Python, build tools,
PostgreSQL 17 tools, exact pnpm `10.33.4`, Rust, Cargo, Clippy, rustfmt, and
Docker/Compose clients. It
deliberately does not run `pnpm install`, start a daemon, start Compose, or
replace the pnpm lockfile and Docker release path.

```bash
nix develop
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm run rust:check` performs rustfmt, Clippy with warnings denied, and locked
workspace tests. `pnpm run rust:build` produces the release supervisor binary;
the normal build copies it into `dist/bin`.

`flake.lock` pins nixpkgs. Update it as a reviewed dependency change and rerun
both `nix flake check` and the normal pnpm verification gates.

## Repository map

| Path                                            | Owner                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`                                          | HTTP runtime, validation and provider adapters; memory is the deterministic default and PostgreSQL is an explicit durable deployment mode. |
| `packages/api-client/`                          | Workspace package containing generated transport projections and stable API/type facades.                                                  |
| `crates/runtime-supervisor/`                    | Cargo and Nx project for the Linux process-lifecycle boundary.                                                                             |
| `contracts/`                                    | Normative OpenAPI and event contracts.                                                                                                     |
| `db/`                                           | Production-target schema and row-level security migration.                                                                                 |
| `docs/`                                         | Single reviewed source for human Web and agent MCP documentation.                                                                          |
| `orchestration/`                                | Versioned desired state, schemas and TypeScript scheduling engine for development work; excluded from product artifacts.                   |
| `.codex/`, `.agents/skills/sumi-orchestration/` | Generated repository-tool adapters; no live plan, transcript, credential or approval state.                                                |
| `.agent/`, `.local/`                            | Retired legacy path and machine-local evidence; ignored and never used by CI or release.                                                   |
| `test/`                                         | Runtime and contract regression tests.                                                                                                     |
| `scripts/`                                      | Deterministic checks, builds, and cross-product verification.                                                                              |
| `flake.nix`, `flake.lock`                       | Optional pinned Linux/WSL2 development shell; not a release or package-manager replacement.                                                |
| `artifacts/docs-site/`                          | Generated documentation site and `_mcp` projection; ignored.                                                                               |
| `dist/`                                         | Generated runtime release candidate; ignored.                                                                                              |

## Local gates

```powershell
pnpm install --frozen-lockfile
pnpm run workspace:projects
pnpm verify:release
pnpm verify:mcp
pnpm smoke:docker
pnpm sbom
```

`verify:release` runs the dependency audit, `verify`, and bounded load/fault drills. `verify` covers protocol drift/typecheck, runtime and disposable-PostgreSQL tests, repository checks, the reproducible runtime build, dist smoke, Astro type checks, and static-site projection verification. `verify:mcp` additionally requires a built sibling Sumi-Docs-MCP checkout and exercises all four MCP tools against the generated site. `smoke:docker` is intentionally separate because it requires a usable Docker daemon and remains mandatory release evidence.

`test:postgres` is the database integration gate. It requires PostgreSQL client/server
binaries on `PATH`, creates an isolated temporary cluster and database, applies
the migration twice, exercises two-tenant `FORCE RLS`, commits and rolls back a
CRM + command + audit + outbox transaction, then destroys the cluster. It must
never target a shared database.

## Change sequence

1. Read `AGENTS.md` and the owning contract or ADR; then re-probe Git and CI.
2. Add a failing test for an externally visible regression or contract change.
3. Update normative types or contracts before adapters and transport code.
4. Keep model output untrusted; validate authorization, schema, policy, idempotency, and transaction boundaries outside the model.
5. Update English and Chinese core documentation when behavior or operator workflow changes.
6. Run the gates above and record failures as failures.

## Protocol change sequence

Each transport boundary has one language-neutral source. Public HTTP uses
`contracts/openapi.yaml`, durable events use `contracts/events.yaml`, and the
local Node/Rust supervisor uses `contracts/runtime-supervisor.schema.json`.
After a contract change, run `pnpm protocol:generate`, inspect source and
generated diffs together, then run `pnpm protocol:check`,
`pnpm protocol:typecheck`, and `pnpm contract:consumer-check`. Frontend code
imports operations from `@sumi/voice-crm-api-client/api`, types from
`@sumi/voice-crm-api-client/protocol`, and never declares a parallel
request/response DTO or raw `/v1/` transport. A breaking change requires
a major protocol/event version, consumer inventory, migration window and
rollback to the previous source/projection pair.

## Running both surfaces

```powershell
# Terminal 1: CRM reference API
pnpm start

# Terminal 2: documentation authoring
pnpm docs:dev -- --host 127.0.0.1 --port 4321
```

The two processes are deliberately independent. Documentation must remain buildable when no CRM service or provider credential is available.
