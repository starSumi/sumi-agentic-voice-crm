# Sumi Agentic Voice CRM

Contract-first, agent-native CRM platform for text and voice interaction. The agent is the primary operator of CRM workflows; humans remain accountable for identity, permission, high-risk actions and ambiguous intent.

## Status

`0.1.0` reference release candidate: deterministic mock providers, HTTP `/v1/ask`, ASR/TTS adapter contracts, CRM idempotency/review/outbox skeleton, OpenAPI/CloudEvents-style event contracts, tests, build manifest and release gates.

This is an owned implementation. It is inspired by the observed boundaries of Saathi CRM and the Northstar/CopilotKit Strands CRM showcase, but it is not a copy or a source projection.

## Quick start

```powershell
cd E:\Zero_Base\playground\sumi-agentic-voice-crm
npm ci
npm run verify
npm start
```

Then:

```powershell
Invoke-RestMethod http://localhost:8080/health/ready
```

The mock provider accepts base64 audio containing UTF-8 text prefixed with `MOCK_AUDIO:`. See the Postman collection and [docs/QUICKSTART.md](docs/QUICKSTART.md).

For source-level iteration without building `dist/`, use `npm run dev`. Machine-specific `.env`, caches, logs, sessions, reports, and generated evidence stay ignored; reviewed development guides, `.env.example`, `.agent/` governance, and version constraints stay in Git.

## Documentation for people and agents

`docs/` is the single reviewed source. Astro and Starlight render it for people; the same build publishes bounded Markdown, route metadata, and OpenAPI under `/_mcp/` for Sumi Docs MCP.

```powershell
npm run docs:build
npm run docs:preview -- --host 127.0.0.1 --port 4321
```

Open `http://127.0.0.1:4321/` for English or `http://127.0.0.1:4321/zh-cn/` for Simplified Chinese. The site includes light, dark, and automatic themes.

Connect an MCP client locally with:

```powershell
node E:\Zero_Base\playground\.sumi\Sumi-Docs-MCP\dist\index.js serve `
  http://127.0.0.1:4321/_mcp/ `
  --base-url http://127.0.0.1:4321/
```

The [agent development partner guide](docs/AGENT-GUIDE.md) defines discovery order, evidence priority, safety boundaries, and acceptance questions. `npm run verify:mcp` exercises all four MCP tools against the generated corpus and every published page URL.

## Architecture in one line

`Gateway → Ask Orchestrator → ASR → Normalizer → Intent/Policy → CRM Command or Review → Outbox/Event Bus → Answer Composer → TTS → private media asset`.

## Documents

- [Overview](docs/index.md): implemented scope, production gaps, and reading routes.
- [Quickstart](docs/QUICKSTART.md): run the reference API and documentation surfaces.
- [Configuration](docs/CONFIGURATION.md): effective environment variables and promotion boundaries.
- [API](docs/API.md): identity, tenancy, idempotency, endpoint, and error contract.
- [Agent guide](docs/AGENT-GUIDE.md): use the corpus as a development partner.
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
- [Development](docs/DEVELOPMENT.md), [contributing](docs/CONTRIBUTING.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [localization](docs/LOCALIZATION.md).
- [OpenAPI](contracts/openapi.yaml), [events](contracts/events.yaml), [Postman](postman/voice-crm.postman_collection.json).

## Non-negotiables

- No model output directly mutates a CRM table.
- No request without tenant identity, actor identity and idempotency policy.
- No “completed” answer before the CRM transaction commits.
- No audio URL without private storage, expiry and audit metadata.
- No low-confidence destructive action without review.
- No release without contract, security, test, build and rollback evidence.
