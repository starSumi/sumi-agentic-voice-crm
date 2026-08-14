import { readFile, readdir } from "node:fs/promises";

const agentRoot = ".agent";
const agentManifest = JSON.parse(
  await readFile(`${agentRoot}/.agent.manifest.json`, "utf8"),
);
const agentState = JSON.parse(
  await readFile(`${agentRoot}/.agent.state.json`, "utf8"),
);
const phaseRoleMatrix = JSON.parse(
  await readFile(`${agentRoot}/phase-role-matrix.json`, "utf8"),
);

for (const key of [
  "schema_version",
  "phase_order",
  "checkpoint_order",
  "active_roles",
  "evidence_policy",
]) {
  if (!(key in agentManifest)) {
    throw new Error(`agent manifest field missing: ${key}`);
  }
}
for (const key of ["phase_status", "checkpoint_status", "next_action"]) {
  if (!(key in agentState)) throw new Error(`agent state field missing: ${key}`);
}
const allowedStatuses = new Set([
  "planned",
  "in_progress",
  "blocked",
  "completed",
  "waived",
]);
for (const [phase, status] of Object.entries(agentState.phase_status)) {
  if (!allowedStatuses.has(status)) {
    throw new Error(`invalid phase status for ${phase}: ${status}`);
  }
}
for (const [checkpoint, state] of Object.entries(agentState.checkpoint_status)) {
  if (!allowedStatuses.has(state.status)) {
    throw new Error(`invalid checkpoint status for ${checkpoint}: ${state.status}`);
  }
}
const activePhases = Object.entries(agentState.phase_status)
  .filter(([, status]) => status === "in_progress")
  .map(([phase]) => phase);
const activeCheckpoints = Object.entries(agentState.checkpoint_status)
  .filter(([, state]) => state.status === "in_progress")
  .map(([checkpoint]) => checkpoint);
if (
  activePhases.length !== 1 ||
  activePhases[0] !== agentManifest.current_phase
) {
  throw new Error("manifest must identify the single in-progress phase");
}
if (
  activeCheckpoints.length !== 1 ||
  activeCheckpoints[0] !== agentManifest.current_checkpoint
) {
  throw new Error("manifest must identify the single in-progress checkpoint");
}
if (phaseRoleMatrix.schema_version !== "sumi.agent-phase-role-matrix.v1") {
  throw new Error("agent phase-role matrix schema mismatch");
}
if (JSON.stringify(phaseRoleMatrix.phase_order) !== JSON.stringify(agentManifest.phase_order)) {
  throw new Error("agent phase order mismatch");
}
if (JSON.stringify(phaseRoleMatrix.checkpoint_order) !== JSON.stringify(agentManifest.checkpoint_order)) {
  throw new Error("agent checkpoint order mismatch");
}
if (
  phaseRoleMatrix.phases.length !== agentManifest.phase_order.length ||
  phaseRoleMatrix.checkpoints.length !== agentManifest.checkpoint_order.length
) {
  throw new Error("agent phase/checkpoint matrix count mismatch");
}

const phaseFiles = (await readdir(`${agentRoot}/phases`)).filter((file) =>
  file.endsWith(".agent.md"),
);
const checkpointFiles = (await readdir(`${agentRoot}/checkpoints`)).filter(
  (file) => file.endsWith(".agent.md"),
);
const roleFiles = (await readdir(`${agentRoot}/roles`)).filter((file) =>
  file.endsWith(".agent.md"),
);
if (
  phaseFiles.length !== agentManifest.phase_order.length ||
  checkpointFiles.length !== agentManifest.checkpoint_order.length ||
  roleFiles.length !== agentManifest.active_roles.length
) {
  throw new Error("agent control-plane card counts do not match manifest");
}
const roleIds = new Set(roleFiles.map((file) => file.replace(/\.agent\.md$/, "")));
for (const role of agentManifest.active_roles) {
  if (!roleIds.has(role)) throw new Error(`role card missing: ${role}`);
}

const localPaths = [
  ".agent.local/",
  ".agent-runtime/",
  ".agent-cache/",
  ".agent-artifacts/",
  ".agent-work/",
];
const ignoreFiles = [
  ".gitignore",
  ".dockerignore",
  ".npmignore",
  ".eslintignore",
  ".prettierignore",
  ".vercelignore",
  ".gcloudignore",
];
for (const ignoreFile of ignoreFiles) {
  const ignore = await readFile(ignoreFile, "utf8");
  for (const localPath of localPaths) {
    if (!ignore.includes(localPath)) {
      throw new Error(`${ignoreFile} is missing local agent path: ${localPath}`);
    }
  }
}

const buildOnlyIgnoreFiles = [
  ".dockerignore",
  ".npmignore",
  ".eslintignore",
  ".prettierignore",
  ".vercelignore",
  ".gcloudignore",
];
const buildOnlyPaths = [".agent/", ".agent-*.json", ".agent-*.tmp"];
for (const ignoreFile of buildOnlyIgnoreFiles) {
  const ignore = await readFile(ignoreFile, "utf8");
  for (const buildOnlyPath of buildOnlyPaths) {
    if (!ignore.includes(buildOnlyPath)) {
      throw new Error(`${ignoreFile} is missing build-only agent path: ${buildOnlyPath}`);
    }
  }
}

console.log(
  `agent check passed: ${phaseFiles.length} phases, ${checkpointFiles.length} checkpoints, ${roleFiles.length} roles, one active phase/checkpoint, local state ignored`,
);
