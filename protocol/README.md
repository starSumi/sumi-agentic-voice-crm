# Sumi protocol workspace

This directory owns the generation policy for every externally observable Sumi
Voice CRM message. It is the protocol control plane, not another handwritten
copy of API types.

## Normative sources

| Surface | Normative source | Generated consumers |
| --- | --- | --- |
| HTTP request/response/error | `contracts/openapi.yaml` (OpenAPI 3.1) | `packages/api-client/src/generated/`, stable `api.ts`/`protocol.ts` facades, `protocol/schema/json/openapi.bundle.json` |
| Domain event envelope/type registry | `contracts/events.yaml` | `protocol/schema/json/events.bundle.json`, event validators and broker bindings |
| Persistence | `db/migrations/*.sql` | migration/runtime checks; never inferred from UI types |

`contracts/openapi.yaml` remains the single HTTP source because OpenAPI is the
published REST standard and already carries transport semantics. Do not create
handwritten frontend DTOs or duplicate backend request types.

## Generation contract

```text
contracts/openapi.yaml ──parse/normalize─> protocol/schema/json/openapi.bundle.json
contracts/events.yaml  ──parse/normalize─> protocol/schema/json/events.bundle.json
                                  │
                                  └─ openapi-ts ──> packages/api-client/src/generated/*
                                       ├─ protocol.ts: data/event types only
                                       └─ api.ts: HTTP operations and client policy
```

The server compiles its input validators from the JSON bundle. The
`openapi-ts.config.mjs` input is that generated JSON bundle (never YAML), so
runtime validation and the TypeScript client consume the same exact document.
The event bundle remains a standalone JSON Schema 2020-12 artifact because
CloudEvents are broker messages rather than REST operations; its event-type
registry also generates `packages/api-client/src/generated/events.gen.ts` for
typed broker consumers. CI regenerates all projections in a clean temporary
directory and fails on byte drift, including file additions and removals.
Generated files are checked in for version-pinned consumers, reviewable API
diffs, and offline builds; they must never be edited by hand.

New consumers import operations from `@sumi/voice-crm-api-client/api` and data
types from `@sumi/voice-crm-api-client/protocol`. The root entrypoint remains a
compatibility facade. This logical split does not create a second schema source.

## Change procedure

1. Change the normative OpenAPI/event source and its compatibility version.
2. Run `pnpm run protocol:generate`.
3. Review source and generated diffs together.
4. Run `pnpm run protocol:check`, `pnpm run protocol:typecheck`,
   `pnpm run contract:consumer-check`, and contract tests.
5. For a breaking change, add a major endpoint/event version, migration window,
   consumer inventory, deprecation telemetry, and rollback plan.

The exact generator version is pinned in `pnpm-lock.yaml`. Generator upgrades
are dedicated changes: regenerate, inspect semantic diff, run consumer compile
tests, and retain the previous generated package until the compatibility window
closes.
