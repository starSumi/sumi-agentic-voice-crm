# Sumi Agentic Voice CRM

Contract-first, agent-native CRM platform for text and voice interaction. The agent is the primary operator of CRM workflows; humans remain accountable for identity, permission, high-risk actions and ambiguous intent.

## Status

`0.1.0` reference release candidate: deterministic mock providers, HTTP `/v1/ask`, ASR/TTS adapter contracts, CRM idempotency/review/outbox skeleton, OpenAPI/CloudEvents-style event contracts, tests, build manifest and release gates.

This is an owned implementation. It is inspired by the observed boundaries of Saathi CRM and the Northstar/CopilotKit Strands CRM showcase, but it is not a copy or a source projection.

## Quick start

```powershell
cd E:\Zero_Base\playground\sumi-agentic-voice-crm
npm test
npm run check
npm run build
npm start
```

Then:

```powershell
Invoke-RestMethod http://localhost:8080/health/ready
```

The mock provider accepts base64 audio containing UTF-8 text prefixed with `MOCK_AUDIO:`. See the Postman collection and [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Architecture in one line

`Gateway → Ask Orchestrator → ASR → Normalizer → Intent/Policy → CRM Command or Review → Outbox/Event Bus → Answer Composer → TTS → private media asset`.

## Documents

- [ADR-0001](docs/ADR-0001-agentic-crm.md): decision, alternatives, ownership and rollback.
- [ARCHITECTURE](docs/ARCHITECTURE.md): boundaries, design patterns, lifecycle and failure paths.
- [DATA-MODEL](docs/DATA-MODEL.md): tables, fields, indexes, invariants and retention.
- [EVENTS-AUDIT](docs/EVENTS-AUDIT.md): event envelope, audit trail, trace/correlation and replay.
- [LIFECYCLE](docs/LIFECYCLE.md): request/job/agent/record/media lifecycles.
- [SECURITY](docs/SECURITY.md): threat model, authorization and privacy controls.
- [BUILD-RELEASE](docs/BUILD-RELEASE.md): reproducible build, CI gates, SBOM/provenance and release.
- [CHECKPOINTS](docs/CHECKPOINTS.md): stage gates, checklists and evidence requirements.
- [INSPIRATION](docs/INSPIRATION.md): attribution and non-copying boundary.
- [SOURCE-EVIDENCE](docs/SOURCE-EVIDENCE.md): pinned evidence, fact classes and rejected interpretations.
- [TRACEABILITY](docs/TRACEABILITY.md): requirement-to-contract-to-checkpoint matrix.
- [OpenAPI](contracts/openapi.yaml), [events](contracts/events.yaml), [Postman](postman/voice-crm.postman_collection.json).

## Non-negotiables

- No model output directly mutates a CRM table.
- No request without tenant identity, actor identity and idempotency policy.
- No “completed” answer before the CRM transaction commits.
- No audio URL without private storage, expiry and audit metadata.
- No low-confidence destructive action without review.
- No release without contract, security, test, build and rollback evidence.
