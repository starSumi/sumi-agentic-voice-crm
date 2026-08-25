# Sumi Agentic Voice CRM

## Repository contract

- This repository is the owned implementation of the Sumi Agentic Voice CRM reference platform.
- `src/` is runtime source; `contracts/` is the protocol source of truth; `docs/` is design and operating evidence.
- Frontend consumers under the manifest-declared roots import operations from `@sumi/voice-crm-api-client/api` and data/event types from `@sumi/voice-crm-api-client/protocol`; the root index is compatibility-only. Do not hand-write transport DTOs or raw `/v1/` HTTP calls. Run `pnpm run contract:consumer-check` after consumer changes.
- `docs/` is also the single reviewed content source for the Starlight Web site and Sumi Docs MCP projection. Do not maintain a copied content tree under `src/`.
- `orchestration/orchestration.yaml` is the development-orchestration desired state. `.codex/agents/*.toml` and `.agents/skills/sumi-orchestration/agents/openai.yaml` are generated adapters. Run `pnpm run orchestration:check`; never commit live plan/task state or approval decisions.
- `.agent/` is a retired legacy path and `.local/` is machine-local evidence. Both remain ignored and must not be used as product, release, or CI evidence.
- Keep provider credentials out of Git. Use `.env` locally and a secret manager in deployment.
- Every CRM mutation must pass tenant authorization, schema validation, idempotency, transaction boundary, and audit/outbox write.
- `contracts/control-plane-policy.json` is the product control-plane philosophy as code. Events only wake reconcilers; durable state decides, status has one controller owner, and effects remain idempotent or CAS-guarded. Run `pnpm run control-plane:check` after controller, lifecycle, queue, lease, CAS, or readiness changes.

## Commands

```powershell
pnpm test                 # node:test contract/unit suite
pnpm run check            # JSON/OpenAPI/SQL/docs/repo invariants
pnpm run build            # release artifact assembly and reproducibility checks
pnpm run docs:build       # type-check and build Web plus _mcp projection
pnpm run verify           # deterministic local Nx graph; no external services
pnpm run verify:ci        # full CI graph, including disposable PostgreSQL
pnpm run workspace:projects # list the Nx project graph
pnpm run orchestration:check # validate orchestration and generated adapters
pnpm run verify:mcp       # all four MCP tools against the built site
pnpm start                # local server on :8080
```

Use Node.js 24.19.0 or newer. Generated runtime output belongs in `dist/`; generated documentation belongs in `artifacts/docs-site/`. Both remain ignored.

At session start, run `git status --short --branch`, inspect the WSL2 Commander
checkpoint outside this repository, and re-probe Git and CI before acting. Human
acceptance remains mandatory for release.

Use `apply_patch` for edits. Preserve unrelated files and inspect `git status` before/after work.
