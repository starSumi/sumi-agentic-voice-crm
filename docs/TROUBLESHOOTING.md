---
title: Troubleshooting
description: Diagnose setup, runtime, contract, documentation build, MCP projection, and common request failures without losing evidence.
docId: crm.troubleshooting
locale: en
audience: both
contentVersion: 0.1.0
---

Start with the first failing command and its exit code. Preserve the request ID, tenant-safe trace context, and the exact runtime version. Do not solve a contract or authorization failure by weakening validation.

## Setup and build

| Symptom | Check | Resolution |
| --- | --- | --- |
| `npm ci` rejects the runtime | `node --version` and `.nvmrc` | Use Node `24.18.0` or newer. |
| Astro reports missing frontmatter | The named file under `docs/` | Add required `title`, `description`, `docId`, `locale`, `audience`, and `contentVersion`. |
| A human page exists but MCP omits it | `astro.config.mjs` document mappings | Add an explicit source, machine path, and page route; rebuild. |
| MCP URL returns 404 | `_mcp/sumi-docs-routes.json` and `--base-url` | Keep machine path and rendered route aligned; include a trailing slash in the base URL. |
| `verify:mcp` cannot find the server | `SUMI_DOCS_MCP_ENTRY` | Build the sibling Sumi-Docs-MCP repo or set the variable to its compiled `dist/index.js`. |

## Request failures

| Error | Meaning | Safe next step |
| --- | --- | --- |
| `UNAUTHORIZED` | Actor or tenant boundary is missing. | Provide valid scoped identity; do not infer tenant from content. |
| `INVALID_IDEMPOTENCY_KEY` | Key is absent or malformed. | Create one stable key for the logical operation. |
| `IDEMPOTENCY_CONFLICT` | The key was reused with different content. | Stop and reconcile the original operation; do not generate a new key automatically. |
| `UNSUPPORTED_MEDIA` | MIME or codec is outside the contract. | Convert or recapture input; preserve the original for diagnosis according to retention policy. |
| `EMPTY_TRANSCRIPT` | No usable speech was produced. | Ask for a new recording; do not invent text or execute CRM work. |
| `INTENT_LOW_CONFIDENCE` | Understanding is ambiguous. | Use the review task and keep CRM state unchanged. |
| `ASR_TIMEOUT` | Provider or model exceeded its budget. | Retry with the same idempotency context where allowed; inspect provider and queue health. |

## Documentation language or theme

Language and light/dark/auto theme controls are Web concerns. MCP clients read locale metadata and paths from raw documents. If a Chinese page is missing, Starlight may show the English fallback; the build verifier reports projection and identity mismatches.

## Escalation evidence

Include command, exit code, Node/npm versions, relevant request ID, sanitized response, affected document or endpoint, expected behavior, and whether rollback was attempted. Never attach tokens, customer audio, raw transcripts, or absolute local paths containing sensitive names.
