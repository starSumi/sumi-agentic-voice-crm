# Sumi Agentic Voice CRM

## Repository contract

- This repository is the owned implementation of the Sumi Agentic Voice CRM reference platform.
- `src/` is runtime source; `contracts/` is the protocol source of truth; `docs/` is design and operating evidence.
- External projects (`saathi-crm`, Northstar/CopilotKit) are inspiration and comparative evidence only. Do not copy their source, prose, screenshots, or credentials.
- Keep provider credentials out of Git. Use `.env` locally and a secret manager in deployment.
- Every CRM mutation must pass tenant authorization, schema validation, idempotency, transaction boundary, and audit/outbox write.
- Every source-sensitive claim in docs must include a source identity or be labeled `inferred`/`unknown`.

## Commands

```powershell
npm test                 # node:test contract/unit suite
npm run check            # JSON/OpenAPI/SQL/docs/repo invariants
npm run build            # release artifact assembly and reproducibility checks
npm start                # local server on :8080
```

Use `apply_patch` for edits. Preserve unrelated files and inspect `git status` before/after work.
