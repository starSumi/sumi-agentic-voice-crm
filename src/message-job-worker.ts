import { randomUUID } from "node:crypto";
import type { MessageJob, MessageJobWorkerQueue } from "./message-job-queue.ts";
import { isProtocolErrorRetryable } from "./protocol-policy.ts";

type WorkerResult = Record<string, unknown>;
type ProcessJob = (
  job: MessageJob,
  context: { signal: AbortSignal; workerId: string },
) => unknown | PromiseLike<unknown>;
type WorkerOptions = {
  queue?: MessageJobWorkerQueue;
  processJob?: ProcessJob;
  tenantIds?: readonly string[];
  workerId?: string;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  onResult?: (result: WorkerResult) => void;
};
type WorkerTask = {
  result: Promise<void>;
  controller: AbortController;
  workerId: string;
};

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

function abortError(
  reason = "message job worker stopped",
): Error & { name: string; breakerEligible: boolean } {
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
}: WorkerOptions = {}): Readonly<{
  start(): WorkerTask;
  close(reason?: unknown): Promise<void>;
  registerTenant(tenantId: string): void;
  readonly task?: WorkerTask;
  readonly workerId: string;
}> {
  if (!queue || typeof queue.claimMessageJobs !== "function") {
    throw new TypeError("message job worker requires a queue");
  }
  if (typeof processJob !== "function") {
    throw new TypeError("message job worker requires processJob");
  }
  const durableQueue = queue;
  const jobHandler = processJob;
  if (
    !Array.isArray(tenantIds) ||
    tenantIds.some(
      (tenantId) => typeof tenantId !== "string" || tenantId.length === 0,
    )
  ) {
    throw new TypeError("tenantIds must be an array of non-empty strings");
  }
  const tenants = new Set<string>(tenantIds);
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
  let task: WorkerTask | undefined;
  let stopping: Promise<void> | undefined;

  function report(result: WorkerResult): void {
    try {
      onResult(result);
    } catch {}
  }

  async function waitFor(signal: AbortSignal, delayMs: number): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
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
      const timer = setTimeout(finish, delayMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  let tenantCursor = 0;

  function orderedTenants(): string[] {
    const current = [...tenants];
    if (current.length === 0) return current;
    const cursor = tenantCursor % current.length;
    tenantCursor = (cursor + 1) % current.length;
    return [...current.slice(cursor), ...current.slice(0, cursor)];
  }

  async function claimFairBatch(): Promise<MessageJob[]> {
    const ordered = orderedTenants();
    const jobs: MessageJob[] = [];
    if (ordered.length === 0) return jobs;
    const fairShare = Math.max(
      1,
      Math.ceil(resolvedBatchSize / ordered.length),
    );
    for (const tenant_id of ordered) {
      const remaining = resolvedBatchSize - jobs.length;
      if (remaining === 0) break;
      jobs.push(
        ...(await durableQueue.claimMessageJobs({
          tenant_id,
          worker_id: workerId,
          limit: Math.min(fairShare, remaining),
          lease_ms: resolvedLeaseMs,
        })),
      );
    }
    return jobs;
  }

  async function processWithHeartbeat(
    job: MessageJob,
    signal: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    const heartbeatIntervalMs = Math.max(
      1,
      Math.min(10_000, Math.floor(resolvedLeaseMs / 3)),
    );
    let completed = false;
    const operation = Promise.resolve().then(() =>
      jobHandler(job, { signal: operationSignal, workerId }),
    );
    const heartbeat = (async () => {
      while (!completed) {
        await waitFor(operationSignal, heartbeatIntervalMs);
        if (completed) return;
        await durableQueue.renewMessageJobLease({
          tenant_id: job.tenant_id,
          job_id: job.id,
          worker_id: workerId,
          lease_ms: resolvedLeaseMs,
        });
        report({
          status: "lease_renewed",
          job_id: job.id,
          tenant_id: job.tenant_id,
        });
      }
    })().catch((error: unknown) => {
      if (!operationSignal.aborted) controller.abort(error);
      throw error;
    });
    try {
      return await Promise.race([
        operation,
        heartbeat.then(() => new Promise<never>(() => {})),
      ]);
    } finally {
      completed = true;
      if (!controller.signal.aborted)
        controller.abort(abortError("message job operation completed"));
      await heartbeat.catch(() => {});
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const jobs = await claimFairBatch();
      if (jobs.length === 0) {
        await waitFor(signal, resolvedPollIntervalMs);
        continue;
      }
      for (const job of jobs) {
        if (signal.aborted) {
          await durableQueue.releaseMessageJob({
            tenant_id: job.tenant_id,
            job_id: job.id,
            worker_id: workerId,
            reason: "worker_cancelled",
          });
          throw signal.reason ?? abortError();
        }
        try {
          const result = await processWithHeartbeat(job, signal);
          await durableQueue.completeMessageJob({
            tenant_id: job.tenant_id,
            job_id: job.id,
            worker_id: workerId,
            result,
          });
          report({
            status: "succeeded",
            job_id: job.id,
            tenant_id: job.tenant_id,
          });
        } catch (error: unknown) {
          const candidate =
            error && typeof error === "object"
              ? (error as { name?: unknown; code?: unknown; message?: unknown })
              : {};
          if (signal.aborted || candidate.name === "AbortError") {
            await durableQueue.releaseMessageJob({
              tenant_id: job.tenant_id,
              job_id: job.id,
              worker_id: workerId,
              reason: "worker_cancelled",
            });
            throw signal.reason ?? error;
          }
          if (candidate.code === "CRM_CONFLICT") {
            report({
              status: "lease_lost",
              job_id: job.id,
              tenant_id: job.tenant_id,
            });
            continue;
          }
          const errorCode =
            typeof candidate.code === "string"
              ? candidate.code
              : "UPSTREAM_UNAVAILABLE";
          const failed = await durableQueue.failMessageJob({
            tenant_id: job.tenant_id,
            job_id: job.id,
            worker_id: workerId,
            error_code: errorCode,
            error_message:
              typeof candidate.message === "string"
                ? candidate.message
                : String(error),
            max_attempts: resolvedMaxAttempts,
            retryable: isProtocolErrorRetryable(errorCode),
          });
          report({
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

  function start(): WorkerTask {
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

  async function close(reason?: unknown): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      task?.controller.abort(reason ?? abortError());
      if (task) {
        try {
          await task.result;
        } catch (error: unknown) {
          const name =
            error && typeof error === "object"
              ? (error as { name?: unknown }).name
              : undefined;
          if (name !== "AbortError") throw error;
        }
      }
    })();
    return stopping;
  }

  return Object.freeze({
    start,
    close,
    registerTenant(tenantId: string): void {
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
