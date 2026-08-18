import { randomUUID } from "node:crypto";

function positiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return resolved;
}

function abortError(reason = "message job worker stopped") {
  return Object.assign(new Error(reason), {
    name: "AbortError",
    breakerEligible: false,
  });
}

/**
 * Runs a durable message-job port without owning application business logic.
 * The handler receives a leased job and must use the same idempotency context
 * when invoking an application service.
 */
export function createMessageJobWorker({
  queue,
  processJob,
  tenantIds = [],
  workerId = `job-worker-${randomUUID()}`,
  batchSize = 10,
  leaseMs = 30_000,
  maxAttempts = 8,
  pollIntervalMs = 1_000,
  onResult = () => {},
} = {}) {
  if (!queue || typeof queue.claimMessageJobs !== "function") {
    throw new TypeError("message job worker requires a queue");
  }
  if (typeof processJob !== "function") {
    throw new TypeError("message job worker requires processJob");
  }
  if (
    !Array.isArray(tenantIds) ||
    tenantIds.some(
      (tenantId) => typeof tenantId !== "string" || tenantId.length === 0,
    )
  ) {
    throw new TypeError("tenantIds must be an array of non-empty strings");
  }
  const tenants = new Set(tenantIds);
  const resolvedBatchSize = positiveInteger(batchSize, 10, "batchSize", 1000);
  const resolvedLeaseMs = positiveInteger(leaseMs, 30_000, "leaseMs", 900_000);
  const resolvedMaxAttempts = positiveInteger(
    maxAttempts,
    8,
    "maxAttempts",
    1000,
  );
  const resolvedPollIntervalMs = positiveInteger(
    pollIntervalMs,
    1000,
    "pollIntervalMs",
    300_000,
  );
  let task;
  let stopping;

  async function wait(signal) {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason ?? abortError());
      };
      const timer = setTimeout(finish, resolvedPollIntervalMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function run(signal) {
    while (!signal.aborted) {
      const jobs = [];
      for (const tenant_id of tenants) {
        jobs.push(
          ...(await queue.claimMessageJobs({
            tenant_id,
            worker_id: workerId,
            limit: resolvedBatchSize - jobs.length,
            lease_ms: resolvedLeaseMs,
          })),
        );
        if (jobs.length >= resolvedBatchSize) break;
      }
      if (jobs.length === 0) {
        await wait(signal);
        continue;
      }
      for (const job of jobs) {
        if (signal.aborted) {
          await queue.releaseMessageJob({
            tenant_id: job.tenant_id,
            job_id: job.id,
            worker_id: workerId,
            reason: "worker_cancelled",
          });
          throw signal.reason ?? abortError();
        }
        try {
          const result = await processJob(job, { signal, workerId });
          await queue.completeMessageJob({
            tenant_id: job.tenant_id,
            job_id: job.id,
            worker_id: workerId,
            result,
          });
          onResult({
            status: "succeeded",
            job_id: job.id,
            tenant_id: job.tenant_id,
          });
        } catch (error) {
          if (signal.aborted || error?.name === "AbortError") {
            await queue.releaseMessageJob({
              tenant_id: job.tenant_id,
              job_id: job.id,
              worker_id: workerId,
              reason: "worker_cancelled",
            });
            throw signal.reason ?? error;
          }
          const failed = await queue.failMessageJob({
            tenant_id: job.tenant_id,
            job_id: job.id,
            worker_id: workerId,
            error_code: error?.code ?? "UPSTREAM_UNAVAILABLE",
            error_message: error?.message ?? String(error),
            max_attempts: resolvedMaxAttempts,
          });
          onResult({
            status: failed.status,
            job_id: job.id,
            tenant_id: job.tenant_id,
            attempts: failed.attempts,
          });
        }
      }
    }
    throw signal.reason ?? abortError();
  }

  function start() {
    if (task) return task;
    const controller = new AbortController();
    const result = run(controller.signal);
    task = {
      result,
      controller,
      workerId,
    };
    return task;
  }

  async function close(reason) {
    if (stopping) return stopping;
    stopping = (async () => {
      task?.controller.abort(reason ?? abortError());
      if (task) {
        try {
          await task.result;
        } catch (error) {
          if (error?.name !== "AbortError") throw error;
        }
      }
    })();
    return stopping;
  }

  return Object.freeze({
    start,
    close,
    registerTenant(tenantId) {
      if (typeof tenantId !== "string" || tenantId.length === 0)
        throw new TypeError("tenantId must be a non-empty string");
      tenants.add(tenantId);
    },
    get task() {
      return task;
    },
    workerId,
  });
}
