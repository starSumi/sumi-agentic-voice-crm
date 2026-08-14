# Requirement traceability

| Requirement | Sumi artifact | Verification / gate |
| --- | --- | --- |
| Text and voice question answering | `contracts/openapi.yaml` `/v1/ask`; `src/server.mjs` | `test/contract.test.mjs` text + mock audio; C1/C3 |
| ASR, intent and key information | `src/providers.mjs` adapters; `Understanding` schema | audio path and confidence/review tests; C3 |
| TTS text/audio output | `/v1/tts/synthesize`, `TtsAsset`, private-asset policy | TTS auth/idempotency/replay test; C3 |
| CRM mutation safety | `src/store.mjs`; `crm_commands`, `audit_records`, `outbox_events` migration | idempotency replay/conflict + event envelope tests; C2 |
| Low-confidence human checkpoint | `review_tasks`; `docs/LIFECYCLE.md` | 202 response with no CRM commit; C2/C6 |
| Tenant isolation and audit | `docs/SECURITY.md`, migration RLS policies, `/v1/events` scope | authenticated event read; production cross-tenant matrix required; C5 |
| Database and field contract | `db/migrations/001_initial.sql`, `docs/DATA-MODEL.md` | migration smoke and docs/schema parity required; C2 |
| API documentation and Postman | `contracts/openapi.yaml`, `postman/voice-crm.postman_collection.json` | repository checker + manual import; C1 |
| Lifecycle, recovery and operations | `docs/LIFECYCLE.md`, `docs/EVENTS-AUDIT.md`, `docs/OPERATIONS.md` | checkpoint evidence and incident/restore drills; C4/C6 |
| Reproducible build and release | `.github/workflows/ci.yml`, `scripts/build.mjs`, `docs/BUILD-RELEASE.md` | CI-equivalent local test/check/build; C6 |

The table is a release checklist, not a claim that every production gate is
already complete. The authoritative decision is `docs/RELEASE-READINESS.md`.
