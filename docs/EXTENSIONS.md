---
title: Extensions and control engine
description: Governed IoC registration, capability permissions, isolation, lifecycle, circuit breaking, and adapter boundaries.
docId: crm.extensions
locale: en
audience: both
contentVersion: 0.1.0
---

## Scope

`src/extensions/` is a small inversion-of-control kernel, not a dynamic package
loader. Registration is explicit at the composition root. A closed manifest
declares exact version, protocol, owner, isolation, entrypoint, capabilities,
permissions, and dependencies. Unknown fields, floating versions, dependency
cycles, permissions outside the deployment allowlist, and untrusted in-process
IDs fail before startup.

## Isolation and permissions

Built-in code may use `in-process` only when its ID is trusted by deployment.
Third-party code uses `process` plus a trusted `launch` supervisor. The launcher,
not the manifest, must create the operating-system process and implement graceful
`stop()` plus hard `terminate()`. The registry does not import `entrypoint`, pass
the environment snapshot, expose secrets, or claim that JavaScript objects are a
sandbox.

The production process launcher uses the Linux-only Rust supervisor described in
[ADR-0006](ADR-0006-rust-runtime-supervisor.md). Its versioned, 64 KiB-bounded
NDJSON protocol is lifecycle-only. A child is ready only after the explicit
readiness frame; shutdown owns the whole child process group. The first slice
allows only `runtime.health` and no permission ports or ambient environment.

Extensions receive only the ports mapped to their approved permission names.
Capabilities also imply required permissions; for example `tool.crm.write`
requires `crm.write`, while provider capabilities require network and applicable
media permissions. Authorization, tenant checks, mutation review, idempotency,
transactions, audit, and outbox remain inside application services and stores.

## Lifecycle and failure control

Dependencies start first and stop in reverse. Creation, startup, health, and
shutdown are bounded by cooperative soft cancellation plus a hard grace. Startup
failure rolls back every created instance. Concurrent close aborts startup and
cannot leave an extension running after the registry reaches `stopped`.

`src/control/` supplies one keyed circuit per capability/provider/target. Its
state uses a CAS revision plus recovery epoch: concurrent failures aggregate,
only one half-open probe runs, and completions from an older epoch cannot close
or reopen the current circuit. Caller cancellation and non-retryable input errors
are neutral; a neutral half-open probe returns to a finite cooldown instead of
remaining stuck.

## Adapter package boundaries

Client data and event types come from `@sumi/voice-crm-api-client/protocol`.
HTTP/SSE operations, authentication headers, retry/timeout policy, and provider
base configuration belong to `@sumi/voice-crm-api-client/api` or a provider
adapter. The server-side application core does not call its own HTTP client.
Provider-specific request and SSE event shapes never become domain types merely
because one model vendor uses them.

The current generated API facade is request/response HTTP only. SSE parsing is a
reserved adapter responsibility, not an implemented compatibility claim, until
the stream contract defines ordering, cancellation, resume, and terminal events.
