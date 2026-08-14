---
title: Sumi Agentic Voice CRM
description: Entry point for operating, extending, reviewing, and querying the contract-first voice CRM reference platform.
docId: crm.index
locale: en
audience: both
contentVersion: 0.1.0
---

Sumi Agentic Voice CRM is an owned reference implementation for text and voice CRM workflows. It demonstrates the boundary between probabilistic understanding and deterministic business state: an agent may interpret intent and propose work, but authorization, validation, idempotency, transaction commit, audit, and human review decide what changes.

The current `0.1.0` runtime uses deterministic mock providers and an in-memory store. It is suitable for contract exploration and integration tests. It is not approved for production data, real customer audio, or public internet exposure.

## Choose a route

| Goal | Start here | Continue with |
| --- | --- | --- |
| Run the reference service | [Quickstart](/quickstart/) | [Configuration](/configuration/) |
| Integrate an API client | [API contract](/api/) | [OpenAPI source](https://github.com/starSumi/sumi-agentic-voice-crm/blob/main/contracts/openapi.yaml) |
| Understand state ownership | [Architecture](/architecture/) | [Lifecycle](/lifecycle/) and [data model](/data-model/) |
| Review safety controls | [Security](/security/) | [Events and audit](/events-audit/) |
| Contribute code or docs | [Development](/development/) | [Contributing](/contributing/) |
| Connect an AI developer | [Agent guide](/agent-guide/) | [Traceability](/traceability/) |
| Operate or recover | [Operations](/operations/) | [Troubleshooting](/troubleshooting/) |

## What is implemented

- HTTP `/v1/ask` for deterministic text and mock-audio flows.
- HTTP `/v1/tts/synthesize` for deterministic mock TTS assets.
- Tenant, actor, and idempotency validation at the request boundary.
- Structured understanding, low-confidence review, CRM command, audit, and outbox examples.
- OpenAPI 3.1, event, SQL migration, Postman, test, and reproducible build artifacts.
- One reviewed documentation corpus projected to this Web site and to Sumi Docs MCP.

## What remains a production target

Verified OIDC/JWT, PostgreSQL and row-level security integration, private object storage, real ASR/intent/TTS providers, durable queues, rate limiting, SLO evidence, signed artifacts, disaster recovery, and production approval remain open checkpoints. [Release readiness](/release-readiness/) is the authority for current evidence.

## Documentation contract

Files in `docs/` are the reviewed source. The Web build renders them for people and publishes bounded raw Markdown plus OpenAPI under `/_mcp/` for agents. Every published document carries a stable `docId`, BCP 47 locale, audience, and content version in frontmatter. See [localization and content identity](/localization/).
