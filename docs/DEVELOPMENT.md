---
title: Development workflow
description: Repository layout, local commands, change sequence, contract ownership, test expectations, and generated artifact boundaries.
docId: crm.development
locale: en
audience: both
contentVersion: 0.1.0
---

Use Node.js `24.18.0` or newer and npm `11.15.0`. The runtime itself is standard-library JavaScript; Astro and Starlight are development dependencies used only for documentation.

## Repository map

| Path | Owner |
| --- | --- |
| `src/` | Reference HTTP runtime, validation, providers, and in-memory state. |
| `contracts/` | Normative OpenAPI and event contracts. |
| `db/` | Production-target schema and row-level security migration. |
| `docs/` | Single reviewed source for human Web and agent MCP documentation. |
| `.agent/` | Versioned engineering governance and checkpoint routing. |
| `test/` | Runtime and contract regression tests. |
| `scripts/` | Deterministic checks, builds, and cross-product verification. |
| `artifacts/docs-site/` | Generated documentation site and `_mcp` projection; ignored. |
| `dist/` | Generated runtime release candidate; ignored. |

## Local gates

```powershell
npm ci
npm run verify
npm run verify:mcp
```

`verify` runs runtime tests, repository checks, the reproducible runtime build, Astro type checks, the static site build, and projection verification. `verify:mcp` additionally requires a built sibling Sumi-Docs-MCP checkout and exercises all four MCP tools against the generated site.

## Change sequence

1. Read `AGENTS.md`, the owning contract or ADR, and the relevant checkpoint card.
2. Add a failing test for an externally visible regression or contract change.
3. Update normative types or contracts before adapters and transport code.
4. Keep model output untrusted; validate authorization, schema, policy, idempotency, and transaction boundaries outside the model.
5. Update English and Chinese core documentation when behavior or operator workflow changes.
6. Run the gates above and record failures as failures.

## Running both surfaces

```powershell
# Terminal 1: CRM reference API
npm start

# Terminal 2: documentation authoring
npm run docs:dev -- --host 127.0.0.1 --port 4321
```

The two processes are deliberately independent. Documentation must remain buildable when no CRM service or provider credential is available.
