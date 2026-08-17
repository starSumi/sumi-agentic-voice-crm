# Sumi Agentic Voice CRM

Contract-first, agent-native CRM platform for text and voice interaction. The agent is the primary operator of CRM workflows; humans remain accountable for identity, permission, high-risk actions and ambiguous intent.

## Status

`0.1.0` is a pre-alpha, production-hardened source candidate. It includes deterministic development adapters plus production OIDC/JWKS authentication, PostgreSQL/RLS, encrypted interaction persistence, private S3-compatible audio storage, OpenAI-compatible providers, an independently leased outbox relay, metrics/tracing, and bounded load/fault drills. It is not an approved release candidate and must not be used with production data or real customer audio until staging, security, container, rollback, and human approval gates pass.

## Quick start

```powershell
git clone https://github.com/starSumi/sumi-agentic-voice-crm.git
Set-Location .\sumi-agentic-voice-crm
pnpm install --frozen-lockfile
pnpm verify
pnpm start
```

Then:

```powershell
Invoke-RestMethod http://localhost:8080/health/ready
```

The mock provider accepts base64 audio containing UTF-8 text prefixed with `MOCK_AUDIO:`. See the Postman collection and [docs/QUICKSTART.md](docs/QUICKSTART.md).

For source-level iteration without building `dist/`, use `pnpm dev`. Machine-specific `.env`, caches, logs, sessions, reports, local control-plane state, and generated evidence stay ignored. Reviewed product and contributor documentation, `.env.example`, contracts, migrations, tests, and version constraints stay in Git.

On Linux or WSL2, an optional pinned Nix development shell provides Node,
PostgreSQL client/server tools, Docker/Compose clients, and the repository's
build utilities without replacing pnpm or the Docker release image:

```bash
nix develop
pnpm install --frozen-lockfile
pnpm verify
```

Entering the shell never installs dependencies or starts services. The
repository `pnpm-lock.yaml`, pnpm pin, Dockerfile, and CI remain canonical.

## Product documentation

`docs/` is the single reviewed source. Astro and Starlight render it for people; the same build publishes bounded Markdown, route metadata, and OpenAPI under `/_mcp/` for Sumi Docs MCP.

```powershell
pnpm docs:build
pnpm docs:preview -- --host 127.0.0.1 --port 4321
```

Open `http://127.0.0.1:4321/` for English or `http://127.0.0.1:4321/zh-cn/` for Simplified Chinese. The site includes light, dark, and automatic themes.

The repository-level [`.mcp.json`](.mcp.json) exposes the reviewed Markdown and
generated OpenAPI bundle through the `sumi-docs-mcp` command. Build or install
the sibling `Sumi-Docs-MCP` checkout, put its launcher on `PATH`, then let an MCP
client load the project configuration. The equivalent manual command is:

```shell
sumi-docs-mcp serve docs \
  --openapi protocol/schema/json/openapi.bundle.json
```

`pnpm verify:mcp` exercises all four MCP tools against the generated product corpus and every published page URL.

## Architecture in one line

`Gateway → Ask Orchestrator → ASR → Normalizer → Intent/Policy → CRM Command or Review → Outbox/Event Bus → Answer Composer → TTS → private media asset`.

## Documents

- [Overview](docs/index.md): implemented scope, production gaps, and reading routes.
- [Quickstart](docs/QUICKSTART.md): run the reference API and documentation surfaces.
- [Configuration](docs/CONFIGURATION.md): effective environment variables and promotion boundaries.
- [API](docs/API.md): identity, tenancy, idempotency, endpoint, and error contract.
- [ADR-0001](docs/ADR-0001-agentic-crm.md): decision, alternatives, ownership and rollback.
- [ADR-0003](docs/ADR-0003-ag-ui-compatibility.md): optional AG-UI adapter boundary and adoption gates.
- [ADR-0004](docs/ADR-0004-runtime-agent-boundary.md): runtime core, Agent plane, event state, attachments, extensions and transport choices.
- [ARCHITECTURE](docs/ARCHITECTURE.md): boundaries, design patterns, lifecycle and failure paths.
- [DATA-MODEL](docs/DATA-MODEL.md): tables, fields, indexes, invariants and retention.
- [EVENTS-AUDIT](docs/EVENTS-AUDIT.md): event envelope, audit trail, trace/correlation and replay.
- [LIFECYCLE](docs/LIFECYCLE.md): request/job/agent/record/media lifecycles.
- [SECURITY](docs/SECURITY.md): threat model, authorization and privacy controls.
- [BUILD-RELEASE](docs/BUILD-RELEASE.md): reproducible build, CI gates, SBOM/provenance and release.
- [TRACEABILITY](docs/TRACEABILITY.md): requirement-to-contract-to-verification matrix.
- [Development](docs/DEVELOPMENT.md), [contributing](docs/CONTRIBUTING.md), [troubleshooting](docs/TROUBLESHOOTING.md), and [localization](docs/LOCALIZATION.md).
- [OpenAPI](contracts/openapi.yaml), [events](contracts/events.yaml), [Postman](postman/voice-crm.postman_collection.json).

## Non-negotiables

- No model output directly mutates a CRM table.
- No request without tenant identity, actor identity and idempotency policy.
- No “completed” answer before the CRM transaction commits.
- No audio URL without private storage, expiry and audit metadata.
- No low-confidence destructive action without review.
- No release without contract, security, test, build and rollback evidence.
