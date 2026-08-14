import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "sumi-agentic-voice-crm";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function runGit(root, args, { optional = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 && !optional) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function parseInstant(value, field) {
  requireValue(typeof value === "string" && ISO_PATTERN.test(value), `${field} must be ISO-8601`);
  const milliseconds = Date.parse(value);
  requireValue(Number.isFinite(milliseconds), `${field} is not a valid instant`);
  return milliseconds;
}

function ageInDays(instant, now) {
  return (now.getTime() - instant) / 86_400_000;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requireSchema(document, schema, path) {
  requireValue(document.schema_version === schema, `${path} schema mismatch`);
}

export async function inspectControlPlane({
  root = process.cwd(),
  now = new Date(),
  includeFreshness = false,
} = {}) {
  const resolvedRoot = resolve(root);
  const paths = {
    manifest: join(resolvedRoot, ".agent", ".agent.manifest.json"),
    state: join(resolvedRoot, ".agent", ".agent.state.json"),
    cursor: join(resolvedRoot, ".agent", ".agent.cursor.json"),
    maintainers: join(resolvedRoot, ".agent", ".agent.maintainers.json"),
  };
  const [manifest, state, cursor, maintainerRegistry] = await Promise.all([
    readJson(paths.manifest),
    readJson(paths.state),
    readJson(paths.cursor),
    readJson(paths.maintainers),
  ]);

  requireSchema(manifest, "sumi.agent-control.v1", paths.manifest);
  requireSchema(state, "sumi.agent-state.v1", paths.state);
  requireSchema(cursor, "sumi.agent-cursor.v1", paths.cursor);
  requireSchema(maintainerRegistry, "sumi.agent-maintainers.v1", paths.maintainers);
  requireValue(manifest.repository === REPOSITORY, "manifest repository mismatch");
  requireValue(cursor.source.repository === `starSumi/${REPOSITORY}`, "cursor repository mismatch");
  requireValue(SHA_PATTERN.test(manifest.source_commit), "manifest source_commit must be a full SHA");
  requireValue(SHA_PATTERN.test(cursor.source.commit), "cursor source commit must be a full SHA");
  requireValue(manifest.current_phase === cursor.control_plane.phase, "cursor phase mismatch");
  requireValue(manifest.current_checkpoint === cursor.control_plane.checkpoint, "cursor checkpoint mismatch");
  requireValue(state.updated_at === cursor.control_plane.state_updated_at, "cursor state timestamp mismatch");
  requireValue(manifest.continuity?.cursor === ".agent/.agent.cursor.json", "manifest cursor pointer missing");
  requireValue(manifest.continuity?.maintainers === ".agent/.agent.maintainers.json", "manifest maintainer pointer missing");
  requireValue(manifest.continuity?.next_session_role === "continuity-supervisor", "next session role mismatch");

  const healthIssues = [];
  const warnings = [];
  const nowMilliseconds = now.getTime();
  const stateInstant = parseInstant(state.updated_at, "state.updated_at");
  const cursorInstant = parseInstant(cursor.captured_at, "cursor.captured_at");
  requireValue(stateInstant <= nowMilliseconds + 300_000, "state.updated_at is in the future");
  requireValue(cursorInstant <= nowMilliseconds + 300_000, "cursor.captured_at is in the future");

  const requiredMaintainers = ["documentation", "continuity", "ci_operations"];
  for (const key of requiredMaintainers) {
    const surface = maintainerRegistry.maintainers?.[key];
    requireValue(surface && typeof surface === "object", `maintainer surface missing: ${key}`);
    requireValue(manifest.active_roles.includes(surface.accountable_role), `inactive maintainer role: ${surface.accountable_role}`);
    requireValue(Number.isInteger(surface.review_interval_days) && surface.review_interval_days > 0, `${key} review interval must be positive`);
    requireValue(Array.isArray(surface.github_owners) && surface.github_owners.length > 0, `${key} GitHub owner missing`);
    requireValue(surface.github_owners.every((owner) => /^@[A-Za-z0-9-]+$/.test(owner)), `${key} GitHub owner is invalid`);
    requireValue(Array.isArray(surface.paths) && surface.paths.length > 0, `${key} owned paths missing`);
    for (const ownedPath of surface.paths) {
      requireValue(!isAbsolute(ownedPath) && !ownedPath.includes(".."), `${key} owned path must be repository-relative`);
      requireValue(await pathExists(join(resolvedRoot, ownedPath)), `${key} owned path does not exist: ${ownedPath}`);
    }
    requireValue(SHA_PATTERN.test(surface.last_reviewed_commit), `${key} last_reviewed_commit must be a full SHA`);
    const reviewedInstant = parseInstant(surface.last_reviewed_at, `${key}.last_reviewed_at`);
    requireValue(reviewedInstant <= nowMilliseconds + 300_000, `${key} review timestamp is in the future`);
    const age = ageInDays(reviewedInstant, now);
    if (includeFreshness && age > surface.review_interval_days) {
      healthIssues.push(
        `${key} review is ${age.toFixed(1)} days old (limit ${surface.review_interval_days})`,
      );
    }
  }

  if (includeFreshness && ageInDays(cursorInstant, now) > 14) {
    healthIssues.push("versioned handoff cursor is older than 14 days");
  }

  const head = runGit(resolvedRoot, ["rev-parse", "HEAD"]);
  for (const [field, commit] of [
    ["manifest.source_commit", manifest.source_commit],
    ["cursor.source.commit", cursor.source.commit],
  ]) {
    const exists = runGit(resolvedRoot, ["cat-file", "-e", `${commit}^{commit}`], { optional: true });
    requireValue(exists !== null, `${field} is not present in local Git history`);
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", commit, head], {
      cwd: resolvedRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    requireValue(ancestor.status === 0, `${field} is not an ancestor of HEAD`);
  }
  if (manifest.source_commit !== cursor.source.commit) {
    warnings.push("manifest and cursor use different reviewed source commits");
  }
  if (cursor.last_verified_ci.head_sha !== cursor.source.commit) {
    warnings.push("last verified CI does not match the cursor source commit");
  }

  return {
    root: resolvedRoot,
    manifest,
    state,
    cursor,
    maintainerRegistry,
    head,
    healthIssues,
    warnings,
  };
}

function parseAgent(value) {
  const separator = value.lastIndexOf("=");
  requireValue(separator > 0, `agent must use <id>=open|closed: ${value}`);
  const id = value.slice(0, separator).trim();
  const state = value.slice(separator + 1).trim();
  requireValue(id.length > 0 && id.length <= 200, "agent id length is invalid");
  requireValue(["open", "closed"].includes(state), `invalid agent edge state: ${state}`);
  return { id, state };
}

function validateSessionId(value) {
  requireValue(
    typeof value === "string" && SESSION_ID_PATTERN.test(value),
    "session id must be a stable identifier without path separators",
  );
  return value;
}

function defaultRuntimePath(environment, sessionId) {
  const safeSessionId = validateSessionId(sessionId);
  if (environment.CODEX_HOME) {
    return join(environment.CODEX_HOME, "operations", REPOSITORY, safeSessionId, "session.json");
  }
  if (environment.XDG_STATE_HOME) {
    return join(environment.XDG_STATE_HOME, "sumi-agent-operations", REPOSITORY, safeSessionId, "session.json");
  }
  const localRoot = environment.LOCALAPPDATA ?? join(homedir(), ".local", "state");
  return join(localRoot, "Sumi", "agent-operations", REPOSITORY, safeSessionId, "session.json");
}

async function atomicWriteJson(path, value) {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const temporary = join(
    dirname(resolvedPath),
    `.${basename(resolvedPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, resolvedPath);
  return resolvedPath;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function createOperationsSnapshot({
  root = process.cwd(),
  now = new Date(),
  environment = process.env,
  sessionId = environment.CODEX_THREAD_ID ?? "unidentified-thread",
  agents = [],
} = {}) {
  const inspection = await inspectControlPlane({ root, now, includeFreshness: true });
  const branch = runGit(inspection.root, ["branch", "--show-current"]);
  const status = runGit(inspection.root, ["status", "--porcelain=v1"]);
  return {
    schema_version: "sumi.agent-operations-snapshot.v1",
    captured_at: now.toISOString(),
    source: {
      repository: `starSumi/${REPOSITORY}`,
      branch,
      commit: inspection.head,
      worktree: status ? "dirty" : "clean",
    },
    control_plane: {
      phase: inspection.manifest.current_phase,
      checkpoint: inspection.manifest.current_checkpoint,
      next_action: inspection.state.next_action,
      cursor_commit: inspection.cursor.source.commit,
      cursor_sha256: hashJson(inspection.cursor),
    },
    maintenance: {
      status: inspection.healthIssues.length === 0 ? "current" : "attention",
      issues: inspection.healthIssues,
      warnings: inspection.warnings,
      surfaces: Object.fromEntries(
        Object.entries(inspection.maintainerRegistry.maintainers).map(([key, value]) => [
          key,
          {
            accountable_role: value.accountable_role,
            last_reviewed_at: value.last_reviewed_at,
            review_interval_days: value.review_interval_days,
          },
        ]),
      ),
    },
    ci: {
      event: environment.GITHUB_EVENT_NAME ?? null,
      workflow: environment.GITHUB_WORKFLOW ?? null,
      run_id: environment.GITHUB_RUN_ID ?? null,
      run_attempt: environment.GITHUB_RUN_ATTEMPT ?? null,
      run_url: environment.SUMI_OPS_RUN_URL ?? null,
      conclusion: environment.SUMI_OPS_CONCLUSION ?? null,
      reason: environment.SUMI_OPS_REASON ?? null,
    },
    session: {
      id: sessionId,
      root_agent: environment.SUMI_ROOT_AGENT ?? "/root",
      agent_edges: agents,
      semantics: "open means recoverable metadata, not a live process",
    },
    release: {
      status: inspection.manifest.release_status,
      human_acceptance_required: true,
    },
  };
}

async function appendSummary(snapshot, environment) {
  if (!environment.GITHUB_STEP_SUMMARY) return;
  const lines = [
    "## CI operations snapshot",
    "",
    `- Commit: \`${snapshot.source.commit}\``,
    `- Control plane: \`${snapshot.control_plane.phase}\` / \`${snapshot.control_plane.checkpoint}\``,
    `- Maintenance: \`${snapshot.maintenance.status}\``,
    `- Result: \`${snapshot.ci.conclusion ?? "not supplied"}\``,
    `- Release: \`${snapshot.release.status}\` (human acceptance required)`,
    "",
  ];
  await writeFile(environment.GITHUB_STEP_SUMMARY, lines.join("\n"), { flag: "a" });
}

function parseCli(argv) {
  const [command = "check", ...tokens] = argv;
  const options = { agents: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (token === "--output" || token === "--session-id" || token === "--agent") {
      requireValue(value && !value.startsWith("--"), `${token} requires a value`);
      if (token === "--agent") options.agents.push(parseAgent(value));
      else options[token.slice(2).replace("-", "_")] = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${token}`);
    }
  }
  return { command, options };
}

export async function runCli(argv = process.argv.slice(2), environment = process.env) {
  const { command, options } = parseCli(argv);
  if (command === "check") {
    const inspection = await inspectControlPlane();
    console.log(
      `agent operations check passed: ${inspection.manifest.current_phase}, ${inspection.manifest.current_checkpoint}, ${inspection.manifest.active_roles.length} roles`,
    );
    for (const warning of inspection.warnings) console.warn(`warning: ${warning}`);
    return 0;
  }
  if (command === "health") {
    const inspection = await inspectControlPlane({ includeFreshness: true });
    if (inspection.healthIssues.length > 0) {
      for (const issue of inspection.healthIssues) console.error(`health: ${issue}`);
      return 1;
    }
    console.log("agent operations health passed: maintainer reviews and handoff cursor are current");
    return 0;
  }
  if (command === "snapshot" || command === "resume") {
    const sessionId = validateSessionId(
      options.session_id ?? environment.CODEX_THREAD_ID ?? "unidentified-thread",
    );
    const snapshot = await createOperationsSnapshot({
      environment,
      sessionId,
      agents: options.agents,
    });
    const output = options.output ??
      (command === "resume"
        ? defaultRuntimePath(environment, sessionId)
        : resolve("artifacts", "agent-ops", "operations-snapshot.json"));
    const written = await atomicWriteJson(output, snapshot);
    await appendSummary(snapshot, environment);
    console.log(`${command} snapshot written: ${written}`);
    if (command === "resume") {
      console.log(`next action: ${snapshot.control_plane.next_action}`);
      console.log("re-probe live GitHub and runtime state before continuing");
    }
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
