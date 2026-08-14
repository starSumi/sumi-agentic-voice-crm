# Release readiness record

## Candidate

- Repository: `sumi-agentic-voice-crm`
- Version: `0.1.0`
- Date: 2026-08-14
- Provider mode: deterministic mock
- Production status: **not approved**

## Evidence captured

| Gate | Result | Evidence |
| --- | --- | --- |
| Syntax | PASS | `node --check src/*.mjs` via `npm run check` |
| Contract/unit | PASS | `npm test`: 7/7 |
| Repository invariants | PASS | `npm run check`: required files, OpenAPI markers, Postman JSON |
| Build | PASS | `npm run build`: dist manifest generated |
| Normal text ask | PASS | test `text ask returns CRM result and TTS asset` |
| Mock audio path | PASS | test `mock audio exercises ASR to intent to TTS` |
| No audio source | PASS | test `missing audio is a non-retryable boundary error` |
| Low confidence | PASS | test creates review task and does not commit CRM |
| Idempotency | PASS | repeated key returns same resource/version |
| Idempotency conflict | PASS | same key with a different command returns `IDEMPOTENCY_CONFLICT` |
| Event envelope/auth boundary | PASS | `/v1/events` requires tenant auth and emits CloudEvents-compatible fields |
| TTS auth/idempotency boundary | PASS | `/v1/tts/synthesize` rejects missing key and accepts scoped mock request |
| Real ASR/TTS quality | UNKNOWN | no production provider configured |
| PostgreSQL integration | NOT RUN | reference runtime uses in-memory store |
| E2E/browser/load/security | NOT RUN | requires staging infrastructure and approved fixtures |

## Release decision

`0.1.0` is suitable as an internal reference/contract release only. Promote to production only after C0–C6 in
[CHECKPOINTS.md](CHECKPOINTS.md) are evidenced, especially identity/tenant isolation, real provider quality,
Postgres/outbox integration, security scans, load/fault tests, signed artifact/provenance and rollback drill.
