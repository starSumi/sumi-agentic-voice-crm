---
title: ADR-0006 Rust runtime supervisor
description: Linux process ownership, bounded lifecycle protocol, and Node control-plane boundary.
docId: crm.adr-0006
locale: en
audience: both
contentVersion: 0.1.0
---

## Decision

Process-isolated extensions are owned by the `sumi-runtime-supervisor` Rust
binary. The JavaScript extension registry remains the orchestration authority;
the Rust process owns one child process group and its operating-system lifetime.

The internal `sumi.runtime.supervisor.v1` protocol is newline-delimited JSON and
is bounded to 64 KiB per frame. Its committed JSON Schema is
`contracts/runtime-supervisor.schema.json`. Version, request identifiers,
operation fields, executable paths, arguments, environment values, startup
timeout, and shutdown grace are validated on both sides of the boundary.

## Ownership boundary

- The deployment-owned Node resolver selects an absolute executable and an
  explicit environment allowlist. Ambient process environment is not inherited.
- The child must emit `sumi.runtime.extension.ready.v1` before the bounded
  startup deadline. Until then the extension is not ready.
- Normal shutdown sends `SIGTERM` to the child process group and waits for the
  configured grace. Expiry sends `SIGKILL` to the same group.
- Linux parent-death signaling closes the direct-child supervisor crash gap;
  the Rust owner also kills and waits for a live group when dropped.
- The first slice carries only lifecycle health. CRM DTOs, secrets, permission
  ports, and business capability RPC do not cross this protocol.

## Integration and rollback

The Node adapter implements the existing extension registry `start`, `health`,
`stop`, and trusted `terminate` contract. Deployment code supplies explicit
`extensionRegistrations` to the composition root; the default list is empty, so
loading or starting the application never discovers executable code implicitly.
The release build copies the executable to `dist/bin`, records its executable bit
and digest in the runtime manifest, and ships it in the unprivileged container.

Rollback removes the process extension registration or returns to the preceding
release image. The Rust supervisor does not own database state, migrations,
conversation state, provider selection, authorization, or transactional outbox,
so its removal does not require data rollback.

## Acceptance

Acceptance requires Rust formatting, Clippy with warnings denied, Rust unit
tests, Node/Rust interoperability tests, closed protocol-schema tests, build
manifest verification, Docker smoke, dependency audit, and remote CI for the
exact commit.
