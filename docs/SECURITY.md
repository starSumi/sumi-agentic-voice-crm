# Security and trust boundaries

## Threats

- Cross-tenant data access through prompts, CRM queries or event consumers.
- Prompt injection in transcript/customer notes causing unauthorized tools.
- Replay/duplicate commands from retries or webhook redelivery.
- Audio upload malware, decompression bombs, spoofed MIME and PII leakage.
- Provider/key compromise and raw transcript leakage in logs.
- TTS voice abuse, unapproved external messages and insecure media URLs.

## Controls

1. OIDC/JWT validation at Gateway; tenant comes from token/authorized header, never model text.
2. CRM queries add mandatory tenant predicate; DB role has least privilege; service-to-service mTLS or workload identity.
3. Tool allowlist and policy decision point; model output is untrusted JSON validated by schema, entity resolver and RBAC.
4. Idempotency uniqueness and optimistic version checks; webhook/event consumers deduplicate by event ID.
5. Magic-byte/codec/duration/size validation, malware scan and private object store; signed URL TTL; encrypted at rest/in transit.
6. Structured redacted logs, secret manager, rotation, no prompts/audio/phone in telemetry by default.
7. High-risk actions require explicit human confirmation; TTS answer cannot claim a commit before commit event.
8. Supply chain: lockfile, dependency audit, SBOM, provenance, signed release artifact and protected main branch.

Security verification includes tenant matrix, prompt-injection fixtures, malformed media, SSRF/provider URL allowlist, rate limits, secret scan and restore drill.
