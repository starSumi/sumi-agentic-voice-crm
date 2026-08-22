export type RoleKind =
  "supervisor" | "discover" | "worker" | "reviewer" | "verifier";
export type RoleProjection = "builtin" | "custom";
export type SandboxMode = "read-only" | "workspace-write";
export type WritePolicy = "none" | "task-packet" | "integration";
export type Capability =
  | "read"
  | "write"
  | "coordinate"
  | "integrate"
  | "verify"
  | "security-review"
  | "protocol-review"
  | "release-review";

export type OrchestrationRole = {
  id: string;
  description: string;
  kind: RoleKind;
  projection: RoleProjection;
  sandbox_mode: SandboxMode;
  capabilities: Capability[];
  write_policy: WritePolicy;
  developer_instructions: string;
};

export type WorkflowStage = {
  id: string;
  actor: "agent" | "human";
  role?: string;
  depends_on: string[];
  mode: "serial" | "parallel";
  required_evidence: string[];
  human_gate: boolean;
};

export type Workflow = {
  id: string;
  description: string;
  stages: WorkflowStage[];
};

export type OrchestrationSpec = {
  $schema?: string;
  schema_version: "sumi.dev-orchestration.v1";
  runtime_state: {
    storage: "external-durable-state";
    canonical_roots: string[];
    repository_local_forbidden: true;
    live_state_in_git_forbidden: true;
  };
  scheduler: {
    algorithm: "dependency-dag";
    max_concurrency: number;
    write_conflict: "path-prefix-overlap";
    delivery: "at-least-once";
    task_identity: "stable-idempotency-key";
    state_transition: "versioned-compare-and-swap";
    cancellation: "abort-signal";
    soft_timeout_ms: number;
    hard_grace_ms: number;
    teardown_timeout_ms: number;
    retry: {
      max_attempts: number;
      backoff: "bounded-exponential";
      jitter: "deterministic-task-key";
      cancellation: "neutral";
    };
  };
  roles: OrchestrationRole[];
  workflows: Workflow[];
  projections: {
    codex: { config: string; agents_directory: string };
    skill: { directory: string; metadata: string };
  };
  invariants: string[];
};

export type TaskPacket = {
  schema_version: "sumi.dev-task.v1";
  task_id: string;
  workflow: string;
  stage: string;
  role: string;
  objective: string;
  generation: number;
  idempotency_key: string;
  priority: number;
  read_paths: string[];
  write_paths: string[];
  depends_on: string[];
  acceptance_commands: string[];
  evidence_requirements: string[];
  timeout: { soft_ms: number; hard_grace_ms: number; teardown_ms: number };
  retry: { max_attempts: number; base_delay_ms: number; max_delay_ms: number };
};

export type TaskPlan = {
  schema_version: "sumi.dev-plan.v1";
  workflow: string;
  tasks: TaskPacket[];
};

export type TaskStateName =
  | "planned"
  | "admitted"
  | "running"
  | "verifying"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskRuntimeState = {
  task_id: string;
  version: number;
  observed_generation: number;
  state: TaskStateName;
  attempt: number;
  owner_epoch?: string;
  evidence: Record<string, string>;
  error_code?: string;
  updated_at: string;
};

export type RuntimeState = {
  schema_version: "sumi.dev-runtime-state.v1";
  plan_id: string;
  tasks: TaskRuntimeState[];
};

export type TransitionCommand = {
  expected_version: number;
  next_state: TaskStateName;
  owner_epoch?: string;
  evidence?: Record<string, string>;
  error_code?: string;
  now?: () => string;
};
