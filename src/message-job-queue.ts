import { randomUUID } from "node:crypto";

export const MESSAGE_JOB_STATES = Object.freeze([
  "inbound",
  "job_queued",
  "running",
  "succeeded",
  "retry_wait",
  "dead_letter",
  "cancelled",
]) as readonly [
  "inbound",
  "job_queued",
  "running",
  "succeeded",
  "retry_wait",
  "dead_letter",
  "cancelled",
];
export type MessageJobStatus = (typeof MESSAGE_JOB_STATES)[number];
export type MessageJobTransition = {
  sequence: number;
  status: MessageJobStatus;
  worker_id?: string;
  reason?: string;
  created_at: string;
};
type StoredJob = {
  id: string;
  tenant_id: string;
  actor_id?: string;
  request_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: MessageJobStatus;
  payload?: unknown;
  result?: unknown;
  error_code?: string;
  error_message?: string;
  attempts: number;
  worker_id?: string;
  lease_expires_at?: string;
  next_attempt_at?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  transitions: MessageJobTransition[];
};
export type MessageJob = Readonly<
  Omit<StoredJob, "transitions" | "error_message">
>;
type EventReceipt = {
  tenant_id: string;
  consumer_id: string;
  event_id: string;
  event_type?: string;
  attempts: number;
  status?: "claimed" | "completed";
  lease_owner?: string;
  lease_expires_at?: string;
  claimed_at?: string;
  completed_at?: string;
};
export type MessageJobQueue = Readonly<{
  enqueueMessageJob(input: EnqueueInput): {
    duplicate: boolean;
    job: MessageJob;
  };
  claimMessageJobs(input: ClaimInput): MessageJob[];
  getMessageJob(input: GetJobInput): MessageJob | undefined;
  messageJobTransitions(input: GetJobInput): MessageJobTransition[];
  completeMessageJob(input: CompleteInput): MessageJob;
  failMessageJob(input: FailInput): MessageJob;
  releaseMessageJob(input: ReleaseInput): MessageJob;
  messageJobStats(input?: {
    tenant_id?: string;
  }): Record<MessageJobStatus, number>;
  claimEventDelivery(input: ClaimEventInput): Record<string, unknown>;
  completeEventDelivery(input: CompleteEventInput): Record<string, unknown>;
  releaseEventDelivery(input: CompleteEventInput): Record<string, unknown>;
}>;
type EnqueueInput = {
  tenant_id?: unknown;
  actor_id?: unknown;
  request_id?: unknown;
  idempotency_key?: unknown;
  request_fingerprint?: unknown;
  payload?: unknown;
};
type ClaimInput = {
  tenant_id?: string;
  worker_id?: unknown;
  limit?: unknown;
  lease_ms?: unknown;
};
type GetJobInput = {
  tenant_id?: string;
  job_id?: string;
  idempotency_key?: string;
};
type CompleteInput = {
  tenant_id?: string;
  job_id?: string;
  worker_id?: string;
  result?: unknown;
};
type FailInput = {
  tenant_id?: string;
  job_id?: string;
  worker_id?: string;
  error_code?: string;
  error_message?: unknown;
  max_attempts?: unknown;
  retry_delay_ms?: unknown;
};
type ReleaseInput = {
  tenant_id?: string;
  job_id?: string;
  worker_id?: string;
  reason?: string;
};
type ClaimEventInput = {
  tenant_id?: unknown;
  consumer_id?: unknown;
  event_id?: unknown;
  event_type?: unknown;
  worker_id?: unknown;
  lease_ms?: unknown;
};
type CompleteEventInput = {
  tenant_id?: unknown;
  consumer_id?: unknown;
  event_id?: unknown;
  worker_id?: unknown;
};
type Awaitable<T> = T | PromiseLike<T>;

export type MessageJobWorkerQueue = Readonly<{
  claimMessageJobs(input: ClaimInput): Awaitable<MessageJob[]>;
  completeMessageJob(input: CompleteInput): Awaitable<MessageJob>;
  failMessageJob(input: FailInput): Awaitable<MessageJob>;
  releaseMessageJob(input: ReleaseInput): Awaitable<MessageJob>;
}>;

const TERMINAL_JOB_STATES: ReadonlySet<MessageJobStatus> = new Set([
  "succeeded",
  "dead_letter",
  "cancelled",
]);

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return resolved;
}

function requiredString(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${max} characters`,
    );
  }
  return value;
}

function clone<T = unknown>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function conflict(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "CRM_CONFLICT" });
}

function idempotencyConflict(): Error & { code: string } {
  return Object.assign(
    new Error("idempotency key was reused with a different request"),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
}

function jobKey(tenantId: unknown, idempotencyKey: unknown): string {
  return `${requiredString(tenantId, "tenant_id")}\u0000${requiredString(idempotencyKey, "idempotency_key")}`;
}

function receiptKey(
  tenantId: unknown,
  consumerId: unknown,
  eventId: unknown,
): string {
  return [
    requiredString(tenantId, "tenant_id"),
    requiredString(consumerId, "consumer_id"),
    requiredString(eventId, "event_id"),
  ].join("\u0000");
}

function transition(
  job: StoredJob,
  status: MessageJobStatus,
  {
    workerId,
    reason,
    now,
  }: { workerId?: string; reason?: string; now: number },
): void {
  job.status = status;
  job.updated_at = new Date(now).toISOString();
  job.transitions.push({
    sequence: job.transitions.length + 1,
    status,
    worker_id: workerId,
    reason,
    created_at: job.updated_at,
  });
}

function publicJob(job: StoredJob): MessageJob {
  return clone({
    id: job.id,
    tenant_id: job.tenant_id,
    actor_id: job.actor_id,
    request_id: job.request_id,
    idempotency_key: job.idempotency_key,
    request_fingerprint: job.request_fingerprint,
    status: job.status,
    payload: job.payload,
    result: job.result,
    error_code: job.error_code,
    attempts: job.attempts,
    worker_id: job.worker_id,
    lease_expires_at: job.lease_expires_at,
    next_attempt_at: job.next_attempt_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  }) as MessageJob;
}

/**
 * In-memory implementation of the durable message-job port. It mirrors the
 * PostgreSQL state machine for application tests; process restart durability is
 * intentionally provided only by the PostgreSQL adapter.
 */
export function createMemoryMessageJobQueue({
  clock = () => Date.now(),
  leaseMs = 30_000,
}: { clock?: () => number; leaseMs?: number } = {}): MessageJobQueue {
  const resolvedLeaseMs = positiveInteger(leaseMs, 30_000, "leaseMs", 900_000);
  const jobs = new Map<string, StoredJob>();
  const receipts = new Map<string, EventReceipt>();

  function now(): number {
    const value = Number(clock());
    if (!Number.isFinite(value))
      throw new TypeError("clock must return a finite timestamp");
    return value;
  }

  function enqueue({
    tenant_id,
    actor_id,
    request_id,
    idempotency_key,
    request_fingerprint,
    payload,
  }: EnqueueInput = {}): { duplicate: boolean; job: MessageJob } {
    const tenantId = requiredString(tenant_id, "tenant_id");
    const idempotencyKey = requiredString(idempotency_key, "idempotency_key");
    const requestId = requiredString(request_id, "request_id");
    const requestFingerprint = requiredString(
      request_fingerprint,
      "request_fingerprint",
      128,
    );
    const actorId =
      actor_id === undefined ? undefined : requiredString(actor_id, "actor_id");
    const key = jobKey(tenantId, idempotencyKey);
    const previous = jobs.get(key);
    if (previous) {
      if (previous.request_fingerprint !== requestFingerprint)
        throw idempotencyConflict();
      return { duplicate: true, job: publicJob(previous) };
    }
    const timestamp = new Date(now()).toISOString();
    const job: StoredJob = {
      id: `job_${randomUUID().replaceAll("-", "")}`,
      tenant_id: tenantId,
      actor_id: actorId,
      request_id: requestId,
      idempotency_key: idempotencyKey,
      request_fingerprint: requestFingerprint,
      status: "inbound",
      payload: clone(payload),
      result: undefined,
      error_code: undefined,
      attempts: 0,
      worker_id: undefined,
      lease_expires_at: undefined,
      next_attempt_at: undefined,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: undefined,
      transitions: [],
    };
    jobs.set(key, job);
    transition(job, "inbound", { now: now() });
    transition(job, "job_queued", { now: now() });
    return { duplicate: false, job: publicJob(job) };
  }

  function claim({
    tenant_id,
    worker_id,
    limit = 25,
    lease_ms = resolvedLeaseMs,
  }: ClaimInput = {}): MessageJob[] {
    const workerId = requiredString(worker_id, "worker_id");
    const batchSize = positiveInteger(limit, 25, "limit", 1000);
    const duration = positiveInteger(
      lease_ms,
      resolvedLeaseMs,
      "lease_ms",
      900_000,
    );
    const timestamp = now();
    const claimed: MessageJob[] = [];
    for (const job of jobs.values()) {
      if (tenant_id !== undefined && job.tenant_id !== tenant_id) continue;
      const eligibleRetry =
        job.status === "retry_wait" &&
        (!job.next_attempt_at || Date.parse(job.next_attempt_at) <= timestamp);
      const expiredRunning =
        job.status === "running" &&
        job.lease_expires_at &&
        Date.parse(job.lease_expires_at) <= timestamp;
      if (!(job.status === "job_queued" || eligibleRetry || expiredRunning))
        continue;
      if (claimed.length >= batchSize) break;
      job.attempts += 1;
      job.worker_id = workerId;
      job.lease_expires_at = new Date(timestamp + duration).toISOString();
      job.next_attempt_at = undefined;
      transition(job, "running", {
        workerId,
        reason: expiredRunning ? "lease_reclaimed" : "claimed",
        now: timestamp,
      });
      claimed.push(publicJob(job));
    }
    return claimed;
  }

  function getJob({ tenant_id, job_id, idempotency_key }: GetJobInput = {}):
    MessageJob | undefined {
    const found = [...jobs.values()].find(
      (job) =>
        job.tenant_id === tenant_id &&
        (job.id === job_id ||
          (idempotency_key && job.idempotency_key === idempotency_key)),
    );
    return found ? publicJob(found) : undefined;
  }

  function transitions({
    tenant_id,
    job_id,
  }: GetJobInput = {}): MessageJobTransition[] {
    const found = [...jobs.values()].find(
      (job) => job.tenant_id === tenant_id && job.id === job_id,
    );
    return found ? (clone(found.transitions) ?? []) : [];
  }

  function assertLease(
    job: StoredJob | undefined,
    tenant_id: string | undefined,
    job_id: string | undefined,
    worker_id: string | undefined,
  ): asserts job is StoredJob {
    if (
      !job ||
      job.tenant_id !== tenant_id ||
      job.id !== job_id ||
      job.status !== "running" ||
      job.worker_id !== worker_id ||
      !job.lease_expires_at ||
      Date.parse(job.lease_expires_at) <= now()
    ) {
      throw conflict("message job lease was lost");
    }
  }

  function complete({
    tenant_id,
    job_id,
    worker_id,
    result,
  }: CompleteInput = {}): MessageJob {
    const job = [...jobs.values()].find((entry) => entry.id === job_id);
    assertLease(job, tenant_id, job_id, worker_id);
    job.result = clone(result);
    job.error_code = undefined;
    job.worker_id = undefined;
    job.lease_expires_at = undefined;
    job.completed_at = new Date(now()).toISOString();
    transition(job, "succeeded", { workerId: worker_id, now: now() });
    return publicJob(job);
  }

  function fail({
    tenant_id,
    job_id,
    worker_id,
    error_code = "UPSTREAM_UNAVAILABLE",
    error_message,
    max_attempts = 8,
    retry_delay_ms,
  }: FailInput = {}): MessageJob {
    const job = [...jobs.values()].find((entry) => entry.id === job_id);
    assertLease(job, tenant_id, job_id, worker_id);
    const max = positiveInteger(max_attempts, 8, "max_attempts", 1000);
    const retryable = job.attempts < max;
    const delay =
      retry_delay_ms === undefined
        ? Math.min(3_600_000, 1000 * 2 ** Math.min(job.attempts, 12))
        : positiveInteger(retry_delay_ms, 1, "retry_delay_ms", 3_600_000);
    job.error_code = error_code;
    job.error_message =
      typeof error_message === "string"
        ? error_message.slice(0, 2000)
        : undefined;
    job.worker_id = undefined;
    job.lease_expires_at = undefined;
    job.next_attempt_at = retryable
      ? new Date(now() + delay).toISOString()
      : undefined;
    job.completed_at = retryable ? undefined : new Date(now()).toISOString();
    transition(job, retryable ? "retry_wait" : "dead_letter", {
      workerId: worker_id,
      reason: error_code,
      now: now(),
    });
    return publicJob(job);
  }

  function release({
    tenant_id,
    job_id,
    worker_id,
    reason = "cancelled",
  }: ReleaseInput = {}): MessageJob {
    const job = [...jobs.values()].find((entry) => entry.id === job_id);
    assertLease(job, tenant_id, job_id, worker_id);
    job.worker_id = undefined;
    job.lease_expires_at = undefined;
    transition(job, "job_queued", { workerId: worker_id, reason, now: now() });
    return publicJob(job);
  }

  function stats({ tenant_id }: { tenant_id?: string } = {}): Record<
    MessageJobStatus,
    number
  > {
    const counts = Object.fromEntries(
      MESSAGE_JOB_STATES.map((state) => [state, 0]),
    ) as Record<MessageJobStatus, number>;
    for (const job of jobs.values()) {
      if (tenant_id === undefined || job.tenant_id === tenant_id)
        counts[job.status] += 1;
    }
    return counts;
  }

  function claimEvent({
    tenant_id,
    consumer_id,
    event_id,
    event_type,
    worker_id,
    lease_ms = resolvedLeaseMs,
  }: ClaimEventInput = {}): Record<string, unknown> {
    const tenantId = requiredString(tenant_id, "tenant_id");
    const consumerId = requiredString(consumer_id, "consumer_id");
    const eventId = requiredString(event_id, "event_id");
    const workerId = requiredString(worker_id, "worker_id");
    const key = receiptKey(tenantId, consumerId, eventId);
    const duration = positiveInteger(
      lease_ms,
      resolvedLeaseMs,
      "lease_ms",
      900_000,
    );
    const timestamp = now();
    const previous = receipts.get(key);
    if (previous?.status === "completed")
      return { duplicate: true, status: "completed" };
    if (
      previous?.lease_expires_at &&
      Date.parse(previous.lease_expires_at) > timestamp &&
      previous.lease_owner !== workerId
    ) {
      return { duplicate: false, claimed: false, status: "claimed" };
    }
    const receipt: EventReceipt = previous ?? {
      tenant_id: tenantId,
      consumer_id: consumerId,
      event_id: eventId,
      event_type: typeof event_type === "string" ? event_type : undefined,
      attempts: 0,
    };
    receipt.event_type =
      typeof event_type === "string" ? event_type : receipt.event_type;
    receipt.status = "claimed";
    receipt.attempts += 1;
    receipt.lease_owner = workerId;
    receipt.lease_expires_at = new Date(timestamp + duration).toISOString();
    receipt.claimed_at = new Date(timestamp).toISOString();
    receipts.set(key, receipt);
    return { duplicate: false, claimed: true, status: "claimed" };
  }

  function completeEvent({
    tenant_id,
    consumer_id,
    event_id,
    worker_id,
  }: CompleteEventInput = {}): Record<string, unknown> {
    const receipt = receipts.get(receiptKey(tenant_id, consumer_id, event_id));
    if (
      !receipt ||
      receipt.status !== "claimed" ||
      receipt.lease_owner !== worker_id ||
      !receipt.lease_expires_at ||
      Date.parse(receipt.lease_expires_at) <= now()
    ) {
      throw conflict("event consumer receipt lease was lost");
    }
    receipt.status = "completed";
    receipt.lease_owner = undefined;
    receipt.lease_expires_at = undefined;
    receipt.completed_at = new Date(now()).toISOString();
    return { completed: true };
  }

  function releaseEvent({
    tenant_id,
    consumer_id,
    event_id,
    worker_id,
  }: CompleteEventInput = {}): Record<string, unknown> {
    const key = receiptKey(tenant_id, consumer_id, event_id);
    const receipt = receipts.get(key);
    if (
      !receipt ||
      receipt.status !== "claimed" ||
      receipt.lease_owner !== worker_id
    )
      return { released: false };
    receipts.delete(key);
    return { released: true };
  }

  return Object.freeze({
    enqueueMessageJob: enqueue,
    claimMessageJobs: claim,
    getMessageJob: getJob,
    messageJobTransitions: transitions,
    completeMessageJob: complete,
    failMessageJob: fail,
    releaseMessageJob: release,
    messageJobStats: stats,
    claimEventDelivery: claimEvent,
    completeEventDelivery: completeEvent,
    releaseEventDelivery: releaseEvent,
  });
}

export function isTerminalMessageJobStatus(
  status: unknown,
): status is MessageJobStatus {
  return (
    typeof status === "string" &&
    TERMINAL_JOB_STATES.has(status as MessageJobStatus)
  );
}
