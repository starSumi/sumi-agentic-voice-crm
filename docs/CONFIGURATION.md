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

Development defaults to the in-memory store, development bearer identity, memory objects, and deterministic providers. Production has no fallback: startup requires `STORE_PROVIDER=postgres`, `AUTH_MODE=oidc` or `AUTH_MODE=static`, `OBJECT_STORAGE_PROVIDER=s3`, an HTTPS `PUBLIC_BASE_URL`, and a metrics bearer token. ASR and TTS select `openai-compatible` or `dashscope`; intent may also select `agent-crm-http`. `mock` is rejected in production.

| Boundary         | Required production variables                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity         | Multi-user OIDC: issuer, audience, JWKS URI and canonical action scopes. Private single-tenant: `AUTH_STATIC_BEARER_TOKEN`, `AUTH_STATIC_TENANT_ID`, `AUTH_STATIC_SUBJECT`, optional `AUTH_STATIC_ROLE` and `AUTH_STATIC_SCOPES` |
| Database/privacy | `DATABASE_URL`; either legacy `DATA_ENCRYPTION_KEY` or `DATA_ENCRYPTION_KEYS` plus `DATA_ENCRYPTION_ACTIVE_KEY_ID`; interaction payloads use AES-256-GCM                                                                                      |
| Media            | S3-compatible bucket, region and optional endpoint/KMS key; signed URL TTL is 15-900 seconds                                                                                                                                     |
| Providers        | Credentials and HTTPS base URL for every selected adapter; explicit OpenAI intent model when that adapter owns intent                                                                                                            |
| Relay            | worker-specific target, tenant list, HMAC secret, retry/lease/batch controls                                                                                                                                                     |
| Operations       | `METRICS_BEARER_TOKEN`; `GET /health/ready` probes database, object storage, providers, and registered extensions; `OBSERVABILITY_MODE=manual` (default) or explicit `otel`; bounded ingress rate settings                       |
| Async messages   | `MESSAGE_JOB_TENANT_IDS` enables recovery polling for listed tenants; optional `MESSAGE_JOB_BATCH_SIZE`, `MESSAGE_JOB_LEASE_MS`, `MESSAGE_JOB_MAX_ATTEMPTS`, and `MESSAGE_JOB_POLL_INTERVAL_MS` tune the managed worker |

Run the API with `pnpm start` and the independent transactional-outbox worker with `pnpm run start:outbox`. Give the worker only database, encryption and delivery credentials; it does not need model credentials.

## Provider adapters

| Selector            | Required settings                                                                  | Protocol behavior                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `mock`              | None; development only                                                             | Deterministic ASR, intent and TTS fixtures                                                                        |
| `openai-compatible` | `OPENAI_API_KEY`, HTTPS `OPENAI_BASE_URL`; `OPENAI_MODEL` when selected for intent | Audio transcriptions, strict-schema Responses intent extraction, and binary speech output                         |
| `dashscope`         | `DASHSCOPE_API_KEY`, HTTPS `DASHSCOPE_BASE_URL`                                    | Qwen ASR and JSON Object intent over the compatible Chat Completions API; Qwen TTS over the native generation API |
| `agent-crm-http`    | HTTPS `AGENT_CRM_HTTP_URL`, `AGENT_CRM_HTTP_MODEL`, `AGENT_CRM_HTTP_CALLER_ID`      | Intent-only adapter for a double-encoded Agent CRM JSON envelope; ASR and TTS must use another provider            |

OpenAI TTS maps the public `voice=default` to `OPENAI_TTS_VOICE` (default `alloy`) and maps public `format=ogg` to the provider's `opus` response format. `OPENAI_TTS_MAX_BYTES` (or the shared `PROVIDER_TTS_MAX_BYTES`) bounds the binary response.

DashScope defaults are `qwen-plus`, `qwen3-asr-flash`, `qwen3-tts-flash`, and voice `Cherry`. `DASHSCOPE_TTS_MAX_BYTES` bounds inline and downloaded audio; the default is 10 MiB. Native TTS currently returns WAV, so `dashscope` rejects other requested formats. The ask flow reads the selected adapter's default and requests WAV automatically. To stay inside the documented Qwen TTS 512-token limit without silently splicing audio, the adapter applies a conservative 512-character preflight; longer or unsupported locales return `INVALID_REQUEST`.

`PROVIDER_SOFT_TIMEOUT_MS` defaults to 10 seconds and is capped at 120 seconds.
At that deadline the child `AbortSignal` requests cooperative cleanup.
`PROVIDER_HARD_GRACE_MS` defaults to 2 seconds and is capped at 30 seconds; only
a supervised process extension can be physically terminated after that grace.
`PROVIDER_TIMEOUT_MS` remains a deprecated soft-timeout fallback for existing
deployments. `INTERACTION_LEASE_MS` defaults to 30 seconds and is capped at 15
minutes. `RUNTIME_TEARDOWN_MS` defaults to 3000 ms and is capped at 30 seconds;
it bounds managed background-task cleanup and HTTP drain before forced
connection closure. TTS provider responses and stored audio share a 25 MiB cap.

PostgreSQL uses independent connection, client query, server statement, and
idle-in-transaction budgets. Their defaults are 5, 30, 30, and 60 seconds via
the `DATABASE_*_TIMEOUT_MS` variables. The in-process `/v1/*` ingress limiter
defaults to 120 requests per source per 60 seconds with at most 10,000 active
keys. A multi-instance deployment must also enforce coordinated limits at its
gateway.

`DATA_ENCRYPTION_KEYS` is a JSON object from stable key IDs to base64-encoded
32-byte keys; `DATA_ENCRYPTION_ACTIVE_KEY_ID` selects the key used for new
`v2` envelopes. Keep retired keys available while their envelopes remain in
PostgreSQL. `DATA_ENCRYPTION_KEY` continues to decrypt and write legacy `v1`
envelopes during migration.

The asynchronous ask path is opt-in through `Prefer: respond-async`. It writes
an encrypted durable message receipt before returning; `MESSAGE_JOB_TENANT_IDS`
must include a tenant for a worker to recover queued jobs after a restart. The
receipt state machine and tenant-scoped event-consumer receipts are backed by
the PostgreSQL migration `005_message_jobs_and_inbox.sql`.

## Tracing

`OBSERVABILITY_MODE=manual` is the default and emits no network traffic. It keeps
low-cardinality W3C-compatible trace correlation plus explicit redacted spans
for HTTP, application, provider, storage and transaction boundaries. Set
`OBSERVABILITY_MODE=otel` only when an OTLP/HTTP collector is available.
`OTEL_SERVICE_NAME` accepts a short stable service name. The standard
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, and
`OTEL_EXPORTER_OTLP_HEADERS` variables configure trace and metric exporters;
`OTEL_METRIC_EXPORT_INTERVAL_MS` defaults to 60 seconds. Automatic Node, HTTP,
fetch, PostgreSQL and provider
instrumentation is deliberately disabled; Sumi never exports request bodies,
transcripts, audio, tokens, SQL parameters, or signed URL query strings.

`DASHSCOPE_AUDIO_HOST_SUFFIXES` may extend the built-in allowlist for signed TTS audio downloads. Leave it empty for the official `dashscope-result-*.oss-*.aliyuncs.com` pattern. Every hop is upgraded or restricted to HTTPS, manually redirected, revalidated, size bounded, and checked against audio magic bytes.

Existing deployments may keep `ALIYUN_BASE_APIKEY`, `ALIYUN_BASE_URL`, `ALIYUN_BASE_MODEL`, and the corresponding `ALIYUN_ASR_*`/`ALIYUN_TTS_*` variables. They are aliases; `DASHSCOPE_*` takes precedence when both namespaces are present.

`agent-crm-http` sends `request_id`, a required non-PII `sumi-caller-<UUID>` identifier in the upstream `phone_number` compatibility field, and the transcript as `query`. Phone-number-shaped values are rejected before readiness. It bounds and validates both JSON layers, requires the upstream request and caller identifiers to be echoed, and applies the current Agent CRM output contract before returning an understanding. `AGENT_CRM_HTTP_BEARER_TOKEN` is optional. This adapter is intentionally limited to intent so an ephemeral model service cannot silently replace ASR or TTS.

## Documentation settings

| Variable        | Default                 | Effect                                                                                          |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `DOCS_SITE_URL` | `http://127.0.0.1:4321` | Canonical URL used by the Astro documentation build. Set it to the deployed HTTPS origin in CI. |

Use `pnpm run docs:dev` for live authoring and `pnpm run docs:build` for the production artifact in `artifacts/docs-site/`. The documentation build does not start the CRM API and the CRM runtime does not require Astro.

## Development and production separation

- Development may use loopback HTTP, deterministic providers, synthetic tenants, and the in-memory store.
- `AUTH_MODE=static` is intended for a private single-tenant operator deployment. The configured token fixes tenant, actor, role and action-scope ceiling; a conflicting `X-Tenant-Id` is rejected. `AUTH_STATIC_SCOPES` is a comma/space separated canonical action list or an explicitly supported `crm.*`/`media.*` wildcard. Rotate the token by replacing the secret and restarting the API. Use OIDC when multiple independent users, browser login, per-user revocation, or delegated scopes are required.
- Staging must use non-production credentials, durable backing services, representative media, and contract-compatible providers.
- Production requires security, staging, resilience, rollback, and release gates to pass. Fail-closed configuration is implementation evidence, not deployment approval.
- Never put bearer tokens, API keys, customer audio, transcripts, or production connection strings in `.env.example`, Markdown, tests, or Git history.

## Startup example

```powershell
$env:PORT = "8080"
$env:AUTH_MODE = "development"
$env:STORE_PROVIDER = "memory"
pnpm run dev
```

Confirm effective behavior through `GET /health/ready`; configured names alone are not proof of provider quality or production connectivity.
