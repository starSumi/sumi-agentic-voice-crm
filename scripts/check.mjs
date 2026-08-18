import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const runtimeSources = [
  "src/application/attachments.ts",
  "src/application/commands.ts",
  "src/application/conversation-state.ts",
  "src/application/index.ts",
  "src/application/mutation-policy.ts",
  "src/application/progress-event-bus.ts",
  "src/application/services.ts",
  "src/auth.ts",
  "src/authorization/errors.ts",
  "src/authorization/index.ts",
  "src/authorization/policy.ts",
  "src/authorization/types.ts",
  "src/composition-root.ts",
  "src/control/cas-circuit-breaker.ts",
  "src/control/engine.ts",
  "src/control/guardian-denial-governor.ts",
  "src/control/guardian-review.ts",
  "src/control/index.ts",
  "src/contracts.ts",
  "src/data-cipher.ts",
  "src/event-consumer.ts",
  "src/extensions/index.ts",
  "src/extensions/manifest.ts",
  "src/extensions/registry.ts",
  "src/extensions/rust-process-supervisor.ts",
  "src/lifecycle/managed-task-registry.ts",
  "src/lifecycle/staged-timeout.ts",
  "src/mutation-policy.ts",
  "src/message-job-queue.ts",
  "src/message-job-worker.ts",
  "src/object-storage.ts",
  "src/observability.ts",
  "src/outbox-relay.ts",
  "src/outbox-worker.ts",
  "src/provider-common.ts",
  "src/provider-dashscope.ts",
  "src/provider-mock.ts",
  "src/provider-openai.ts",
  "src/providers.ts",
  "src/production-config.ts",
  "src/protocol-policy.ts",
  "src/protocol-validation.ts",
  "src/postgres-store.ts",
  "src/server.ts",
  "src/sse-adapter.ts",
  "src/store.ts",
];
const required = [
  "README.md",
  "AGENTS.md",
  "LICENSE",
  "tsconfig.runtime.json",
  ".jscpd.json",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "crates/runtime-supervisor/Cargo.toml",
  "crates/runtime-supervisor/src/lib.rs",
  "crates/runtime-supervisor/src/main.rs",
  "contracts/openapi.yaml",
  "contracts/events.yaml",
  "contracts/runtime-supervisor.schema.json",
  "contracts/authorization-policy.json",
  "contracts/authorization-policy.schema.json",
  "contracts/transport-policy.json",
  "contracts/transport-policy.schema.json",
  "db/migrations/001_initial.sql",
  "db/migrations/002_interaction_control_wal.sql",
  "db/migrations/003_conversation_revision_cas.sql",
  "db/migrations/004_authorization_principal.sql",
  "db/migrations/005_message_jobs_and_inbox.sql",
  "db/tests/001_rls_and_atomicity.sql",
  "protocol/protocol.manifest.json",
  "protocol/protocol-manifest.schema.json",
  "protocol/schema/json/openapi.bundle.json",
  "protocol/schema/json/events.bundle.json",
  "packages/api-client/src/api.ts",
  "packages/api-client/src/protocol.ts",
  "packages/api-client/src/generated/index.ts",
  ".mcp.json",
  "astro.config.mjs",
  "src/content.config.ts",
  "integrations/sumi-docs-publisher.mjs",
  "scripts/check-contract-consumers.mjs",
  "scripts/load-drill.mjs",
  "scripts/fault-drill.mjs",
  "scripts/run-cargo.mjs",
  "scripts/check-transport-policy.mjs",
  "scripts/check-authorization-policy.mjs",
  ...runtimeSources,
  "docs/index.md",
  "docs/QUICKSTART.md",
  "docs/CONFIGURATION.md",
  "docs/API.md",
  "docs/DEVELOPMENT.md",
  "docs/CONTRIBUTING.md",
  "docs/EXTENSIONS.md",
  "docs/TROUBLESHOOTING.md",
  "docs/LOCALIZATION.md",
  "docs/ADR-0001-agentic-crm.md",
  "docs/ADR-0002-protocol-first-generated-client.md",
  "docs/ADR-0004-runtime-agent-boundary.md",
  "docs/ADR-0005-managed-lifecycle-guardian-cas.md",
  "docs/ADR-0006-rust-runtime-supervisor.md",
  "docs/zh-cn/adr-0004-runtime-agent-boundary.md",
  "docs/zh-cn/adr-0005-managed-lifecycle-guardian-cas.md",
  "docs/zh-cn/adr-0006-rust-runtime-supervisor.md",
  "docs/ARCHITECTURE.md",
  "docs/DATA-MODEL.md",
  "docs/EVENTS-AUDIT.md",
  "docs/LIFECYCLE.md",
  "docs/SECURITY.md",
  "docs/BUILD-RELEASE.md",
  "docs/TRACEABILITY.md",
  "postman/voice-crm.postman_collection.json",
];
const missing = required.filter((p) => !existsSync(p));
if (missing.length)
  throw new Error(`missing required files: ${missing.join(", ")}`);
JSON.parse(await readFile("postman/voice-crm.postman_collection.json", "utf8"));
const openapi = await readFile("contracts/openapi.yaml", "utf8");
for (const marker of [
  "openapi: 3.1.0",
  "/v1/ask:",
  "/v1/tts/synthesize:",
  "bearerAuth",
])
  if (!openapi.includes(marker))
    throw new Error(`OpenAPI marker missing: ${marker}`);
const events = await readFile("contracts/events.yaml", "utf8");
for (const marker of [
  "$schema:",
  'specversion: { const: "1.0" }',
  "crm.command.committed.v1",
  "voice.request.failed.v1",
])
  if (!events.includes(marker))
    throw new Error(`event marker missing: ${marker}`);
const protocolManifest = JSON.parse(
  await readFile("protocol/protocol.manifest.json", "utf8"),
);
for (const field of [
  "protocol_version",
  "sources",
  "generated",
  "commands",
  "rollback",
])
  if (!(field in protocolManifest))
    throw new Error(`protocol manifest field missing: ${field}`);
if (
  !Array.isArray(protocolManifest.consumer_roots) ||
  protocolManifest.consumer_roots.length === 0
)
  throw new Error("protocol manifest consumer_roots must be non-empty");
for (const generatedPath of Object.values(protocolManifest.generated))
  if (!existsSync(generatedPath))
    throw new Error(`generated protocol path missing: ${generatedPath}`);
const sql = await readFile("db/migrations/001_initial.sql", "utf8");
for (const marker of [
  "create table if not exists tenants",
  "create table if not exists outbox_events",
  "enable row level security",
  "force row level security",
  "create policy tenant_isolation",
])
  if (!sql.includes(marker))
    throw new Error(`SQL safety marker missing: ${marker}`);
const controlWal = await readFile(
  "db/migrations/002_interaction_control_wal.sql",
  "utf8",
);
for (const marker of [
  "create table if not exists interaction_wal",
  "lease_expires_at",
  "force row level security",
  "create policy tenant_isolation",
])
  if (!controlWal.includes(marker))
    throw new Error(`control WAL marker missing: ${marker}`);
const conversationCas = await readFile(
  "db/migrations/003_conversation_revision_cas.sql",
  "utf8",
);
for (const marker of [
  "create table if not exists conversation_states",
  "revision bigint",
  "state_ciphertext",
  "force row level security",
  "create policy tenant_isolation",
])
  if (!conversationCas.includes(marker))
    throw new Error(`conversation CAS marker missing: ${marker}`);
const messageJobs = await readFile(
  "db/migrations/005_message_jobs_and_inbox.sql",
  "utf8",
);
for (const marker of [
  "create table if not exists message_jobs",
  "status in ('inbound','job_queued'",
  "create table if not exists message_job_transitions",
  "create table if not exists event_consumer_receipts",
  "force row level security",
  "create policy tenant_isolation",
])
  if (!messageJobs.includes(marker))
    throw new Error(`message jobs marker missing: ${marker}`);
const source = await readFile("src/server.ts", "utf8");
if (/(sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9_-]{20,})/.test(source))
  throw new Error("possible credential in source");
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
  if (secretPatterns.some((pattern) => pattern.test(text)))
    secretFindings.push(path);
}
if (secretFindings.length) {
  throw new Error(
    `possible credential in repository files: ${secretFindings.join(", ")}`,
  );
}
for (const runtimePath of runtimeSources.filter(
  (candidate) => !candidate.endsWith(".ts"),
)) {
  const status = spawnSync(process.execPath, ["--check", runtimePath], {
    encoding: "utf8",
  });
  if (status.status !== 0) throw new Error(`${runtimePath}: ${status.stderr}`);
}
const store = await readFile("src/store.ts", "utf8");
for (const marker of [
  "specversion",
  "source:",
  "subject",
  "time:",
  "data",
  "IDEMPOTENCY_CONFLICT",
])
  if (!store.includes(marker))
    throw new Error(`runtime contract marker missing: ${marker}`);
if (!openapi.includes("AudioAskRequest") || !openapi.includes("oneOf:"))
  throw new Error("OpenAPI must describe text and audio JSON variants");
console.log(
  `check passed: ${required.length} required files, contract markers, repository secret patterns, ${runtimeSources.length} runtime modules`,
);
