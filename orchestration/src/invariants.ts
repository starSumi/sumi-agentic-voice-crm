import type {
  OrchestrationRole,
  OrchestrationSpec,
  RuntimeState,
  TaskPacket,
  TaskPlan,
  TaskRuntimeState,
  TaskStateName,
  TransitionCommand,
  Workflow,
} from "./types.ts";

const REQUIRED_INVARIANTS = new Set([
  "one-supervisor-owns-plan-state",
  "task-packets-have-bounded-write-sets",
  "dependency-graphs-are-acyclic",
  "overlapping-writers-never-run-concurrently",
  "read-only-work-may-run-in-parallel",
  "state-transitions-use-version-cas",
  "task-identity-is-stable-across-retry",
  "completion-requires-declared-evidence",
  "cancellation-does-not-consume-retry-budget",
  "teardown-is-bounded-and-observed",
  "human-gates-cannot-be-self-approved",
  "runtime-state-never-enters-git",
]);

const TRANSITIONS: Readonly<Record<TaskStateName, readonly TaskStateName[]>> = {
  planned: ["admitted", "cancelled"],
  admitted: ["running", "cancelled"],
  running: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["completed", "blocked", "failed", "cancelled"],
  blocked: ["admitted", "cancelled"],
  failed: ["admitted", "cancelled"],
  completed: [],
  cancelled: [],
};

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new Error(`duplicate ${label}: ${id}`);
    seen.add(id);
  }
}

export function normalizeRepoPath(value: string): string {
  if (typeof value !== "string" || !value)
    throw new TypeError("repository path is required");
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`unsafe or unbounded repository path: ${value}`);
  }
  if (/[*?[\]{}]/.test(normalized))
    throw new Error(`write paths must be literal roots, not globs: ${value}`);
  return normalized;
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeRepoPath(left);
  const b = normalizeRepoPath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function writeSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((a) => right.some((b) => pathsOverlap(a, b)));
}

export function topologicalOrder<
  T extends { id: string; depends_on: string[] },
>(nodes: readonly T[]): string[] {
  uniqueBy(nodes, ({ id }) => id, "node id");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const dependents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (!byId.has(dependency))
        throw new Error(`${node.id} depends on missing node: ${dependency}`);
      if (dependency === node.id)
        throw new Error(`${node.id} cannot depend on itself`);
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      dependents.get(dependency)?.push(node.id);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (order.length !== nodes.length)
    throw new Error("dependency graph contains a cycle");
  return order;
}

function workflowStages(
  workflow: Workflow,
): Map<string, Workflow["stages"][number]> {
  uniqueBy(workflow.stages, ({ id }) => id, `stage in ${workflow.id}`);
  topologicalOrder(workflow.stages);
  return new Map(workflow.stages.map((stage) => [stage.id, stage]));
}

export function validateOrchestrationSpec(spec: OrchestrationSpec): void {
  if (spec.schema_version !== "sumi.dev-orchestration.v1")
    throw new Error("orchestration schema version mismatch");
  if (
    spec.runtime_state.repository_local_forbidden !== true ||
    spec.runtime_state.live_state_in_git_forbidden !== true
  ) {
    throw new Error(
      "runtime orchestration state must stay outside the repository and Git",
    );
  }
  if (spec.scheduler.max_concurrency < 1)
    throw new Error("scheduler concurrency must be positive");
  if (spec.scheduler.retry.cancellation !== "neutral")
    throw new Error("cancellation must be retry neutral");
  if (spec.scheduler.hard_grace_ms >= spec.scheduler.soft_timeout_ms) {
    throw new Error("hard grace must be shorter than the soft timeout");
  }
  if (spec.scheduler.teardown_timeout_ms < spec.scheduler.hard_grace_ms) {
    throw new Error("teardown timeout must cover the hard grace period");
  }
  if (
    spec.invariants.length !== REQUIRED_INVARIANTS.size ||
    spec.invariants.some((item) => !REQUIRED_INVARIANTS.has(item))
  ) {
    throw new Error("orchestration invariant set drifted");
  }
  uniqueBy(spec.roles, ({ id }) => id, "role id");
  uniqueBy(spec.workflows, ({ id }) => id, "workflow id");
  const roles = new Map(spec.roles.map((role) => [role.id, role]));
  const supervisors = spec.roles.filter((role) => role.kind === "supervisor");
  if (supervisors.length !== 1)
    throw new Error("exactly one supervisor role must own plan state");
  for (const role of spec.roles) {
    if (role.write_policy === "none" && role.capabilities.includes("write")) {
      throw new Error(
        `${role.id} cannot combine write capability with a none write policy`,
      );
    }
    if (role.sandbox_mode === "read-only" && role.write_policy !== "none") {
      throw new Error(
        `${role.id} read-only sandbox cannot have a write policy`,
      );
    }
    if (
      role.projection === "builtin" &&
      !["explorer", "worker"].includes(role.id)
    ) {
      throw new Error(`unsupported built-in role projection: ${role.id}`);
    }
  }
  for (const workflow of spec.workflows) {
    const stages = workflowStages(workflow);
    if (!workflow.stages.some((stage) => stage.human_gate))
      throw new Error(`${workflow.id} needs a human terminal gate`);
    for (const stage of workflow.stages) {
      if (stage.actor === "agent") {
        if (!stage.role || !roles.has(stage.role))
          throw new Error(
            `${workflow.id}.${stage.id} references an unknown role`,
          );
        if (stage.human_gate)
          throw new Error(
            `${workflow.id}.${stage.id} agent stage cannot be a human gate`,
          );
      } else if (stage.role || !stage.human_gate) {
        throw new Error(
          `${workflow.id}.${stage.id} human stage cannot name an agent role`,
        );
      }
      for (const dependency of stage.depends_on) {
        if (!stages.has(dependency))
          throw new Error(
            `${workflow.id}.${stage.id} depends on missing stage ${dependency}`,
          );
      }
    }
  }
}

function roleFor(spec: OrchestrationSpec, id: string): OrchestrationRole {
  const role = spec.roles.find((candidate) => candidate.id === id);
  if (!role) throw new Error(`unknown orchestration role: ${id}`);
  return role;
}

function allDependencies(
  taskId: string,
  tasks: Map<string, TaskPacket>,
  seen = new Set<string>(),
): Set<string> {
  const task = tasks.get(taskId);
  if (!task) return seen;
  for (const dependency of task.depends_on) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    allDependencies(dependency, tasks, seen);
  }
  return seen;
}

export function validateTaskPlan(
  plan: TaskPlan,
  spec: OrchestrationSpec,
): void {
  const workflow = spec.workflows.find(
    (candidate) => candidate.id === plan.workflow,
  );
  if (!workflow) throw new Error(`unknown workflow: ${plan.workflow}`);
  uniqueBy(plan.tasks, ({ task_id }) => task_id, "task id");
  uniqueBy(
    plan.tasks,
    ({ idempotency_key }) => idempotency_key,
    "task idempotency key",
  );
  topologicalOrder(
    plan.tasks.map((task) => ({
      id: task.task_id,
      depends_on: task.depends_on,
    })),
  );
  const tasks = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const stages = workflowStages(workflow);
  for (const task of plan.tasks) {
    if (task.workflow !== plan.workflow)
      throw new Error(`${task.task_id} workflow does not match its plan`);
    const stage = stages.get(task.stage);
    if (!stage || stage.actor !== "agent")
      throw new Error(`${task.task_id} must target an agent workflow stage`);
    if (stage.role !== task.role)
      throw new Error(`${task.task_id} role does not own stage ${task.stage}`);
    const role = roleFor(spec, task.role);
    task.read_paths.forEach(normalizeRepoPath);
    task.write_paths.forEach(normalizeRepoPath);
    if (role.write_policy === "none" && task.write_paths.length)
      throw new Error(
        `${task.task_id} read-only role cannot receive write paths`,
      );
    if (task.write_paths.length && task.acceptance_commands.length === 0) {
      throw new Error(`${task.task_id} write task needs acceptance commands`);
    }
    if (task.retry.max_attempts > spec.scheduler.retry.max_attempts) {
      throw new Error(`${task.task_id} retry budget exceeds scheduler policy`);
    }
    if (task.retry.base_delay_ms > task.retry.max_delay_ms) {
      throw new Error(`${task.task_id} retry base exceeds its maximum`);
    }
    const dependencies = allDependencies(task.task_id, tasks);
    for (const requiredStage of stage.depends_on) {
      const predecessors = plan.tasks.filter(
        (candidate) => candidate.stage === requiredStage,
      );
      if (
        predecessors.length === 0 ||
        predecessors.some((candidate) => !dependencies.has(candidate.task_id))
      ) {
        throw new Error(
          `${task.task_id} must depend on every ${requiredStage} task`,
        );
      }
    }
  }
}

export function createInitialTaskState(
  task: TaskPacket,
  now = (): string => new Date().toISOString(),
): TaskRuntimeState {
  return Object.freeze({
    task_id: task.task_id,
    version: 1,
    observed_generation: 0,
    state: "planned" as const,
    attempt: 0,
    evidence: Object.freeze({}),
    updated_at: now(),
  });
}

export class TaskStateConflictError extends Error {
  readonly code = "TASK_STATE_CONFLICT";
  constructor(taskId: string) {
    super(`task ${taskId} changed before the requested transition`);
    this.name = "TaskStateConflictError";
  }
}

export function transitionTask(
  task: TaskPacket,
  current: TaskRuntimeState,
  command: TransitionCommand,
): TaskRuntimeState {
  if (current.task_id !== task.task_id)
    throw new Error("task packet and runtime state identity mismatch");
  if (current.version !== command.expected_version)
    throw new TaskStateConflictError(task.task_id);
  if (!TRANSITIONS[current.state].includes(command.next_state)) {
    throw new Error(
      `invalid task transition: ${current.state} -> ${command.next_state}`,
    );
  }
  const evidence = Object.freeze({ ...current.evidence, ...command.evidence });
  const observedGeneration =
    command.next_state === "admitted"
      ? task.generation
      : current.observed_generation;
  const attempt =
    command.next_state === "running" ? current.attempt + 1 : current.attempt;
  if (command.next_state === "running" && attempt > task.retry.max_attempts) {
    throw new Error(`task ${task.task_id} exhausted its retry budget`);
  }
  if (command.next_state === "completed") {
    if (observedGeneration !== task.generation)
      throw new Error(
        `task ${task.task_id} cannot complete a stale generation`,
      );
    const missing = task.evidence_requirements.filter(
      (name) => !evidence[name],
    );
    if (missing.length)
      throw new Error(
        `task ${task.task_id} is missing completion evidence: ${missing.join(", ")}`,
      );
  }
  return Object.freeze({
    task_id: current.task_id,
    version: current.version + 1,
    observed_generation: observedGeneration,
    state: command.next_state,
    attempt,
    owner_epoch: command.owner_epoch ?? current.owner_epoch,
    evidence,
    error_code: command.error_code,
    updated_at: (command.now ?? (() => new Date().toISOString()))(),
  });
}

export function selectRunnableTasks(
  plan: TaskPlan,
  runtime: RuntimeState,
  spec: OrchestrationSpec,
): TaskPacket[] {
  validateTaskPlan(plan, spec);
  const states = new Map(runtime.tasks.map((state) => [state.task_id, state]));
  const packets = new Map(plan.tasks.map((task) => [task.task_id, task]));
  for (const task of plan.tasks)
    if (!states.has(task.task_id))
      throw new Error(`runtime state missing task: ${task.task_id}`);
  for (const state of runtime.tasks)
    if (!packets.has(state.task_id))
      throw new Error(`runtime state has unknown task: ${state.task_id}`);
  const active = plan.tasks.filter((task) =>
    ["running", "verifying"].includes(states.get(task.task_id)!.state),
  );
  const available = Math.max(0, spec.scheduler.max_concurrency - active.length);
  const selected: TaskPacket[] = [];
  const candidates = plan.tasks
    .filter((task) => states.get(task.task_id)?.state === "admitted")
    .filter((task) =>
      task.depends_on.every(
        (dependency) => states.get(dependency)?.state === "completed",
      ),
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.task_id.localeCompare(right.task_id),
    );
  const workflow = spec.workflows.find(
    (candidate) => candidate.id === plan.workflow,
  )!;
  const stages = new Map(workflow.stages.map((stage) => [stage.id, stage]));
  for (const task of candidates) {
    if (selected.length >= available) break;
    const stage = stages.get(task.stage)!;
    if (
      stage.mode === "serial" &&
      [...active, ...selected].some(
        (candidate) => candidate.stage === task.stage,
      )
    )
      continue;
    const conflicts = [...active, ...selected].some((candidate) =>
      writeSetsOverlap(task.write_paths, candidate.write_paths),
    );
    if (!conflicts) selected.push(task);
  }
  return selected;
}

export function deterministicRetryDelay(
  task: TaskPacket,
  attempt: number,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new TypeError("attempt must be a positive integer");
  const exponential = Math.min(
    task.retry.max_delay_ms,
    task.retry.base_delay_ms * 2 ** (attempt - 1),
  );
  let hash = 2166136261;
  for (const byte of Buffer.from(`${task.idempotency_key}:${attempt}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const multiplier = 0.75 + (hash / 0xffffffff) * 0.5;
  return Math.max(
    1,
    Math.min(task.retry.max_delay_ms, Math.round(exponential * multiplier)),
  );
}
