import { randomUUID } from "node:crypto";

export const MESSAGE_JOB_STATES = Object.freeze([
  "inbound",
  "job_queued",
  "running",
  "succeeded",
  "retry_wait",
  "dead_letter",
  "cancelled",
]);

const TERMINAL_JOB_STATES = new Set(["succeeded", "dead_letter", "cancelled"]);

function positiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return resolved;
}

function requiredString(value, name, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${max} characters`,
    );
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function conflict(message) {
  return Object.assign(new Error(message), { code: "CRM_CONFLICT" });
}

function idempotencyConflict() {
  return Object.assign(
    new Error("idempotency key was reused with a different request"),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
}

function jobKey(tenantId, idempotencyKey) {
  return `${requiredString(tenantId, "tenant_id")}\u0000${requiredString(idempotencyKey, "idempotency_key")}`;
}

function receiptKey(tenantId, consumerId, eventId) {
  return [
    requiredString(tenantId, "tenant_id"),
    requiredString(consumerId, "consumer_id"),
    requiredString(eventId, "event_id"),
  ].join("\u0000");
}

function transition(job, status, { workerId, reason, now }) {
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

function publicJob(job) {
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
  });
}

/**
 * In-memory implementation of the durable message-job port. It mirrors the
 * PostgreSQL state machine for application tests; process restart durability is
 * intentionally provided only by the PostgreSQL adapter.
 */
export function createMemoryMessageJobQueue({
  clock = () => Date.now(),
  leaseMs = 30_000,
} = {}) {
  const resolvedLeaseMs = positiveInteger(leaseMs, 30_000, "leaseMs", 900_000);
  const jobs = new Map();
  const receipts = new Map();

  function now() {
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
  } = {}) {
    const key = jobKey(tenant_id, idempotency_key);
    requiredString(request_id, "request_id");
    requiredString(request_fingerprint, "request_fingerprint", 128);
    const previous = jobs.get(key);
    if (previous) {
      if (previous.request_fingerprint !== request_fingerprint)
        throw idempotencyConflict();
      return { duplicate: true, job: publicJob(previous) };
    }
    const timestamp = new Date(now()).toISOString();
    const job = {
      id: `job_${randomUUID().replaceAll("-", "")}`,
      tenant_id,
      actor_id,
      request_id,
      idempotency_key,
      request_fingerprint,
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
  } = {}) {
    requiredString(worker_id, "worker_id");
    const batchSize = positiveInteger(limit, 25, "limit", 1000);
    const duration = positiveInteger(
      lease_ms,
      resolvedLeaseMs,
      "lease_ms",
      900_000,
    );
    const timestamp = now();
    const claimed = [];
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
      job.worker_id = worker_id;
      job.lease_expires_at = new Date(timestamp + duration).toISOString();
      job.next_attempt_at = undefined;
      transition(job, "running", {
        workerId: worker_id,
        reason: expiredRunning ? "lease_reclaimed" : "claimed",
        now: timestamp,
      });
      claimed.push(publicJob(job));
    }
    return claimed;
  }

  function getJob({ tenant_id, job_id, idempotency_key } = {}) {
    const found = [...jobs.values()].find(
      (job) =>
        job.tenant_id === tenant_id &&
        (job.id === job_id ||
          (idempotency_key && job.idempotency_key === idempotency_key)),
    );
    return found ? publicJob(found) : undefined;
  }

  function transitions({ tenant_id, job_id } = {}) {
    const found = [...jobs.values()].find(
      (job) => job.tenant_id === tenant_id && job.id === job_id,
    );
    return found ? clone(found.transitions) : [];
  }

  function assertLease(job, tenant_id, job_id, worker_id) {
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

  function complete({ tenant_id, job_id, worker_id, result } = {}) {
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
  } = {}) {
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
  } = {}) {
    const job = [...jobs.values()].find((entry) => entry.id === job_id);
    assertLease(job, tenant_id, job_id, worker_id);
    job.worker_id = undefined;
    job.lease_expires_at = undefined;
    transition(job, "job_queued", { workerId: worker_id, reason, now: now() });
    return publicJob(job);
  }

  function stats({ tenant_id } = {}) {
    const counts = Object.fromEntries(
      MESSAGE_JOB_STATES.map((state) => [state, 0]),
    );
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
  } = {}) {
    const key = receiptKey(tenant_id, consumer_id, event_id);
    requiredString(worker_id, "worker_id");
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
      previous.lease_owner !== worker_id
    ) {
      return { duplicate: false, claimed: false, status: "claimed" };
    }
    const receipt = previous ?? {
      tenant_id,
      consumer_id,
      event_id,
      event_type,
      attempts: 0,
    };
    receipt.event_type = event_type ?? receipt.event_type;
    receipt.status = "claimed";
    receipt.attempts += 1;
    receipt.lease_owner = worker_id;
    receipt.lease_expires_at = new Date(timestamp + duration).toISOString();
    receipt.claimed_at = new Date(timestamp).toISOString();
    receipts.set(key, receipt);
    return { duplicate: false, claimed: true, status: "claimed" };
  }

  function completeEvent({ tenant_id, consumer_id, event_id, worker_id } = {}) {
    const receipt = receipts.get(receiptKey(tenant_id, consumer_id, event_id));
    if (
      !receipt ||
      receipt.status !== "claimed" ||
      receipt.lease_owner !== worker_id ||
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

  function releaseEvent({ tenant_id, consumer_id, event_id, worker_id } = {}) {
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

export function isTerminalMessageJobStatus(status) {
  return TERMINAL_JOB_STATES.has(status);
}
