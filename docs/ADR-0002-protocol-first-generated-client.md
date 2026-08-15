---
title: "ADR-0002: Protocol-first generated API clients"
description: The contract generation decision for keeping frontend, gateway, services and tests aligned.
docId: crm.decision.0002-protocol-first
locale: en
audience: both
contentVersion: 0.1.0
---

**Status:** Accepted for implementation
**Date:** 2026-08-14
**Decision owner:** protocol-owner
**Scope:** REST API requests/responses/errors and their generated consumers

## Context

Handwritten frontend DTOs, backend validators, OpenAPI examples and Postman
payloads create multiple interpretations of the same voice CRM operation. A
contract can appear documented while the running server accepts a different
shape. Codex's local app-server protocol demonstrates a useful principle:
typed protocol definitions are the source, and JSON Schema/TypeScript fixtures
are generated and checked against the source at build time. Sumi adopts that
principle while retaining REST-native OpenAPI rather than copying Codex's
JSON-RPC transport.

## Decision

1. `contracts/openapi.yaml` is the normative HTTP protocol source (OpenAPI
   3.1.0 / JSON Schema 2020-12 semantics). `contracts/events.yaml` is the
   normative event registry and CloudEvents envelope source.
2. `protocol/protocol.manifest.json` owns protocol version, source ownership,
   compatibility policy, generated locations and rollback rules.
3. `npm run protocol:generate` produces:
   - `protocol/schema/json/openapi.bundle.json` for runtime validation and
     schema tooling;
   - `protocol/schema/json/events.bundle.json` for event envelope validation;
   - `packages/api-client/src/generated/` for the browser/frontend SDK.
4. Generated projections are committed for reproducible/offline builds but are
   never edited directly. Their headers identify the generator. The protocol
   owner reviews source and generated diffs as one change.
5. The server validates JSON `/v1/ask` and `/v1/tts/synthesize` payloads against
   the generated JSON bundle before provider or CRM side effects, and validates
   every emitted event against the generated event bundle. Provider
   adapters remain behind their own capability contracts.
6. CI runs generation in an isolated temporary directory and fails when the
   committed projections drift. It also type-checks the generated frontend
   package and runs contract tests against the live route.
7. Breaking changes require a major protocol/event version, consumer inventory,
   deprecation window, migration plan and rollback to the last compatible
   source/projection pair. Additive fields are the default evolution path.

## Ownership and boundaries

| Surface | Owner | May change | May not do |
| --- | --- | --- | --- |
| OpenAPI/events and compatibility | `protocol-owner` | source schemas, versions, examples | edit generated files or bypass review |
| Generated frontend SDK | build pipeline | regenerate exact projections | add business behavior or hand patches |
| Gateway/runtime validation | `agent-runtime-owner` | adapter wiring and error mapping | widen accepted input outside protocol |
| Frontend integration | `frontend-owner` | import generated SDK, UI behavior and audio fallback | define duplicate DTOs or edit generated files |
| CI drift gate | `platform-owner` | pin tool versions and checks | approve breaking protocol alone |

## Generation and request flow

```text
OpenAPI source ──parse──> JSON Schema bundle ──load──> gateway validator
       │                         │
       └────openapi-ts────> typed TS client ──> frontend/PWA
       │
       └────examples/Postman/contract tests (review evidence)
```

At runtime: authenticate and resolve tenant → validate protocol shape →
normalize media/text → ASR/intent/TTS adapters → CRM command policy →
transaction + audit + outbox → typed response. Validation failure stops before
provider calls or CRM mutations. The protocol is an input boundary, not a
permission boundary; authorization and business policy remain separate checks.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Handwritten TypeScript interfaces | Drift is invisible to CI and clients can accept unsupported fields. |
| Generate OpenAPI from route implementation | Runtime code is not a stable compatibility review surface. |
| JSON Schema only | Loses REST operation, header, media and response semantics. |
| Copy Codex's app-server protocol | Wrong transport/domain; use the source→projection discipline, not its source tree. |

## Acceptance and rollback

ADR acceptance requires `protocol:generate`, `protocol:check`,
`protocol:typecheck`, `test`, `check`, and `build` to pass, plus a reviewed
source/generated diff. Rollback restores the prior OpenAPI/events source and
its generated pair; no generated artifact is deleted to hide a compatibility
break. Runtime provider or TTS failure can still degrade to the documented text
response without changing the protocol version.
