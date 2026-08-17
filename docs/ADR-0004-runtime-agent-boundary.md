---
title: "ADR-0004: Runtime core, agent plane, and client adapters"
description: Define the transport-independent runtime boundary for web, desktop, TUI, MCP, and AG-UI clients.
docId: crm.decision.0004-runtime-agent-boundary
locale: en
audience: both
contentVersion: 0.1.0
---

**Status:** Accepted; incremental migration in progress
**Date:** 2026-08-16
**Decision owner:** Sumi platform engineering

## Decision

Sumi is split into two server-side planes and several thin client adapters:

1. **Runtime core** owns authentication context, tenant isolation, idempotency,
   application services, attachment lifecycle, persistence transactions, audit,
   outbox, durable domain events, and read models. It does not import a UI,
   MCP SDK, provider SDK, or Node HTTP request/response object.
2. **Agent plane** owns model interaction, provider selection, intent
   normalization, tool selection, safety policy, and review requests. Agent
   output is untrusted until the runtime core validates and authorizes it.
3. **Adapters** project the same application services for HTTP/OpenAPI, SSE or
   AG-UI, MCP tools/resources, desktop, TUI, and future internal IPC. An adapter
   may translate envelopes and streaming events, but it cannot write CRM state
   directly or bypass review, audit, idempotency, or outbox rules.

The browser is not a control plane. Any frontend registry is limited to view
components and state projection; authority and capability registration remain on
the server.

## State and events

The durable state model is intentionally flat and correlated by opaque IDs:
`run/interaction`, `step`, `attachment`, `review`, `command`, and `event`.
CloudEvents and the transactional outbox are the durable business stream.
Ephemeral UI events are projections and must never be treated as CRM truth or
as a substitute for the audit log.

All media and future non-text inputs use an attachment reference boundary:
tenant, opaque asset ID, MIME type, byte length, content hash, storage key,
status, expiry, and authorization metadata. Raw audio or other large payloads
may appear only at an authenticated ingress or provider boundary; events and
UI snapshots carry references, summaries, and hashes instead of bytes.

The application service may emit bounded progress milestones through an
optional event sink. It must not emit hidden chain-of-thought, prompts,
credentials, signed URL query strings, raw transcripts, or customer entities.

## Transport choices

- HTTP/OpenAPI remains the command and query contract for the current web
  client and generated SDK.
- SSE is the default incremental projection for browser-facing progress. An
  AG-UI adapter is additive and calls the same application service; it does not
  replace OpenAPI, CloudEvents, PostgreSQL, or the outbox.
- MCP is an extension boundary for agent tools and documentation resources. A
  future CRM MCP server must be a thin adapter over application services with
  explicit tenant, actor, scope, and idempotency mapping. The documentation MCP
  server remains read-only and separate from CRM mutation tools.
- gRPC is reserved for a later, independently deployed internal service split.
  Introducing it now would create a second transport/schema surface and require
  a browser gateway. WebSocket is reserved for a proven need for bidirectional,
  low-latency media or control; ordinary progress does not justify it.

## Protocol and API direction

Protocol and API are separate dependencies even when generated into one
workspace package. `@sumi/voice-crm-api-client/protocol` exports data and event
types only. `@sumi/voice-crm-api-client/api` owns HTTP operations, client
configuration, transport errors, timeout and authentication-header policy. The
root export remains a compatibility facade. All projections still come from the
same reviewed OpenAPI and event contracts; package separation must not create a
parallel DTO source.

There are two different API directions:

1. Web, desktop, and TUI clients consume the inbound Sumi API. The server-side
   application core implements that contract and never calls its own HTTP client.
2. The Agent plane consumes outbound model-provider APIs. It constructs a
   vendor-neutral internal item, a provider adapter maps that item to an OpenAI
   Responses, DashScope, or future local request, the transport serializes HTTP
   and parses SSE, and the adapter maps provider events back to internal Agent
   events before session state changes.

Names such as `ResponsesApiRequest` and provider-specific SSE events stay inside
the corresponding provider adapter. `ResponseItem`, `ContentItem`, or `TurnItem`
may enter the shared protocol only after Sumi defines their vendor-neutral schema,
ordering, compatibility, and redaction rules. SQ/EQ modes are not current Sumi
protocol terms and must not be invented without a reviewed contract.

The current generated client implements request/response HTTP operations and
client configuration only. It does not yet expose a provider-independent
Responses SSE parser. That parser belongs in the API/provider adapter after its
event ordering, cancellation, resume, error, and compatibility contract is
reviewed; the application core will consume the mapped internal event stream.

## Extension and plugin boundary

Provider adapters, MCP servers, and UI projections are extensions, but arbitrary
third-party code is not loaded into the runtime process. The implemented
extension manifest pins an exact version, protocol version, owner, isolation,
capabilities, permissions, dependencies, and entrypoint. The registry uses a
deployment permission allowlist, explicit trusted IDs for in-process code,
dependency-ordered startup, reverse shutdown, bounded health checks, and only
permission-scoped ports.

`process` means the deployment supplied a trusted launcher that actually creates
and supervises another process. A manifest and `terminate()` method alone are not
an OS sandbox. The registry never imports a manifest entrypoint dynamically and
never passes the environment snapshot to an extension. Credentials remain a
deployment concern. `.mcp.json` is a client/server registration file, not an
authority grant.

The Control Engine owns keyed, epoch-aware CAS circuit breakers and extension
lifecycle. Provider and outbox operations receive a child `AbortSignal`: after a
10 second soft deadline cooperative cleanup begins, and after a further 2 second
grace a process supervisor may terminate isolated work. In-process JavaScript
cannot be physically killed, so hard-stop hooks are only a real kill boundary for
supervised processes.

## Consequences

The first migration extracts Ask, TTS, and Review services behind explicit ports,
then adds progress sinks and attachment schemas. Desktop/TUI and CRM MCP can be
added without copying business logic. The cost is an internal command/result
model in addition to generated HTTP types; this is intentional because
transport envelopes and domain state have different lifecycles.

## Rollback

Disable a new adapter or extension registration. Existing HTTP/OpenAPI,
PostgreSQL, audit, outbox, and documentation MCP flows remain usable. No
database rollback is required for ephemeral UI projections; durable schema
changes still require the normal migration and restore gate.
