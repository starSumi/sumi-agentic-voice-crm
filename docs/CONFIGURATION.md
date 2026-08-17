---
title: Configuration
description: Runtime and documentation settings, environment boundaries, defaults, secret handling, and development versus production expectations.
docId: crm.configuration
locale: en
audience: both
contentVersion: 0.1.0
---

Copy `.env.example` only when a launcher or deployment system loads it. Node.js does not read `.env` automatically in the current `pnpm start` command. PowerShell users can set variables in the current process with `$env:NAME = "value"`; production should inject them through the deployment platform or a secret manager.

## Effective runtime settings

Development defaults to the in-memory store, development bearer identity, memory objects, and deterministic providers. Production has no fallback: startup requires `STORE_PROVIDER=postgres`, `AUTH_MODE=oidc` or `AUTH_MODE=static`, `OBJECT_STORAGE_PROVIDER=s3`, each provider selector set to `openai-compatible` or `dashscope`, an HTTPS `PUBLIC_BASE_URL`, and a metrics bearer token. ASR, intent and TTS may select different adapters; `mock` is rejected in production.

| Boundary | Required production variables |
| --- | --- |
| Identity | Multi-user OIDC: issuer, audience, JWKS URI and required scope. Private single-tenant: `AUTH_STATIC_BEARER_TOKEN`, `AUTH_STATIC_TENANT_ID`, `AUTH_STATIC_SUBJECT` |
| Database/privacy | `DATABASE_URL`, base64 32-byte `DATA_ENCRYPTION_KEY`; interaction payloads use AES-256-GCM |
| Media | S3-compatible bucket, region and optional endpoint/KMS key; signed URL TTL is 15-900 seconds |
| Providers | Credentials and HTTPS base URL for every selected adapter; explicit OpenAI intent model when that adapter owns intent |
| Relay | worker-specific target, tenant list, HMAC secret, retry/lease/batch controls |
| Operations | `METRICS_BEARER_TOKEN`; `GET /health/ready` probes database, object storage, providers, and registered extensions; `OBSERVABILITY_MODE=manual` (default) or explicit `otel` |

Run the API with `pnpm start` and the independent transactional-outbox worker with `pnpm run start:outbox`. Give the worker only database, encryption and delivery credentials; it does not need model credentials.

## Provider adapters

| Selector | Required settings | Protocol behavior |
| --- | --- | --- |
| `mock` | None; development only | Deterministic ASR, intent and TTS fixtures |
| `openai-compatible` | `OPENAI_API_KEY`, HTTPS `OPENAI_BASE_URL`; `OPENAI_MODEL` when selected for intent | Audio transcriptions, strict-schema Responses intent extraction, and binary speech output |
| `dashscope` | `DASHSCOPE_API_KEY`, HTTPS `DASHSCOPE_BASE_URL` | Qwen ASR and JSON Object intent over the compatible Chat Completions API; Qwen TTS over the native generation API |

OpenAI TTS maps the public `voice=default` to `OPENAI_TTS_VOICE` (default `alloy`) and maps public `format=ogg` to the provider's `opus` response format. `OPENAI_TTS_MAX_BYTES` (or the shared `PROVIDER_TTS_MAX_BYTES`) bounds the binary response.

DashScope defaults are `qwen-plus`, `qwen3-asr-flash`, `qwen3-tts-flash`, and voice `Cherry`. `DASHSCOPE_TTS_MAX_BYTES` bounds inline and downloaded audio; the default is 10 MiB. Native TTS currently returns WAV, so `dashscope` rejects other requested formats. The ask flow reads the selected adapter's default and requests WAV automatically. To stay inside the documented Qwen TTS 512-token limit without silently splicing audio, the adapter applies a conservative 512-character preflight; longer or unsupported locales return `INVALID_REQUEST`.

`PROVIDER_SOFT_TIMEOUT_MS` defaults to 10 seconds and is capped at 120 seconds.
At that deadline the child `AbortSignal` requests cooperative cleanup.
`PROVIDER_HARD_GRACE_MS` defaults to 2 seconds and is capped at 30 seconds; only
a supervised process extension can be physically terminated after that grace.
`PROVIDER_TIMEOUT_MS` remains a deprecated soft-timeout fallback for existing
deployments. `INTERACTION_LEASE_MS` defaults to 30 seconds and is capped at 15
minutes. Provider audio limits are capped at 50 MiB.

## Tracing

`OBSERVABILITY_MODE=manual` is the default and emits no network traffic. It keeps
low-cardinality W3C-compatible trace correlation plus explicit redacted spans
for HTTP, application, provider, storage and transaction boundaries. Set
`OBSERVABILITY_MODE=otel` only when an OTLP/HTTP collector is available.
`OTEL_SERVICE_NAME` accepts a short stable service name and the standard
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` variables
configure the exporter. Automatic Node, HTTP, fetch, PostgreSQL and provider
instrumentation is deliberately disabled; Sumi never exports request bodies,
transcripts, audio, tokens, SQL parameters, or signed URL query strings.

`DASHSCOPE_AUDIO_HOST_SUFFIXES` may extend the built-in allowlist for signed TTS audio downloads. Leave it empty for the official `dashscope-result-*.oss-*.aliyuncs.com` pattern. Every hop is upgraded or restricted to HTTPS, manually redirected, revalidated, size bounded, and checked against audio magic bytes.

Existing deployments may keep `ALIYUN_BASE_APIKEY`, `ALIYUN_BASE_URL`, `ALIYUN_BASE_MODEL`, and the corresponding `ALIYUN_ASR_*`/`ALIYUN_TTS_*` variables. They are aliases; `DASHSCOPE_*` takes precedence when both namespaces are present.

## Documentation settings

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCS_SITE_URL` | `http://127.0.0.1:4321` | Canonical URL used by the Astro documentation build. Set it to the deployed HTTPS origin in CI. |

Use `pnpm run docs:dev` for live authoring and `pnpm run docs:build` for the production artifact in `artifacts/docs-site/`. The documentation build does not start the CRM API and the CRM runtime does not require Astro.

## Development and production separation

- Development may use loopback HTTP, deterministic providers, synthetic tenants, and the in-memory store.
- `AUTH_MODE=static` is intended for a private single-tenant operator deployment. The configured token fixes both tenant and actor identity; a conflicting `X-Tenant-Id` is rejected. Rotate the token by replacing the secret and restarting the API. Use OIDC when multiple independent users, browser login, per-user revocation, or delegated scopes are required.
- Staging must use non-production credentials, durable backing services, representative media, and contract-compatible providers.
- Production requires the open security, staging, resilience, and release checkpoints to be completed. Fail-closed configuration is implementation evidence, not deployment approval.
- Never put bearer tokens, API keys, customer audio, transcripts, or production connection strings in `.env.example`, Markdown, tests, or Git history.

## Startup example

```powershell
$env:PORT = "8080"
$env:AUTH_MODE = "development"
$env:STORE_PROVIDER = "memory"
pnpm run dev
```

Confirm effective behavior through `GET /health/ready`; configured names alone are not proof of provider quality or production connectivity.
