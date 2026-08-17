import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const runtimeSources = ["src/application/attachments.mjs", "src/application/commands.mjs", "src/application/conversation-state.mjs", "src/application/index.mjs", "src/application/mutation-policy.mjs", "src/application/services.mjs", "src/auth.mjs", "src/composition-root.mjs", "src/control/cas-circuit-breaker.mjs", "src/control/engine.mjs", "src/control/guardian-denial-governor.mjs", "src/control/guardian-review.mjs", "src/control/index.mjs", "src/contracts.mjs", "src/data-cipher.mjs", "src/extensions/index.mjs", "src/extensions/manifest.mjs", "src/extensions/registry.mjs", "src/extensions/rust-process-supervisor.mjs", "src/lifecycle/managed-task-registry.mjs", "src/lifecycle/staged-timeout.mjs", "src/mutation-policy.mjs", "src/object-storage.mjs", "src/observability.mjs", "src/outbox-relay.mjs", "src/outbox-worker.mjs", "src/provider-common.mjs", "src/provider-dashscope.mjs", "src/provider-mock.mjs", "src/provider-openai.mjs", "src/providers.mjs", "src/production-config.mjs", "src/protocol-policy.mjs", "src/protocol-validation.mjs", "src/postgres-store.mjs", "src/server.mjs", "src/sse-adapter.mjs", "src/store.mjs"];
const required = ["README.md", "AGENTS.md", "LICENSE", ".jscpd.json", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates/runtime-supervisor/Cargo.toml", "crates/runtime-supervisor/src/lib.rs", "crates/runtime-supervisor/src/main.rs", "contracts/openapi.yaml", "contracts/events.yaml", "contracts/runtime-supervisor.schema.json", "db/migrations/001_initial.sql", "db/migrations/002_interaction_control_wal.sql", "db/migrations/003_conversation_revision_cas.sql", "db/tests/001_rls_and_atomicity.sql", "protocol/protocol.manifest.json", "protocol/protocol-manifest.schema.json", "protocol/schema/json/openapi.bundle.json", "protocol/schema/json/events.bundle.json", "packages/api-client/src/api.ts", "packages/api-client/src/protocol.ts", "packages/api-client/src/generated/index.ts", ".mcp.json", "astro.config.mjs", "src/content.config.ts", "integrations/sumi-docs-publisher.mjs", "scripts/check-contract-consumers.mjs", "scripts/load-drill.mjs", "scripts/fault-drill.mjs", "scripts/run-cargo.mjs", ...runtimeSources, "docs/index.md", "docs/QUICKSTART.md", "docs/CONFIGURATION.md", "docs/API.md", "docs/AGENT-GUIDE.md", "docs/DEVELOPMENT.md", "docs/CONTRIBUTING.md", "docs/EXTENSIONS.md", "docs/TROUBLESHOOTING.md", "docs/LOCALIZATION.md", "docs/MAINTENANCE.md", "docs/zh-cn/maintenance.md", "docs/ADR-0001-agentic-crm.md", "docs/ADR-0002-protocol-first-generated-client.md", "docs/ADR-0004-runtime-agent-boundary.md", "docs/ADR-0005-managed-lifecycle-guardian-cas.md", "docs/zh-cn/adr-0004-runtime-agent-boundary.md", "docs/zh-cn/adr-0005-managed-lifecycle-guardian-cas.md", "docs/ARCHITECTURE.md", "docs/DATA-MODEL.md", "docs/EVENTS-AUDIT.md", "docs/LIFECYCLE.md", "docs/SECURITY.md", "docs/BUILD-RELEASE.md", "docs/CHECKPOINTS.md", "docs/SOURCE-EVIDENCE.md", "docs/TRACEABILITY.md", "postman/voice-crm.postman_collection.json"];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) throw new Error(`missing required files: ${missing.join(", ")}`);
JSON.parse(await readFile("postman/voice-crm.postman_collection.json", "utf8"));
const openapi = await readFile("contracts/openapi.yaml", "utf8");
for (const marker of ["openapi: 3.1.0", "/v1/ask:", "/v1/tts/synthesize:", "bearerAuth"]) if (!openapi.includes(marker)) throw new Error(`OpenAPI marker missing: ${marker}`);
const events = await readFile("contracts/events.yaml", "utf8");
for (const marker of ["$schema:", "specversion: { const: \"1.0\" }", "crm.command.committed.v1", "voice.request.failed.v1"]) if (!events.includes(marker)) throw new Error(`event marker missing: ${marker}`);
const protocolManifest = JSON.parse(await readFile("protocol/protocol.manifest.json", "utf8"));
for (const field of ["protocol_version", "sources", "generated", "commands", "rollback"]) if (!(field in protocolManifest)) throw new Error(`protocol manifest field missing: ${field}`);
if (!Array.isArray(protocolManifest.consumer_roots) || protocolManifest.consumer_roots.length === 0) throw new Error("protocol manifest consumer_roots must be non-empty");
for (const path of Object.values(protocolManifest.generated)) if (!existsSync(path)) throw new Error(`generated protocol path missing: ${path}`);
const sql = await readFile("db/migrations/001_initial.sql", "utf8");
for (const marker of ["create table if not exists tenants", "create table if not exists outbox_events", "enable row level security", "force row level security", "create policy tenant_isolation"]) if (!sql.includes(marker)) throw new Error(`SQL safety marker missing: ${marker}`);
const controlWal = await readFile("db/migrations/002_interaction_control_wal.sql", "utf8");
for (const marker of ["create table if not exists interaction_wal", "lease_expires_at", "force row level security", "create policy tenant_isolation"]) if (!controlWal.includes(marker)) throw new Error(`control WAL marker missing: ${marker}`);
const conversationCas = await readFile("db/migrations/003_conversation_revision_cas.sql", "utf8");
for (const marker of ["create table if not exists conversation_states", "revision bigint", "state_ciphertext", "force row level security", "create policy tenant_isolation"]) if (!conversationCas.includes(marker)) throw new Error(`conversation CAS marker missing: ${marker}`);
const source = await readFile("src/server.mjs", "utf8");
if (/(sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9_-]{20,})/.test(source)) throw new Error("possible credential in source");
const trackedFiles = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8", windowsHide: true },
);
if (trackedFiles.status !== 0) throw new Error(trackedFiles.stderr);
const secretPatterns = [
  new RegExp(["sk-", "[A-Za-z0-9_-]{20,}"].join("")),
  new RegExp(["gh", "[pousr]_[A-Za-z0-9]{20,}"].join("")),
  new RegExp(["BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY"].join("")),
];
const secretFindings = [];
for (const path of trackedFiles.stdout.split("\0").filter(Boolean)) {
  // A tracked file staged for deletion (for example, a replaced lockfile) is
  // still returned by git ls-files but no longer exists in the worktree.
  if (!existsSync(path)) continue;
  const bytes = await readFile(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (secretPatterns.some((pattern) => pattern.test(text))) secretFindings.push(path);
}
if (secretFindings.length) {
  throw new Error(`possible credential in repository files: ${secretFindings.join(", ")}`);
}
for (const path of runtimeSources) {
  const status = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (status.status !== 0) throw new Error(`${path}: ${status.stderr}`);
}
const store = await readFile("src/store.mjs", "utf8");
for (const marker of ["specversion", "source:", "subject", "time:", "data", "IDEMPOTENCY_CONFLICT"]) if (!store.includes(marker)) throw new Error(`runtime contract marker missing: ${marker}`);
if (!openapi.includes("AudioAskRequest") || !openapi.includes("oneOf:")) throw new Error("OpenAPI must describe text and audio JSON variants");
console.log(`check passed: ${required.length} required files, contract markers, repository secret patterns, ${runtimeSources.length} runtime modules`);
