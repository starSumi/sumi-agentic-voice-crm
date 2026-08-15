---
title: Security and trust boundaries
description: Tenant isolation, prompt and media threats, authorization, privacy, audit, idempotency, and human confirmation controls.
docId: crm.security
locale: en
audience: both
contentVersion: 0.1.0
---

## Threats

- Cross-tenant data access through prompts, CRM queries or event consumers.
- Prompt injection in transcript/customer notes causing unauthorized tools.
- Replay/duplicate commands from retries or webhook redelivery.
- Audio upload malware, decompression bombs, spoofed MIME and PII leakage.
- Provider/key compromise and raw transcript leakage in logs.
- TTS voice abuse, unapproved external messages and insecure media URLs.

## Controls

1. The API verifies OIDC JWT signatures through a cached remote JWKS, restricts algorithms, and validates issuer, audience, subject, tenant binding and configured scope. Production rejects development bearer mode and non-HTTPS JWKS.
2. CRM queries add mandatory tenant predicate; DB role has least privilege; service-to-service mTLS or workload identity.
3. Tool allowlist and policy decision point; model output is untrusted JSON validated by schema, entity resolver and RBAC.
4. Idempotency uniqueness and optimistic version checks; webhook/event consumers deduplicate by event ID.
5. Size, content type and audio magic-byte validation precede private S3-compatible storage; server-side encryption and 15-900 second signed URLs are enforced. Malware scanning and codec-duration limits remain a C5 deployment gate.
6. Structured redacted logs, secret manager, rotation, no prompts/audio/phone in telemetry by default.
7. High-risk actions require explicit human confirmation; TTS answer cannot claim a commit before commit event.
8. Supply chain: lockfile, dependency audit, SBOM, provenance, signed release artifact and protected main branch.

Current automated evidence covers forged/mismatched JWTs, production fail-closed configuration, tenant RLS, MIME spoofing boundaries, private object behavior, dependency audit and repository secret patterns. Prompt-injection, malware, SSRF allowlist, rate-limit, retention/deletion and restore exercises remain C5 holds.
