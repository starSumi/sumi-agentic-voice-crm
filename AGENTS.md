# Sumi Agentic Voice CRM

## Repository contract

- This repository is the owned implementation of the Sumi Agentic Voice CRM reference platform.
- `src/` is runtime source; `contracts/` is the protocol source of truth; `docs/` is design and operating evidence.
- `docs/` is also the single reviewed content source for the Starlight Web site and Sumi Docs MCP projection. Do not maintain a copied content tree under `src/`.
- `.agent/` contains versioned project governance. Machine-local runners, state, caches, reports and evidence belong in the ignored `.agent.*` runtime directories defined in `.gitignore`.
- External projects (`saathi-crm`, Northstar/CopilotKit) are inspiration and comparative evidence only. Do not copy their source, prose, screenshots, or credentials.
- Keep provider credentials out of Git. Use `.env` locally and a secret manager in deployment.
- Every CRM mutation must pass tenant authorization, schema validation, idempotency, transaction boundary, and audit/outbox write.
- Every source-sensitive claim in docs must include a source identity or be labeled `inferred`/`unknown`.

## Commands

```powershell
npm test                 # node:test contract/unit suite
npm run check            # JSON/OpenAPI/SQL/docs/repo invariants
npm run check:agent      # versioned agent governance and ignore boundaries
npm run build            # release artifact assembly and reproducibility checks
npm run docs:build       # type-check and build Web plus _mcp projection
npm run verify           # CI-equivalent runtime, governance and docs gates
npm run verify:mcp       # all four MCP tools against the built site
npm start                # local server on :8080
```

Use Node.js 24.18.0 or newer. Generated runtime output belongs in `dist/`; generated documentation belongs in `artifacts/docs-site/`. Both remain ignored.

Use `apply_patch` for edits. Preserve unrelated files and inspect `git status` before/after work.
