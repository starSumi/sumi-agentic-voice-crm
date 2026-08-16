# Sumi Agentic Voice CRM

## Repository contract

- This repository is the owned implementation of the Sumi Agentic Voice CRM reference platform.
- `src/` is runtime source; `contracts/` is the protocol source of truth; `docs/` is design and operating evidence.
- Frontend consumers under the manifest-declared roots must import operations and types from `packages/api-client/src/index.ts`; do not hand-write transport DTOs or raw `/v1/` HTTP calls. Run `pnpm run contract:consumer-check` after consumer changes.
- `docs/` is also the single reviewed content source for the Starlight Web site and Sumi Docs MCP projection. Do not maintain a copied content tree under `src/`.
- `.agent/` contains versioned project governance, maintainer ownership, and the reviewed handoff cursor. Live session state belongs outside the repository under `CODEX_HOME`, `XDG_STATE_HOME`, or `LOCALAPPDATA` according to `pnpm run agent:resume`; ignored `.agent-runtime/` is only an explicit local fallback.
- External projects (`saathi-crm`, Northstar/CopilotKit) are inspiration and comparative evidence only. Do not copy their source, prose, screenshots, or credentials.
- Keep provider credentials out of Git. Use `.env` locally and a secret manager in deployment.
- Every CRM mutation must pass tenant authorization, schema validation, idempotency, transaction boundary, and audit/outbox write.
- Every source-sensitive claim in docs must include a source identity or be labeled `inferred`/`unknown`.

## Commands

```powershell
pnpm test                 # node:test contract/unit suite
pnpm run check            # JSON/OpenAPI/SQL/docs/repo invariants
pnpm run check:agent      # versioned agent governance and ignore boundaries
pnpm run agent:health     # maintainer, cursor and control-plane freshness
pnpm run agent:resume     # restore or atomically capture external session state
pnpm run build            # release artifact assembly and reproducibility checks
pnpm run docs:build       # type-check and build Web plus _mcp projection
pnpm run verify           # CI-equivalent runtime, governance and docs gates
pnpm run verify:mcp       # all four MCP tools against the built site
pnpm start                # local server on :8080
```

Use Node.js 24.18.0 or newer. Generated runtime output belongs in `dist/`; generated documentation belongs in `artifacts/docs-site/`. Both remain ignored.

At session start, run `git status --short --branch`, `pnpm run agent:health`, and `pnpm run agent:resume`, then read the current cursor and checkpoint. Treat the cursor as a reviewed checkpoint, not as live truth; re-probe Git and CI before acting. Human acceptance remains mandatory for checkpoint completion and release.

Use `apply_patch` for edits. Preserve unrelated files and inspect `git status` before/after work.
