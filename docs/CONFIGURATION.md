---
title: Configuration
description: Runtime and documentation settings, environment boundaries, defaults, secret handling, and development versus production expectations.
docId: crm.configuration
locale: en
audience: both
contentVersion: 0.1.0
---

Copy `.env.example` only when a launcher or deployment system loads it. Node.js does not read `.env` automatically in the current `npm start` command. PowerShell users can set variables in the current process with `$env:NAME = "value"`; production should inject them through the deployment platform or a secret manager.

## Effective runtime settings

The current runtime reads this small set directly:

| Variable | Default | Current effect |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port. |
| `PROVIDER_MODE` | `mock` | Reported by readiness output. Only deterministic mock behavior is implemented. |
| `ASR_PROVIDER` | `mock` | Reported by readiness output; no dynamic provider loading yet. |
| `INTENT_PROVIDER` | `mock` | Reported by readiness output; no dynamic provider loading yet. |
| `TTS_PROVIDER` | `mock` | Reported by readiness output; no dynamic provider loading yet. |

`APP_ENV`, database, object storage, JWT, and OpenAI variables in `.env.example` describe the intended promotion boundary. The reference runtime does not consume them yet. Do not infer that production integrations exist because placeholders are present.

## Documentation settings

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCS_SITE_URL` | `http://127.0.0.1:4321` | Canonical URL used by the Astro documentation build. Set it to the deployed HTTPS origin in CI. |

Use `npm run docs:dev` for live authoring and `npm run docs:build` for the production artifact in `artifacts/docs-site/`. The documentation build does not start the CRM API and the CRM runtime does not require Astro.

## Development and production separation

- Development may use loopback HTTP, deterministic providers, synthetic tenants, and the in-memory store.
- Staging must use non-production credentials, durable backing services, representative media, and contract-compatible providers.
- Production requires the open security, data, resilience, and release checkpoints to be completed. The repository currently says `not approved`.
- Never put bearer tokens, API keys, customer audio, transcripts, or production connection strings in `.env.example`, Markdown, tests, or Git history.

## Startup example

```powershell
$env:PORT = "8080"
$env:PROVIDER_MODE = "mock"
npm start
```

Confirm effective behavior through `GET /health/ready`; do not treat the configured provider name alone as proof that a real provider was loaded.
