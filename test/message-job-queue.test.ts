import assert from "node:assert/strict";
import test from "node:test";
import { testError } from "./test-types.ts";
import {
  createMemoryMessageJobQueue,
  MESSAGE_JOB_STATES,
} from "../src/message-job-queue.ts";
import { createMessageJobWorker } from "../src/message-job-worker.ts";

const base = {
  tenant_id: "tenant_demo",
  actor_id: "actor-a",
  request_id: "req_job_00000000000000000001",
  idempotency_key: "job-key-001",
  request_fingerprint: "a".repeat(64),
  payload: { type: "text", text: "queued message" },
};

test("message jobs persist inbound and job_queued transitions and deduplicate by fingerprint", () => {
  const queue = createMemoryMessageJobQueue();
  const first = queue.enqueueMessageJob(base);
  assert.equal(first.duplicate, false);
  assert.equal(first.job.status, "job_queued");
  assert.deepEqual(
    queue
      .messageJobTransitions({
        tenant_id: base.tenant_id,
        job_id: first.job.id,
      })
      .map(({ status }) => status),
    ["inbound", "job_queued"],
  );
  const replay = queue.enqueueMessageJob(base);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.job.id, first.job.id);
  assert.throws(
    () =>
      queue.enqueueMessageJob({ ...base, request_fingerprint: "b".repeat(64) }),
    (error) => testError(error).code === "IDEMPOTENCY_CONFLICT",
  );
});

test("message job reads are scoped to the actor that submitted the job", () => {
  const queue = createMemoryMessageJobQueue();
  const { job } = queue.enqueueMessageJob({
    ...base,
    idempotency_key: "job-key-actor-scope",
  });
  assert.equal(
    queue.getMessageJob({
      tenant_id: base.tenant_id,
      actor_id: "actor-b",
      job_id: job.id,
    }),
    undefined,
  );
  assert.equal(
    queue.getMessageJob({
      tenant_id: base.tenant_id,
      actor_id: base.actor_id,
      job_id: job.id,
    })?.id,
    job.id,
  );
  assert.deepEqual(
    queue.messageJobTransitions({
      tenant_id: base.tenant_id,
      actor_id: "actor-b",
      job_id: job.id,
    }),
    [],
  );
});

test("message job leases recover, retry, and dead-letter without duplicate completion", () => {
  let clock = 1_000;
  const queue = createMemoryMessageJobQueue({
    clock: () => clock,
    leaseMs: 100,
  });
  queue.enqueueMessageJob({ ...base, idempotency_key: "job-key-002" });
  const first = queue.claimMessageJobs({ worker_id: "worker-a" })[0];
  assert.equal(first.status, "running");
  assert.equal(queue.claimMessageJobs({ worker_id: "worker-b" }).length, 0);
  clock = 1_101;
  const recovered = queue.claimMessageJobs({ worker_id: "worker-b" })[0];
  assert.equal(recovered.worker_id, "worker-b");
  assert.equal(recovered.attempts, 2);
  const retry = queue.failMessageJob({
    tenant_id: base.tenant_id,
    job_id: recovered.id,
    worker_id: "worker-b",
    error_code: "UPSTREAM_UNAVAILABLE",
    retry_delay_ms: 1,
    max_attempts: 3,
  });
  assert.equal(retry.status, "retry_wait");
  clock += 2;
  const third = queue.claimMessageJobs({ worker_id: "worker-c" })[0];
  const dead = queue.failMessageJob({
    tenant_id: base.tenant_id,
    job_id: third.id,
    worker_id: "worker-c",
    error_code: "UPSTREAM_UNAVAILABLE",
    max_attempts: 3,
  });
  assert.equal(dead.status, "dead_letter");
  assert.deepEqual(
    Object.keys(queue.messageJobStats({ tenant_id: base.tenant_id })).sort(),
    [...MESSAGE_JOB_STATES].sort(),
  );
});

test("event consumer receipts suppress completed duplicates but allow expired lease recovery", () => {
  let clock = 2_000;
  const queue = createMemoryMessageJobQueue({
    clock: () => clock,
    leaseMs: 100,
  });
  const first = queue.claimEventDelivery({
    tenant_id: base.tenant_id,
    consumer_id: "billing.v1",
    event_id: "evt_00000001",
    worker_id: "worker-a",
  });
  assert.equal(first.claimed, true);
  assert.equal(
    queue.claimEventDelivery({
      tenant_id: base.tenant_id,
      consumer_id: "billing.v1",
      event_id: "evt_00000001",
      worker_id: "worker-b",
    }).claimed,
    false,
  );
  clock = 2_101;
  assert.equal(
    queue.claimEventDelivery({
      tenant_id: base.tenant_id,
      consumer_id: "billing.v1",
      event_id: "evt_00000001",
      worker_id: "worker-b",
    }).claimed,
    true,
  );
  queue.completeEventDelivery({
    tenant_id: base.tenant_id,
    consumer_id: "billing.v1",
    event_id: "evt_00000001",
    worker_id: "worker-b",
  });
  assert.deepEqual(
    queue.claimEventDelivery({
      tenant_id: base.tenant_id,
      consumer_id: "billing.v1",
      event_id: "evt_00000001",
      worker_id: "worker-c",
    }),
    { duplicate: true, status: "completed" },
  );
});

test("managed message worker completes queued jobs and releases on close", async () => {
  const queue = createMemoryMessageJobQueue({ leaseMs: 100 });
  queue.enqueueMessageJob({ ...base, idempotency_key: "job-key-worker" });
  const results: Readonly<Record<string, unknown>>[] = [];
  const worker = createMessageJobWorker({
    queue,
    workerId: "worker-managed",
    tenantIds: [base.tenant_id],
    pollIntervalMs: 5,
    processJob: async (job) => ({ request_id: job.request_id, accepted: true }),
    onResult: (result) => results.push(result),
  });
  worker.start();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (queue.messageJobStats({ tenant_id: base.tenant_id }).succeeded === 1)
      break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await worker.close();
  assert.equal(
    queue.messageJobStats({ tenant_id: base.tenant_id }).succeeded,
    1,
  );
  assert.deepEqual(results, [
    {
      status: "succeeded",
      job_id: queue.getMessageJob({
        tenant_id: base.tenant_id,
        idempotency_key: "job-key-worker",
      })?.id,
      tenant_id: base.tenant_id,
    },
  ]);
});

test("managed message worker treats result observers as non-critical", async () => {
  const queue = createMemoryMessageJobQueue({ leaseMs: 100 });
  queue.enqueueMessageJob({ ...base, idempotency_key: "job-key-observer" });
  const worker = createMessageJobWorker({
    queue,
    workerId: "worker-observer",
    tenantIds: [base.tenant_id],
    pollIntervalMs: 5,
    processJob: async () => ({ accepted: true }),
    onResult: () => {
      throw new Error("observer unavailable");
    },
  });
  worker.start();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (queue.messageJobStats({ tenant_id: base.tenant_id }).succeeded === 1)
      break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await worker.close();
  assert.equal(
    queue.messageJobStats({ tenant_id: base.tenant_id }).succeeded,
    1,
  );
});

test("managed message worker dead-letters protocol errors that are not retryable", async () => {
  const queue = createMemoryMessageJobQueue({ leaseMs: 100 });
  queue.enqueueMessageJob({
    ...base,
    idempotency_key: "job-key-terminal-error",
  });
  const worker = createMessageJobWorker({
    queue,
    workerId: "worker-terminal-error",
    tenantIds: [base.tenant_id],
    pollIntervalMs: 5,
    processJob: async () => {
      throw Object.assign(new Error("invalid input"), {
        code: "INVALID_REQUEST",
      });
    },
  });
  worker.start();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (queue.messageJobStats({ tenant_id: base.tenant_id }).dead_letter === 1)
      break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await worker.close();
  const job = queue.getMessageJob({
    tenant_id: base.tenant_id,
    idempotency_key: "job-key-terminal-error",
  });
  assert.equal(job?.status, "dead_letter");
  assert.equal(job?.attempts, 1);
});

test("managed message worker rotates the first tenant when the batch size is one", async () => {
  const queue = createMemoryMessageJobQueue({ leaseMs: 100 });
  for (const [tenant_id, suffix] of [
    ["tenant-a", "a1"],
    ["tenant-a", "a2"],
    ["tenant-b", "b1"],
  ] as const) {
    queue.enqueueMessageJob({
      ...base,
      tenant_id,
      idempotency_key: `job-key-fair-${suffix}`,
    });
  }
  const processed: string[] = [];
  const worker = createMessageJobWorker({
    queue,
    workerId: "worker-fair",
    tenantIds: ["tenant-a", "tenant-b"],
    batchSize: 1,
    pollIntervalMs: 5,
    processJob: async (job) => {
      processed.push(job.tenant_id);
      return { accepted: true };
    },
  });
  worker.start();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processed.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await worker.close();
  assert.deepEqual(processed.slice(0, 2), ["tenant-a", "tenant-b"]);
});

test("managed message worker renews a lease while a long job is active", async () => {
  const queue = createMemoryMessageJobQueue({ leaseMs: 30 });
  queue.enqueueMessageJob({
    ...base,
    idempotency_key: "job-key-heartbeat",
  });
  let resolveRenewed: (() => void) | undefined;
  const renewed = new Promise<void>((resolve) => {
    resolveRenewed = resolve;
  });
  let renewals = 0;
  const workerQueue = {
    ...queue,
    renewMessageJobLease(input: Parameters<typeof queue.renewMessageJobLease>[0]) {
      renewals += 1;
      const job = queue.renewMessageJobLease(input);
      resolveRenewed?.();
      return job;
    },
  };
  const worker = createMessageJobWorker({
    queue: workerQueue,
    workerId: "worker-heartbeat",
    tenantIds: [base.tenant_id],
    leaseMs: 30,
    pollIntervalMs: 5,
    processJob: async () => {
      await renewed;
      return { accepted: true };
    },
  });
  worker.start();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (queue.messageJobStats({ tenant_id: base.tenant_id }).succeeded === 1)
      break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await worker.close();
  assert.equal(
    queue.messageJobStats({ tenant_id: base.tenant_id }).succeeded,
    1,
  );
  assert.ok(renewals >= 1);
});
