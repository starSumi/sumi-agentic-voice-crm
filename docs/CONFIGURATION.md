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

Development defaults to the in-memory store, development bearer identity, memory objects, and deterministic providers. Production has no fallback: startup requires `STORE_PROVIDER=postgres`, `AUTH_MODE=oidc`, `OBJECT_STORAGE_PROVIDER=s3`, all three providers set to `openai-compatible`, an HTTPS `PUBLIC_BASE_URL`, and a metrics bearer token.

| Boundary | Required production variables |
| --- | --- |
| Identity | `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, `OIDC_REQUIRED_SCOPE`; optional tenant-claim, algorithm and JWKS cache controls |
| Database/privacy | `DATABASE_URL`, base64 32-byte `DATA_ENCRYPTION_KEY`; interaction payloads use AES-256-GCM |
| Media | S3-compatible bucket, region and optional endpoint/KMS key; signed URL TTL is 15-900 seconds |
| Providers | OpenAI-compatible endpoint/key and ASR, intent and TTS model names |
| Relay | worker-specific target, tenant list, HMAC secret, retry/lease/batch controls |
| Operations | `METRICS_BEARER_TOKEN`; `GET /health/ready` probes database, object storage and provider state |

Run the API with `npm start` and the independent transactional-outbox worker with `npm run start:outbox`. Give the worker only database, encryption and delivery credentials; it does not need model credentials.

## Documentation settings

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCS_SITE_URL` | `http://127.0.0.1:4321` | Canonical URL used by the Astro documentation build. Set it to the deployed HTTPS origin in CI. |

Use `npm run docs:dev` for live authoring and `npm run docs:build` for the production artifact in `artifacts/docs-site/`. The documentation build does not start the CRM API and the CRM runtime does not require Astro.

## Development and production separation

- Development may use loopback HTTP, deterministic providers, synthetic tenants, and the in-memory store.
- Staging must use non-production credentials, durable backing services, representative media, and contract-compatible providers.
- Production requires the open security, staging, resilience, and release checkpoints to be completed. Fail-closed configuration is implementation evidence, not deployment approval.
- Never put bearer tokens, API keys, customer audio, transcripts, or production connection strings in `.env.example`, Markdown, tests, or Git history.

## Startup example

```powershell
$env:PORT = "8080"
$env:AUTH_MODE = "development"
$env:STORE_PROVIDER = "memory"
npm run dev
```

Confirm effective behavior through `GET /health/ready`; configured names alone are not proof of provider quality or production connectivity.
