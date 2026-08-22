// Persistence adapter migration boundary: SQL rows and driver result shapes
// are intentionally isolated here; the application and protocol layers are
// strict-checked independently while this adapter receives its row types.
// @ts-nocheck
import pg from "pg";
import {
  authorizationError,
  unsatisfiedAuthorizationObligation,
} from "./authorization/errors.ts";
import { now, sha256 } from "./contracts.ts";
import { validateEvent } from "./protocol-validation.ts";
import { DataCipher } from "./data-cipher.ts";
import {
  agentCrmIntentDefinition,
  assertAgentCrmActionProposal,
  assertExecutableAgentCrmEntities,
} from "./agent-crm-contract.ts";

const { Pool } = pg;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conflict(message = "CRM command conflict") {
  return Object.assign(new Error(message), { code: "CRM_CONFLICT" });
}

function idempotencyConflict() {
  return Object.assign(
    new Error("idempotency key was reused with a different request"),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
}

function messageJobUuid(value) {
  let raw =
    typeof value === "string" && value.startsWith("job_")
      ? value.slice(4)
      : value;
  if (typeof raw === "string" && /^[0-9a-f]{32}$/i.test(raw)) {
    raw = raw.replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/i,
      "$1-$2-$3-$4-$5",
    );
  }
  if (!UUID.test(raw)) throw conflict("message job id is invalid");
  return raw;
}

function crmResource(action, { tenant_id, request_id, entities = {} }) {
  if (action === "crm.deal.update_stage") {
    return { type: "deal", id: entities.deal?.value ?? request_id, tenant_id };
  }
  return { type: "customer", id: request_id, tenant_id };
}

function positiveInteger(value, fallback, name, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(
      `${name} must be a positive integer no greater than ${max}`,
    );
  }
  return parsed;
}

function requiredString(value, name, max = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new TypeError(
      `${name} must be a non-empty string no longer than ${max} characters`,
    );
  return value;
}

/**
 * Durable CRM command adapter. Every public operation opens a transaction,
 * binds PostgreSQL RLS using transaction-local claims, and commits business
 * state, audit and outbox records together.
 */
export class PostgresCrmStore {
  constructor({
    connectionString,
    pool,
    cipher,
    authorize,
    env = process.env,
  } = {}) {
    const resolvedConnectionString = connectionString ?? env.DATABASE_URL;
    if (!pool && !resolvedConnectionString)
      throw new Error("DATABASE_URL is required when STORE_PROVIDER=postgres");
    this.pool =
      pool ??
      new Pool({
        connectionString: resolvedConnectionString,
        max: Number(env.DATABASE_POOL_MAX || 10),
      });
    this.cipher =
      cipher ?? new DataCipher({ env: { ...env, STORE_PROVIDER: "postgres" } });
    this.authorize = authorize;
    this.interactionLeaseMs = positiveInteger(
      env.INTERACTION_LEASE_MS,
      30_000,
      "INTERACTION_LEASE_MS",
      900_000,
    );
  }

  async close() {
    await this.pool.end();
  }
  async health() {
    try {
      await this.pool.query("select 1");
      return { ready: true, provider: "postgres" };
    } catch (error) {
      return {
        ready: false,
        provider: "postgres",
        reason: error?.code ?? "database_unavailable",
      };
    }
  }

  async enqueueMessageJob({
    tenant_id,
    actor_id,
    request_id,
    idempotency_key,
    request_fingerprint,
    payload,
  }) {
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client, actorUuid) => {
        const payloadCiphertext = this.cipher.encrypt(
          payload,
          `${tenant_id}:message-job:${idempotency_key}`,
        );
        const inserted = await client.query(
          `insert into message_jobs
             (tenant_id,actor_id,request_id,idempotency_key,request_fingerprint,status,payload_ciphertext)
           values ($1,$2,$3,$4,$5,'inbound',$6) on conflict (tenant_id,idempotency_key) do nothing returning *`,
          [
            tenant_id,
            actorUuid,
            request_id,
            idempotency_key,
            request_fingerprint,
            payloadCiphertext,
          ],
        );
        if (inserted.rowCount === 1) {
          const row = inserted.rows[0];
          await this.#appendMessageTransition(client, {
            tenant_id,
            job_id: row.id,
            status: "inbound",
          });
          await client.query(
            `update message_jobs set status='job_queued',updated_at=now()
             where tenant_id=$1 and id=$2`,
            [tenant_id, row.id],
          );
          await this.#appendMessageTransition(client, {
            tenant_id,
            job_id: row.id,
            status: "job_queued",
          });
          return {
            duplicate: false,
            job: this.#messageJob({ ...row, status: "job_queued" }, tenant_id),
          };
        }
        const previous = (
          await client.query(
            "select * from message_jobs where tenant_id=$1 and idempotency_key=$2 for update",
            [tenant_id, idempotency_key],
          )
        ).rows[0];
        if (!previous || previous.request_fingerprint !== request_fingerprint)
          throw idempotencyConflict();
        return { duplicate: true, job: this.#messageJob(previous, tenant_id) };
      },
    );
  }

  async claimMessageJobs({
    tenant_id,
    worker_id,
    batch_size = 10,
    lease_ms = this.interactionLeaseMs,
  }) {
    requiredString(worker_id, "worker_id");
    const batchSize = positiveInteger(batch_size, 10, "batch_size", 1000);
    const leaseMs = positiveInteger(
      lease_ms,
      this.interactionLeaseMs,
      "lease_ms",
      900_000,
    );
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const rows = await client.query(
          `select * from message_jobs
           where tenant_id=$1 and (
             status='job_queued'
             or (status='retry_wait' and next_attempt_at <= now())
             or (status='running' and lease_expires_at <= now())
           )
           order by created_at,id
           for update skip locked limit $2`,
          [tenant_id, batchSize],
        );
        const claimed = [];
        for (const row of rows.rows) {
          const updated = await client.query(
            `update message_jobs set status='running',worker_id=$3,attempts=attempts+1,
               lease_expires_at=now()+($4::bigint * interval '1 millisecond'),
               next_attempt_at=null,updated_at=now()
             where tenant_id=$1 and id=$2
             returning *`,
            [tenant_id, row.id, worker_id, leaseMs],
          );
          const claimedRow = updated.rows[0];
          await this.#appendMessageTransition(client, {
            tenant_id,
            job_id: row.id,
            status: "running",
            worker_id,
            reason: row.status === "running" ? "lease_reclaimed" : "claimed",
          });
          claimed.push(this.#messageJob(claimedRow, tenant_id));
        }
        return claimed;
      },
      { requireActor: false },
    );
  }

  async getMessageJob({ tenant_id, actor_id, job_id, idempotency_key }) {
    const databaseJobId = job_id ? messageJobUuid(job_id) : undefined;
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client) => {
        const row = (
          await client.query(
            `select * from message_jobs where tenant_id=$1 and
             (id::text=$2 or ($3::text is not null and idempotency_key=$3))
             order by created_at desc limit 1`,
            [tenant_id, databaseJobId ?? "", idempotency_key ?? null],
          )
        ).rows[0];
        return row ? this.#messageJob(row, tenant_id) : undefined;
      },
      { requireActor: actor_id !== undefined },
    );
  }

  async messageJobTransitions({ tenant_id, actor_id, job_id }) {
    const databaseJobId = messageJobUuid(job_id);
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client) => {
        const rows = await client.query(
          `select sequence,status,worker_id,reason,created_at
             from message_job_transitions
            where tenant_id=$1 and job_id=$2 order by sequence`,
          [tenant_id, databaseJobId],
        );
        return rows.rows.map((row) => ({
          sequence: Number(row.sequence),
          status: row.status,
          worker_id: row.worker_id ?? undefined,
          reason: row.reason ?? undefined,
          created_at: new Date(row.created_at).toISOString(),
        }));
      },
      { requireActor: actor_id !== undefined },
    );
  }

  async completeMessageJob({ tenant_id, job_id, worker_id, result }) {
    const databaseJobId = messageJobUuid(job_id);
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const row = (
          await client.query(
            `select * from message_jobs where tenant_id=$1 and id=$2 for update`,
            [tenant_id, databaseJobId],
          )
        ).rows[0];
        this.#assertMessageJobLease(row, worker_id);
        const resultCiphertext = this.cipher.encrypt(
          result ?? null,
          `${tenant_id}:message-job-result:${databaseJobId}`,
        );
        const updated = await client.query(
          `update message_jobs set status='succeeded',result_ciphertext=$3,
             worker_id=null,lease_expires_at=null,completed_at=now(),updated_at=now()
           where tenant_id=$1 and id=$2 returning *`,
          [tenant_id, databaseJobId, resultCiphertext],
        );
        await this.#appendMessageTransition(client, {
          tenant_id,
          job_id: databaseJobId,
          status: "succeeded",
          worker_id,
        });
        return this.#messageJob(updated.rows[0], tenant_id);
      },
      { requireActor: false },
    );
  }

  async failMessageJob({
    tenant_id,
    job_id,
    worker_id,
    error_code = "UPSTREAM_UNAVAILABLE",
    error_message,
    max_attempts = 8,
  }) {
    const databaseJobId = messageJobUuid(job_id);
    const maxAttempts = positiveInteger(max_attempts, 8, "max_attempts", 1000);
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const row = (
          await client.query(
            "select * from message_jobs where tenant_id=$1 and id=$2 for update",
            [tenant_id, databaseJobId],
          )
        ).rows[0];
        this.#assertMessageJobLease(row, worker_id);
        const attempts = Number(row.attempts);
        const deadLetter = attempts >= maxAttempts;
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 12));
        const errorCiphertext = this.cipher.encrypt(
          {
            message: String(error_message ?? "message job failed").slice(
              0,
              2000,
            ),
          },
          `${tenant_id}:message-job-error:${databaseJobId}`,
        );
        const updated = await client.query(
          `update message_jobs set status=$3,error_code=$4,error_message_ciphertext=$5,
             worker_id=null,lease_expires_at=null,
             next_attempt_at=case when $6 then null else now()+($7::integer * interval '1 second') end,
             completed_at=case when $6 then now() else null end,updated_at=now()
           where tenant_id=$1 and id=$2 returning *`,
          [
            tenant_id,
            databaseJobId,
            deadLetter ? "dead_letter" : "retry_wait",
            error_code,
            errorCiphertext,
            deadLetter,
            delaySeconds,
          ],
        );
        await this.#appendMessageTransition(client, {
          tenant_id,
          job_id: databaseJobId,
          status: deadLetter ? "dead_letter" : "retry_wait",
          worker_id,
          reason: error_code,
        });
        return this.#messageJob(updated.rows[0], tenant_id);
      },
      { requireActor: false },
    );
  }

  async releaseMessageJob({
    tenant_id,
    job_id,
    worker_id,
    reason = "cancelled",
  }) {
    const databaseJobId = messageJobUuid(job_id);
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const row = (
          await client.query(
            "select * from message_jobs where tenant_id=$1 and id=$2 for update",
            [tenant_id, databaseJobId],
          )
        ).rows[0];
        this.#assertMessageJobLease(row, worker_id);
        const updated = await client.query(
          `update message_jobs set status='job_queued',worker_id=null,lease_expires_at=null,updated_at=now()
           where tenant_id=$1 and id=$2 returning *`,
          [tenant_id, databaseJobId],
        );
        await this.#appendMessageTransition(client, {
          tenant_id,
          job_id: databaseJobId,
          status: "job_queued",
          worker_id,
          reason,
        });
        return this.#messageJob(updated.rows[0], tenant_id);
      },
      { requireActor: false },
    );
  }

  async messageJobStats({ tenant_id }) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const rows = await client.query(
          "select status,count(*)::integer as count from message_jobs where tenant_id=$1 group by status",
          [tenant_id],
        );
        const stats = Object.fromEntries(
          [
            "inbound",
            "job_queued",
            "running",
            "succeeded",
            "retry_wait",
            "dead_letter",
            "cancelled",
          ].map((status) => [status, 0]),
        );
        for (const row of rows.rows) stats[row.status] = Number(row.count);
        return stats;
      },
      { requireActor: false },
    );
  }

  async claimEventDelivery({
    tenant_id,
    consumer_id,
    event_id,
    event_type,
    worker_id,
    lease_ms = this.interactionLeaseMs,
  }) {
    requiredString(consumer_id, "consumer_id");
    requiredString(event_id, "event_id");
    requiredString(worker_id, "worker_id");
    const leaseMs = positiveInteger(
      lease_ms,
      this.interactionLeaseMs,
      "lease_ms",
      900_000,
    );
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const existing = (
          await client.query(
            `select * from event_consumer_receipts
             where tenant_id=$1 and consumer_id=$2 and event_id=$3 for update`,
            [tenant_id, consumer_id, event_id],
          )
        ).rows[0];
        if (existing?.status === "completed")
          return { duplicate: true, status: "completed" };
        if (
          existing?.status === "claimed" &&
          existing.lease_expires_at > new Date() &&
          existing.lease_owner !== worker_id
        ) {
          return { duplicate: false, claimed: false, status: "claimed" };
        }
        if (!existing) {
          await client.query(
            `insert into event_consumer_receipts
               (tenant_id,consumer_id,event_id,event_type,status,attempts,lease_owner,lease_expires_at)
             values ($1,$2,$3,$4,'claimed',1,$5,now()+($6::bigint * interval '1 millisecond'))`,
            [
              tenant_id,
              consumer_id,
              event_id,
              event_type ?? null,
              worker_id,
              leaseMs,
            ],
          );
        } else {
          await client.query(
            `update event_consumer_receipts set status='claimed',event_type=coalesce($4,event_type),
               attempts=attempts+1,lease_owner=$5,lease_expires_at=now()+($6::bigint * interval '1 millisecond'),
               claimed_at=now(),completed_at=null
             where tenant_id=$1 and consumer_id=$2 and event_id=$3`,
            [
              tenant_id,
              consumer_id,
              event_id,
              event_type ?? null,
              worker_id,
              leaseMs,
            ],
          );
        }
        return { duplicate: false, claimed: true, status: "claimed" };
      },
      { requireActor: false },
    );
  }

  async completeEventDelivery({ tenant_id, consumer_id, event_id, worker_id }) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const updated = await client.query(
          `update event_consumer_receipts set status='completed',lease_owner=null,lease_expires_at=null,completed_at=now()
           where tenant_id=$1 and consumer_id=$2 and event_id=$3 and status='claimed'
             and lease_owner=$4 and lease_expires_at > now() returning event_id`,
          [tenant_id, consumer_id, event_id, worker_id],
        );
        if (updated.rowCount !== 1)
          throw conflict("event consumer receipt lease was lost");
        return { completed: true };
      },
      { requireActor: false },
    );
  }

  async releaseEventDelivery({ tenant_id, consumer_id, event_id, worker_id }) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const deleted = await client.query(
          `delete from event_consumer_receipts
           where tenant_id=$1 and consumer_id=$2 and event_id=$3 and status='claimed' and lease_owner=$4`,
          [tenant_id, consumer_id, event_id, worker_id],
        );
        return { released: deleted.rowCount === 1 };
      },
      { requireActor: false },
    );
  }

  async principalFor(identity) {
    return await this.#transaction(
      identity,
      async (_client, _actorUuid, principal) => principal,
    );
  }

  async #authorize(principal, action, resource, requestId) {
    const policyVersion =
      typeof principal?.policy_version === "string"
        ? principal.policy_version
        : "unknown";
    if (typeof this.authorize !== "function")
      throw authorizationError(undefined, policyVersion);
    const requestPrincipal = {
      subject_id: principal.subject_id,
      kind: principal.kind,
      tenant_id: principal.tenant_id,
      status: principal.status,
      roles: [...principal.roles],
      actor_scopes: [...principal.actor_scopes],
    };
    if (
      typeof principal.workload_id === "string" &&
      principal.workload_id.length > 0
    ) {
      requestPrincipal.workload_id = principal.workload_id;
    }
    const context = {
      token_scopes: [...principal.token_scopes],
      request_id: requestId,
    };
    if (Array.isArray(principal.authentication_methods)) {
      context.authentication_methods = [...principal.authentication_methods];
    }
    if (
      typeof principal.network_zone === "string" &&
      principal.network_zone.length > 0
    ) {
      context.network_zone = principal.network_zone;
    }
    let decision;
    try {
      decision = await this.authorize(
        Object.freeze({
          action,
          principal: Object.freeze(requestPrincipal),
          resource: Object.freeze({ ...resource }),
          context: Object.freeze(context),
        }),
      );
    } catch (error) {
      if (error?.code === "FORBIDDEN")
        throw authorizationError(error.details, policyVersion);
      throw error;
    }
    if (decision?.effect !== "allow")
      throw authorizationError(decision, policyVersion);
    return decision;
  }

  async initializeConversationState({
    tenant_id,
    actor_id,
    conversation_id,
    state,
  }) {
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client, actorUuid) => {
        const ciphertext = this.cipher.encrypt(
          state,
          `${tenant_id}:conversation:${conversation_id}`,
        );
        const inserted = await client.query(
          `insert into conversation_states (tenant_id,conversation_id,revision,state_ciphertext,updated_by)
         values ($1,$2,0,$3,$4) on conflict (tenant_id,conversation_id) do nothing returning revision`,
          [tenant_id, conversation_id, ciphertext, actorUuid],
        );
        const row =
          inserted.rowCount === 1
            ? {
                revision: inserted.rows[0].revision,
                state_ciphertext: ciphertext,
              }
            : (
                await client.query(
                  "select revision,state_ciphertext from conversation_states where tenant_id=$1 and conversation_id=$2",
                  [tenant_id, conversation_id],
                )
              ).rows[0];
        return {
          created: inserted.rowCount === 1,
          conversation_id,
          revision: Number(row.revision),
          state: this.cipher.decrypt(
            row.state_ciphertext,
            `${tenant_id}:conversation:${conversation_id}`,
          ),
        };
      },
    );
  }

  async conversationState({ tenant_id, actor_id, conversation_id }) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const row = (
        await client.query(
          "select revision,state_ciphertext from conversation_states where tenant_id=$1 and conversation_id=$2",
          [tenant_id, conversation_id],
        )
      ).rows[0];
      return row
        ? {
            conversation_id,
            revision: Number(row.revision),
            state: this.cipher.decrypt(
              row.state_ciphertext,
              `${tenant_id}:conversation:${conversation_id}`,
            ),
          }
        : undefined;
    });
  }

  async replaceConversationStateIfCurrent({
    tenant_id,
    actor_id,
    conversation_id,
    expected_revision,
    state,
  }) {
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client, actorUuid) => {
        const ciphertext = this.cipher.encrypt(
          state,
          `${tenant_id}:conversation:${conversation_id}`,
        );
        const updated = await client.query(
          `update conversation_states set revision=revision+1,state_ciphertext=$4,updated_by=$5,updated_at=now()
         where tenant_id=$1 and conversation_id=$2 and revision=$3 returning revision`,
          [
            tenant_id,
            conversation_id,
            expected_revision,
            ciphertext,
            actorUuid,
          ],
        );
        if (updated.rowCount !== 1) return { replaced: false };
        return {
          replaced: true,
          conversation_id,
          revision: Number(updated.rows[0].revision),
        };
      },
    );
  }

  async #transaction(identity, work, { requireActor = true } = {}) {
    if (!UUID.test(identity.tenant_id)) throw authorizationError();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [
        identity.tenant_id,
      ]);
      const tenant = await client.query(
        "select id,policy_version from tenants where id = $1 and status = 'active'",
        [identity.tenant_id],
      );
      if (tenant.rowCount !== 1) throw authorizationError();
      let actorUuid = null;
      let principal;
      if (requireActor) {
        const actor = await client.query(
          "select id,role,scopes,status from actors where tenant_id = $1 and subject = $2",
          [identity.tenant_id, identity.actor_id],
        );
        if (actor.rowCount !== 1 || actor.rows[0].status !== "active") {
          throw authorizationError(undefined, tenant.rows[0].policy_version);
        }
        actorUuid = actor.rows[0].id;
        principal = Object.freeze({
          ...identity,
          subject_id: identity.actor_id,
          actor_uuid: actorUuid,
          kind: identity.kind ?? identity.principal_kind ?? "human",
          status: actor.rows[0].status,
          roles: Object.freeze([actor.rows[0].role]),
          actor_scopes: Object.freeze(
            Array.isArray(actor.rows[0].scopes)
              ? [...actor.rows[0].scopes]
              : [],
          ),
          token_scopes: Object.freeze(
            Array.isArray(identity.token_scopes)
              ? [...identity.token_scopes]
              : [],
          ),
          policy_version: tenant.rows[0].policy_version,
        });
      }
      const result = await work(client, actorUuid, principal);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async execute(input) {
    const {
      tenant_id,
      idempotency_key,
      intent,
      entities,
      request_id,
      request_fingerprint,
      action,
    } = input;
    const intentDefinition = agentCrmIntentDefinition(intent);
    if (intentDefinition.effect === "write")
      assertExecutableAgentCrmEntities(intent, entities);
    if (action !== undefined) {
      assertAgentCrmActionProposal(action);
      if (action.intent !== intent)
        throw Object.assign(new Error("CRM action intent does not match command intent"), { code: "INVALID_REQUEST" });
    }
    const fingerprint =
      request_fingerprint ?? sha256(JSON.stringify({ intent, entities }));
    return await this.#transaction(
      input,
      async (client, actorUuid, principal) => {
        const authorization = await this.#authorize(
          principal,
          intent,
          crmResource(intent, { tenant_id, request_id, entities }),
          request_id,
        );
        if (authorization.obligations?.includes("human_review")) {
          throw unsatisfiedAuthorizationObligation(authorization);
        }
        const inserted = await client.query(
          `insert into crm_commands (tenant_id, request_id, idempotency_key, request_fingerprint, intent, payload, status)
         values ($1,$2,$3,$4,$5,$6::jsonb,'pending') on conflict (tenant_id,idempotency_key) do nothing returning id`,
          [
            tenant_id,
            request_id,
            idempotency_key,
            fingerprint,
            intent,
            JSON.stringify({ entities, action }),
          ],
        );
        if (inserted.rowCount === 0) {
          const previous = await client.query(
            "select request_fingerprint, status, result from crm_commands where tenant_id=$1 and idempotency_key=$2 for update",
            [tenant_id, idempotency_key],
          );
          if (previous.rows[0]?.request_fingerprint !== fingerprint)
            throw idempotencyConflict();
          if (previous.rows[0]?.status !== "committed")
            throw conflict(
              "command with this idempotency key is still pending",
            );
          return previous.rows[0].result;
        }

        let result;
        if (intent === "crm.deal.update_stage") {
          const dealId = entities.deal?.value;
          if (!UUID.test(dealId ?? ""))
            throw conflict("deal id must be a UUID in PostgreSQL mode");
          const expectedVersion = entities.deal?.expected_version;
          const updated = await client.query(
            `update deals set stage=$3, version=version+1, updated_at=now()
           where tenant_id=$1 and id=$2 and ($4::bigint is null or version=$4)
           returning id,version`,
            [tenant_id, dealId, entities.stage?.value, expectedVersion ?? null],
          );
          if (updated.rowCount !== 1)
            throw conflict("deal was not found or its version changed");
          result = {
            action: "updated",
            resource: { type: "deal", id: updated.rows[0].id },
            aggregate_version: Number(updated.rows[0].version),
          };
        } else if (intent === "crm.customer.create") {
          const created = await client.query(
            `insert into customers (tenant_id,name,preferred_language) values ($1,$2,$3) returning id,version`,
            [
              tenant_id,
              entities.customer?.name ?? "Unknown",
              entities.customer?.preferred_language ?? "en-US",
            ],
          );
          result = {
            action: "created",
            resource: { type: "customer", id: created.rows[0].id },
            aggregate_version: Number(created.rows[0].version),
          };
        } else if (intent === "crm.search") {
          result = {
            action: "read_only",
            resource: null,
            aggregate_version: 0,
          };
        } else throw Object.assign(new Error("CRM intent has no execution handler"), { code: "INVALID_REQUEST" });

        await client.query(
          "update crm_commands set status='committed', result=$3::jsonb, committed_at=now() where tenant_id=$1 and id=$2",
          [tenant_id, inserted.rows[0].id, JSON.stringify(result)],
        );
        await this.#writeAuditAndOutbox(client, {
          tenant_id,
          actorUuid,
          request_id,
          intent,
          result,
          action,
        });
        return result;
      },
    );
  }

  async createReview(input) {
    const {
      tenant_id,
      request_id,
      idempotency_key,
      request_fingerprint,
      understanding,
      action,
    } = input;
    agentCrmIntentDefinition(understanding.intent);
    if (action !== undefined) {
      assertAgentCrmActionProposal(action);
      if (action.intent !== understanding.intent)
        throw Object.assign(new Error("CRM action intent does not match review intent"), { code: "INVALID_REQUEST" });
    }
    return await this.#transaction(
      input,
      async (client, actorUuid, principal) => {
        await this.#authorize(
          principal,
          understanding.intent,
          crmResource(understanding.intent, {
            tenant_id,
            request_id,
            entities: understanding.entities,
          }),
          request_id,
        );
        const inserted = await client.query(
          `insert into crm_commands (tenant_id,request_id,idempotency_key,request_fingerprint,intent,payload,status)
         values ($1,$2,$3,$4,$5,$6::jsonb,'needs_review') on conflict (tenant_id,idempotency_key) do nothing returning id`,
          [
            tenant_id,
            request_id,
            idempotency_key,
            request_fingerprint,
            understanding.intent,
            JSON.stringify({ understanding, action }),
          ],
        );
        if (inserted.rowCount === 0) {
          const previous = await client.query(
            `select c.request_fingerprint,r.id,r.reason,r.status,r.candidates,r.expires_at
           from crm_commands c join review_tasks r on r.tenant_id=c.tenant_id and r.command_id=c.id
           where c.tenant_id=$1 and c.idempotency_key=$2
           order by r.created_at desc limit 1`,
            [tenant_id, idempotency_key],
          );
          if (previous.rows[0]?.request_fingerprint !== request_fingerprint)
            throw idempotencyConflict();
          if (!previous.rows[0])
            throw conflict("review command exists without its task");
          return this.#reviewResult(previous.rows[0]);
        }
        const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        const review = await client.query(
          `insert into review_tasks (tenant_id,command_id,reason,candidates,status,decision,expires_at)
         values ($1,$2,'low_confidence',$3::jsonb,'open',$4::jsonb,$5) returning id,reason,status,candidates,expires_at`,
          [
            tenant_id,
            inserted.rows[0].id,
            JSON.stringify(understanding.entities),
            JSON.stringify({ command_id: inserted.rows[0].id }),
            expiresAt,
          ],
        );
        const result = this.#reviewResult(review.rows[0]);
        const eventResult = {
          action: "needs_review",
          resource: { type: "review", id: result.id },
          aggregate_version: 1,
        };
        await this.#writeAuditAndOutbox(client, {
          tenant_id,
          actorUuid,
          request_id,
          intent: "crm.review.requested",
          result: eventResult,
          action,
        });
        return result;
      },
    );
  }

  async decideReview(input) {
    const {
      tenant_id,
      review_id,
      decision,
      idempotency_key,
      request_id,
      correction,
    } = input;
    return await this.#transaction(
      input,
      async (client, actorUuid, principal) => {
        const rawReviewId = review_id.startsWith("rev_")
          ? review_id
              .slice(4)
              .replace(
                /^(?=.{32}$)(.{8})(.{4})(.{4})(.{4})(.{12})$/,
                "$1-$2-$3-$4-$5",
              )
          : review_id;
        if (!UUID.test(rawReviewId))
          throw conflict("review task id must be a UUID");
        const publicReviewId = this.#reviewId(rawReviewId);
        await this.#authorize(
          principal,
          "review.decide",
          { type: "review", id: publicReviewId, tenant_id },
          request_id,
        );
        const requestFingerprint = sha256(
          JSON.stringify({
            review_id: rawReviewId,
            decision,
            correction: correction ?? null,
          }),
        );
        const previousDecision = await client.query(
          "select request_fingerprint,result from review_decisions where tenant_id=$1 and idempotency_key=$2 for update",
          [tenant_id, idempotency_key],
        );
        if (previousDecision.rowCount === 1) {
          if (
            previousDecision.rows[0].request_fingerprint !== requestFingerprint
          )
            throw idempotencyConflict();
          return previousDecision.rows[0].result;
        }
        const review = await client.query(
          "select r.*, c.id as command_id, c.intent, c.payload from review_tasks r join crm_commands c on c.id = r.command_id where r.tenant_id=$1 and r.id=$2 for update",
          [tenant_id, rawReviewId],
        );
        if (review.rowCount !== 1) throw conflict("review task not found");
        const row = review.rows[0];
        if (row.status !== "open") {
          const closedFingerprint = sha256(
            JSON.stringify({
              review_id: rawReviewId,
              decision: row.decision?.decision,
              correction: row.decision?.correction ?? null,
            }),
          );
          if (closedFingerprint !== requestFingerprint)
            throw conflict("review task is already decided");
          const result = {
            review_id: publicReviewId,
            status: row.status,
            decision: row.decision,
          };
          await client.query(
            `insert into review_decisions (tenant_id,review_id,idempotency_key,request_fingerprint,result)
           values ($1,$2,$3,$4,$5::jsonb) on conflict (tenant_id,idempotency_key) do nothing`,
            [
              tenant_id,
              rawReviewId,
              idempotency_key,
              requestFingerprint,
              JSON.stringify(result),
            ],
          );
          return result;
        }
        if (decision === "reject") {
          const rejected = {
            decision,
            actor_id: actorUuid,
            request_id,
            decided_at: now(),
            correction: correction ?? null,
          };
          await client.query(
            "update review_tasks set status='rejected', decision=$3::jsonb, updated_at=now() where tenant_id=$1 and id=$2",
            [tenant_id, rawReviewId, JSON.stringify(rejected)],
          );
          await this.#writeAuditAndOutbox(client, {
            tenant_id,
            actorUuid,
            request_id,
            intent: "crm.review.rejected",
            result: {
              action: "rejected",
              resource: { type: "review", id: publicReviewId },
              aggregate_version: 2,
            },
          });
          const result = {
            review_id: publicReviewId,
            status: "rejected",
            decision: rejected,
          };
          await client.query(
            `insert into review_decisions (tenant_id,review_id,idempotency_key,request_fingerprint,result)
           values ($1,$2,$3,$4,$5::jsonb)`,
            [
              tenant_id,
              rawReviewId,
              idempotency_key,
              requestFingerprint,
              JSON.stringify(result),
            ],
          );
          return result;
        }
        const understanding = row.payload?.understanding ?? {};
        const entities = correction?.entities ?? understanding.entities ?? {};
        const action = row.payload?.action;
        agentCrmIntentDefinition(row.intent);
        assertExecutableAgentCrmEntities(row.intent, entities);
        await this.#authorize(
          principal,
          row.intent,
          crmResource(row.intent, { tenant_id, request_id, entities }),
          request_id,
        );
        let result = {
          action: "approved",
          resource: { type: "review", id: publicReviewId },
          aggregate_version: 2,
        };
        if (row.intent === "crm.customer.create") {
          const created = await client.query(
            "insert into customers (tenant_id,name,preferred_language) values ($1,$2,$3) returning id,version",
            [
              tenant_id,
              entities.customer.name,
              entities.customer?.preferred_language ?? "en-US",
            ],
          );
          result = {
            action: "created",
            resource: { type: "customer", id: created.rows[0].id },
            aggregate_version: Number(created.rows[0].version),
          };
        } else if (row.intent === "crm.deal.update_stage") {
          const dealId = entities.deal.value;
          if (!UUID.test(dealId))
            throw conflict("deal id must be a UUID in PostgreSQL mode");
          const updated = await client.query(
            `update deals set stage=$3, version=version+1, updated_at=now()
             where tenant_id=$1 and id=$2 and ($4::bigint is null or version=$4)
             returning id,version`,
            [
              tenant_id,
              dealId,
              entities.stage.value,
              entities.deal.expected_version ?? null,
            ],
          );
          if (updated.rowCount !== 1)
            throw conflict("deal was not found or its version changed");
          result = {
            action: "updated",
            resource: { type: "deal", id: updated.rows[0].id },
            aggregate_version: Number(updated.rows[0].version),
          };
        }
        const approved = {
          decision,
          actor_id: actorUuid,
          request_id,
          decided_at: now(),
          correction: correction ?? null,
          result,
        };
        await client.query(
          "update review_tasks set status='approved', decision=$3::jsonb, updated_at=now() where tenant_id=$1 and id=$2",
          [tenant_id, rawReviewId, JSON.stringify(approved)],
        );
        await client.query(
          "update crm_commands set status='committed', result=$3::jsonb, committed_at=now() where tenant_id=$1 and id=$2",
          [tenant_id, row.command_id, JSON.stringify(result)],
        );
        await this.#writeAuditAndOutbox(client, {
          tenant_id,
          actorUuid,
          request_id,
          intent: "crm.review.approved",
          result,
          action,
        });
        const response = {
          review_id: publicReviewId,
          status: "approved",
          decision: approved,
        };
        await client.query(
          `insert into review_decisions (tenant_id,review_id,idempotency_key,request_fingerprint,result)
         values ($1,$2,$3,$4,$5::jsonb)`,
          [
            tenant_id,
            rawReviewId,
            idempotency_key,
            requestFingerprint,
            JSON.stringify(response),
          ],
        );
        return response;
      },
    );
  }

  async beginInteraction({
    tenant_id,
    actor_id,
    request_id,
    idempotency_key,
    request_fingerprint,
    input_type,
    input_payload,
  }) {
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client, actorUuid) => {
        const inputCiphertext = this.cipher.encrypt(
          input_payload,
          `${tenant_id}:input`,
        );
        const inserted = await client.query(
          `insert into voice_interactions
          (tenant_id,request_id,actor_id,input_type,status,idempotency_key,request_fingerprint,input_payload_ciphertext,lease_owner,lease_expires_at)
         values ($1,$2,$3,$4,'processing',$5,$6,$7,$2,now() + ($8::bigint * interval '1 millisecond'))
         on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id`,
          [
            tenant_id,
            request_id,
            actorUuid,
            input_type,
            idempotency_key,
            request_fingerprint,
            inputCiphertext,
            this.interactionLeaseMs,
          ],
        );
        if (inserted.rowCount === 1) {
          await this.#appendInteractionWal(client, {
            tenant_id,
            interaction_id: inserted.rows[0].id,
            request_id,
            entry_type: "started",
            payload: {
              input_type,
              idempotency_key_hash: sha256(idempotency_key),
            },
          });
          return { replay: false };
        }
        const previous = await client.query(
          `select id,request_id,request_fingerprint,status,response_ciphertext,error_code,error_message_ciphertext,http_status,
                lease_expires_at,recovery_count
         from voice_interactions where tenant_id=$1 and idempotency_key=$2 for update`,
          [tenant_id, idempotency_key],
        );
        const row = previous.rows[0];
        if (!row || row.request_fingerprint !== request_fingerprint)
          throw idempotencyConflict();
        if (row.status === "completed" || row.status === "needs_review") {
          return {
            replay: true,
            response: this.cipher.decrypt(
              row.response_ciphertext,
              `${tenant_id}:response`,
            ),
            http_status: row.http_status,
          };
        }
        if (row.status === "failed") {
          const detail = this.cipher.decrypt(
            row.error_message_ciphertext,
            `${tenant_id}:error`,
          );
          throw Object.assign(
            new Error(detail?.message ?? "interaction failed"),
            { code: row.error_code ?? "UPSTREAM_UNAVAILABLE" },
          );
        }
        if (row.status === "processing") {
          const recovered = await client.query(
            `update voice_interactions set
             request_id=$3,actor_id=$4,input_type=$5,input_payload_ciphertext=$6,
             transcript_ciphertext=null,understanding_ciphertext=null,response_ciphertext=null,
             provider_invocations='[]'::jsonb,model_versions='{}'::jsonb,latency_ms='{}'::jsonb,
             error_code=null,error_message_ciphertext=null,http_status=null,completed_at=null,input_asset_id=null,
             lease_owner=$3,lease_expires_at=now() + ($7::bigint * interval '1 millisecond'),
             recovery_count=recovery_count+1,updated_at=now()
           where tenant_id=$1 and id=$2 and status='processing' and lease_expires_at <= now()
           returning id,recovery_count`,
            [
              tenant_id,
              row.id,
              request_id,
              actorUuid,
              input_type,
              inputCiphertext,
              this.interactionLeaseMs,
            ],
          );
          if (recovered.rowCount === 1) {
            await this.#appendInteractionWal(client, {
              tenant_id,
              interaction_id: row.id,
              request_id,
              entry_type: "recovered",
              payload: {
                previous_request_id_hash: sha256(row.request_id),
                recovery_count: recovered.rows[0].recovery_count,
              },
            });
            return { replay: false, recovered: true };
          }
        }
        throw conflict(
          "interaction with this idempotency key is still processing",
        );
      },
    );
  }

  async checkpointInteraction({
    tenant_id,
    actor_id,
    request_id,
    transcript,
    understanding,
    provider_invocations = [],
    model_versions = {},
    latency_ms = {},
    input_asset_id,
  }) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const transcriptCiphertext =
        transcript === undefined
          ? null
          : this.cipher.encrypt(transcript, `${tenant_id}:transcript`);
      const understandingCiphertext =
        understanding === undefined
          ? null
          : this.cipher.encrypt(understanding, `${tenant_id}:understanding`);
      const updated = await client.query(
        `update voice_interactions set
           transcript_ciphertext=coalesce($3,transcript_ciphertext),
           understanding_ciphertext=coalesce($4,understanding_ciphertext),
           provider_invocations=provider_invocations || $5::jsonb,
           model_versions=model_versions || $6::jsonb,
           latency_ms=latency_ms || $7::jsonb,
           input_asset_id=coalesce($8,input_asset_id),
           lease_expires_at=now() + ($9::bigint * interval '1 millisecond'),updated_at=now()
         where tenant_id=$1 and request_id=$2 and status='processing'
           and lease_owner=$2 and lease_expires_at > now()
         returning id`,
        [
          tenant_id,
          request_id,
          transcriptCiphertext,
          understandingCiphertext,
          JSON.stringify(provider_invocations),
          JSON.stringify(model_versions),
          JSON.stringify(latency_ms),
          input_asset_id ?? null,
          this.interactionLeaseMs,
        ],
      );
      if (updated.rowCount !== 1)
        throw conflict("interaction checkpoint target is not processing");
      await this.#appendInteractionWal(client, {
        tenant_id,
        interaction_id: updated.rows[0].id,
        request_id,
        entry_type: "checkpointed",
        payload: {
          transcript: transcript !== undefined,
          understanding: understanding !== undefined,
          provider_operations: provider_invocations.map(
            ({ operation, status }) => ({ operation, status }),
          ),
          input_asset: Boolean(input_asset_id),
        },
      });
    });
  }

  async completeInteraction({
    tenant_id,
    actor_id,
    request_id,
    response,
    http_status,
  }) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const ciphertext = this.cipher.encrypt(response, `${tenant_id}:response`);
      const status =
        response.status === "needs_review" ? "needs_review" : "completed";
      const updated = await client.query(
        `update voice_interactions set status=$3,response_ciphertext=$4,http_status=$5,completed_at=now(),
           lease_owner=null,lease_expires_at=null,updated_at=now()
         where tenant_id=$1 and request_id=$2 and status='processing' and lease_owner=$2
           and lease_expires_at > now()
         returning id`,
        [tenant_id, request_id, status, ciphertext, http_status],
      );
      if (updated.rowCount !== 1)
        throw conflict("interaction completion target is not processing");
      await this.#appendInteractionWal(client, {
        tenant_id,
        interaction_id: updated.rows[0].id,
        request_id,
        entry_type: "completed",
        payload: { status, http_status },
      });
    });
  }

  async failInteraction({
    tenant_id,
    actor_id,
    request_id,
    error_code,
    error_message,
    http_status,
  }) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const ciphertext = this.cipher.encrypt(
        { message: error_message },
        `${tenant_id}:error`,
      );
      const updated = await client.query(
        `update voice_interactions set status='failed',error_code=$3,error_message_ciphertext=$4,http_status=$5,
           completed_at=now(),lease_owner=null,lease_expires_at=null,updated_at=now()
         where tenant_id=$1 and request_id=$2 and status='processing' and lease_owner=$2
           and lease_expires_at > now()
         returning id`,
        [tenant_id, request_id, error_code, ciphertext, http_status],
      );
      if (updated.rowCount === 1) {
        await this.#appendInteractionWal(client, {
          tenant_id,
          interaction_id: updated.rows[0].id,
          request_id,
          entry_type: "failed",
          payload: { error_code, http_status },
        });
      }
    });
  }

  async abandonInteraction({ tenant_id, actor_id, request_id }) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const released = await client.query(
        `update voice_interactions set lease_expires_at=now(),updated_at=now()
         where tenant_id=$1 and request_id=$2 and status='processing' and lease_owner=$2
           and lease_expires_at > now()
         returning id`,
        [tenant_id, request_id],
      );
      if (released.rowCount === 1) {
        await this.#appendInteractionWal(client, {
          tenant_id,
          interaction_id: released.rows[0].id,
          request_id,
          entry_type: "abandoned",
          payload: { reason: "request_cancelled" },
        });
      }
      return { released: released.rowCount === 1 };
    });
  }

  async recordInputAsset({
    tenant_id,
    actor_id,
    request_id,
    asset,
    object_key,
    byte_length,
    sha256: assetSha256,
  }) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const inserted = await client.query(
        `insert into media_assets (tenant_id,request_id,kind,object_key,external_asset_id,content_type,byte_length,sha256,status,expires_at)
         values ($1,$2,'input_audio',$3,$4,$5,$6,$7,'ready',$8)
         on conflict (tenant_id,sha256,kind) do update set object_key=excluded.object_key
         returning id,external_asset_id`,
        [
          tenant_id,
          request_id,
          object_key,
          asset.asset_id,
          asset.mime_type,
          byte_length,
          assetSha256,
          asset.expires_at,
        ],
      );
      const interaction = await client.query(
        `update voice_interactions set input_asset_id=$3,
           lease_expires_at=now() + ($4::bigint * interval '1 millisecond'),updated_at=now()
         where tenant_id=$1 and request_id=$2 and status='processing' and lease_owner=$2 and lease_expires_at > now()
         returning id`,
        [tenant_id, request_id, inserted.rows[0].id, this.interactionLeaseMs],
      );
      if (interaction.rowCount !== 1)
        throw conflict("input asset interaction lease was lost");
      return {
        asset_id: inserted.rows[0].external_asset_id,
        object_key,
        byte_length,
        sha256: assetSha256,
      };
    });
  }

  async claimOutbox({
    tenant_id,
    worker_id,
    batch_size = 25,
    lock_timeout_ms = 60_000,
  }) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const claimed = await client.query(
          `with candidates as (
           select id from outbox_events
           where tenant_id=$1 and published_at is null and dead_lettered_at is null
             and coalesce(next_attempt_at,created_at) <= now()
             and (locked_at is null or locked_at < now() - ($4::bigint * interval '1 millisecond'))
           order by created_at,id for update skip locked limit $3
         )
         update outbox_events o set locked_at=now(),lock_owner=$2
         from candidates c where o.id=c.id
         returning o.id,o.event_type,o.aggregate_type,o.aggregate_id,o.aggregate_version,o.request_id,o.payload,o.created_at,o.attempts`,
          [tenant_id, worker_id, batch_size, lock_timeout_ms],
        );
        return claimed.rows.map((row) => ({
          outbox_id: row.id,
          attempts: row.attempts,
          event: this.#event(row, tenant_id),
        }));
      },
      { requireActor: false },
    );
  }

  async markOutboxPublished({ tenant_id, worker_id, outbox_id }) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const updated = await client.query(
          `update outbox_events set published_at=now(),attempts=attempts+1,locked_at=null,lock_owner=null,last_error=null
         where tenant_id=$1 and id=$2 and lock_owner=$3 and published_at is null`,
          [tenant_id, outbox_id, worker_id],
        );
        if (updated.rowCount !== 1)
          throw conflict(
            "outbox event lease was lost before publish acknowledgement",
          );
      },
      { requireActor: false },
    );
  }

  async markOutboxFailed({
    tenant_id,
    worker_id,
    outbox_id,
    error,
    max_attempts = 8,
  }) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const row = await client.query(
          "select attempts from outbox_events where tenant_id=$1 and id=$2 and lock_owner=$3 for update",
          [tenant_id, outbox_id, worker_id],
        );
        if (row.rowCount !== 1)
          throw conflict(
            "outbox event lease was lost before failure acknowledgement",
          );
        const attempts = Number(row.rows[0].attempts) + 1;
        const dead = attempts >= max_attempts;
        const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 12));
        await client.query(
          `update outbox_events set attempts=$4,last_error=$5,locked_at=null,lock_owner=null,
           next_attempt_at=case when $6 then null else now() + ($7::integer * interval '1 second') end,
           dead_lettered_at=case when $6 then now() else null end
         where tenant_id=$1 and id=$2 and lock_owner=$3`,
          [
            tenant_id,
            outbox_id,
            worker_id,
            attempts,
            String(error).slice(0, 2000),
            dead,
            delaySeconds,
          ],
        );
        return {
          attempts,
          dead_lettered: dead,
          retry_in_seconds: dead ? undefined : delaySeconds,
        };
      },
      { requireActor: false },
    );
  }

  async releaseOutboxLeases({ tenant_id, worker_id, outbox_ids }) {
    if (!Array.isArray(outbox_ids) || outbox_ids.length === 0)
      return { released: 0 };
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const released = await client.query(
          `update outbox_events set locked_at=null,lock_owner=null
         where tenant_id=$1 and lock_owner=$2 and id = any($3::uuid[])
           and published_at is null and dead_lettered_at is null`,
          [tenant_id, worker_id, outbox_ids],
        );
        return { released: released.rowCount };
      },
      { requireActor: false },
    );
  }

  async events(tenant_id, actor_id) {
    return await this.#transaction({ tenant_id, actor_id }, async (client) => {
      const rows = await client.query(
        "select id,event_type,aggregate_type,aggregate_id,aggregate_version,request_id,payload,created_at from outbox_events where tenant_id=$1 order by created_at,id limit 100",
        [tenant_id],
      );
      return rows.rows.map((row) => this.#event(row, tenant_id));
    });
  }

  #messageJob(row, tenant_id) {
    if (!row) return undefined;
    return {
      id: `job_${String(row.id).replaceAll("-", "")}`,
      tenant_id: row.tenant_id ?? tenant_id,
      actor_id: row.actor_id,
      request_id: row.request_id,
      idempotency_key: row.idempotency_key,
      request_fingerprint: row.request_fingerprint,
      status: row.status,
      payload: row.payload_ciphertext
        ? this.cipher.decrypt(
            row.payload_ciphertext,
            `${tenant_id}:message-job:${row.idempotency_key}`,
          )
        : undefined,
      result: row.result_ciphertext
        ? this.cipher.decrypt(
            row.result_ciphertext,
            `${tenant_id}:message-job-result:${row.id}`,
          )
        : undefined,
      error_code: row.error_code ?? undefined,
      attempts: Number(row.attempts ?? 0),
      worker_id: row.worker_id ?? undefined,
      lease_expires_at: row.lease_expires_at
        ? new Date(row.lease_expires_at).toISOString()
        : undefined,
      next_attempt_at: row.next_attempt_at
        ? new Date(row.next_attempt_at).toISOString()
        : undefined,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      completed_at: row.completed_at
        ? new Date(row.completed_at).toISOString()
        : undefined,
    };
  }

  #assertMessageJobLease(row, workerId) {
    if (
      !row ||
      row.status !== "running" ||
      row.worker_id !== workerId ||
      !row.lease_expires_at ||
      row.lease_expires_at <= new Date()
    ) {
      throw conflict("message job lease was lost");
    }
  }

  async #appendMessageTransition(
    client,
    { tenant_id, job_id, status, worker_id, reason },
  ) {
    await client.query(
      `insert into message_job_transitions
         (tenant_id,job_id,sequence,status,worker_id,reason)
       select $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5
         from message_job_transitions where tenant_id=$1 and job_id=$2`,
      [tenant_id, job_id, status, worker_id ?? null, reason ?? null],
    );
  }

  #reviewResult(row) {
    return {
      id: this.#reviewId(row.id),
      reason: row.reason,
      status: row.status,
      candidates: row.candidates,
      expires_at: new Date(row.expires_at).toISOString(),
    };
  }

  #reviewId(id) {
    return `rev_${String(id).replaceAll("-", "")}`;
  }

  async #writeAuditAndOutbox(
    client,
    { tenant_id, actorUuid, request_id, intent, result, action },
  ) {
    await client.query(
      `insert into audit_records (tenant_id,actor_id,request_id,action,resource_type,resource_id,decision,after_hash)
       values ($1,$2,$3,$4,$5,$6,'committed',$7)`,
      [
        tenant_id,
        actorUuid,
        request_id,
        intent,
        result.resource?.type ?? "command",
        result.resource?.id ?? request_id,
        sha256(JSON.stringify(result)),
      ],
    );
    await client.query(
      `insert into outbox_events (tenant_id,event_type,aggregate_type,aggregate_id,aggregate_version,request_id,payload)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        tenant_id,
        intent === "crm.review.requested"
          ? "crm.review.requested.v1"
          : intent === "tts.asset.created"
            ? "tts.asset.created.v1"
            : "crm.command.committed.v1",
        result.resource?.type ?? "command",
        result.resource?.id ?? request_id,
        result.aggregate_version,
        request_id,
        JSON.stringify({
          intent,
          action,
          result,
          aggregate_version: result.aggregate_version,
          request_id,
        }),
      ],
    );
  }

  async #appendInteractionWal(
    client,
    { tenant_id, interaction_id, request_id, entry_type, payload },
  ) {
    const ciphertext = this.cipher.encrypt(
      payload,
      `${tenant_id}:interaction-wal`,
    );
    await client.query(
      `insert into interaction_wal (tenant_id,interaction_id,request_id,sequence,entry_type,payload_ciphertext)
       select $1,$2,$3,coalesce(max(sequence),0)+1,$4,$5
       from interaction_wal where tenant_id=$1 and interaction_id=$2`,
      [tenant_id, interaction_id, request_id, entry_type, ciphertext],
    );
  }

  #event(row, tenant_id) {
    return validateEvent({
      specversion: "1.0",
      id: `evt_${row.id}`,
      type: row.event_type,
      source: "urn:sumi:voice-crm/crm",
      subject: `${row.aggregate_type}/${row.aggregate_id}`,
      time: new Date(row.created_at).toISOString(),
      datacontenttype: "application/json",
      tenant_id,
      request_id: row.request_id,
      data: row.payload,
    });
  }

  #ttsKey(key) {
    const separator = String(key).indexOf(":");
    const tenant_id = separator < 0 ? "" : String(key).slice(0, separator);
    const idempotency_key =
      separator < 0 ? "" : String(key).slice(separator + 1);
    if (!UUID.test(tenant_id) || !idempotency_key)
      throw Object.assign(
        new Error(
          "PostgreSQL TTS key must be tenant UUID plus idempotency key",
        ),
        { code: "FORBIDDEN" },
      );
    return { tenant_id, idempotency_key };
  }

  async replayTts(key, fingerprint) {
    const identity = this.#ttsKey(key);
    return await this.#transaction(
      identity,
      async (client) => {
        const row = await client.query(
          "select request_fingerprint,result from tts_requests where tenant_id=$1 and idempotency_key=$2 for update",
          [identity.tenant_id, identity.idempotency_key],
        );
        if (row.rowCount === 0) return undefined;
        if (row.rows[0].request_fingerprint !== fingerprint)
          throw idempotencyConflict();
        return row.rows[0].result;
      },
      { requireActor: false },
    );
  }

  async recordTts(
    key,
    fingerprint,
    result,
    {
      tenant_id,
      actor_id,
      request_id,
      object_key,
      byte_length,
      sha256: assetSha256,
    } = {},
  ) {
    const fromKey = this.#ttsKey(key);
    if (tenant_id !== fromKey.tenant_id)
      throw Object.assign(
        new Error("TTS tenant does not match idempotency key"),
        { code: "FORBIDDEN" },
      );
    return await this.#transaction(
      { tenant_id, actor_id },
      async (client, actorUuid) => {
        const existing = await client.query(
          "select request_fingerprint,result from tts_requests where tenant_id=$1 and idempotency_key=$2 for update",
          [tenant_id, fromKey.idempotency_key],
        );
        if (existing.rowCount === 1) {
          if (existing.rows[0].request_fingerprint !== fingerprint)
            throw idempotencyConflict();
          return existing.rows[0].result;
        }
        const assetId = result.asset_id;
        const assetHash = assetSha256 ?? sha256(JSON.stringify(result));
        const media = await client.query(
          `insert into media_assets (tenant_id,request_id,kind,object_key,external_asset_id,content_type,byte_length,sha256,duration_ms,status,expires_at)
         values ($1,$2,'tts_audio',$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict do nothing returning id,external_asset_id`,
          [
            tenant_id,
            request_id,
            object_key ?? result.url ?? `tts/${tenant_id}/${assetId}`,
            assetId,
            result.mime_type ?? "application/octet-stream",
            byte_length ?? 0,
            assetHash,
            result.duration_ms ?? null,
            result.status ?? "ready",
            result.expires_at ??
              new Date(Date.now() + 86_400_000).toISOString(),
          ],
        );
        const assetCreated = media.rowCount === 1;
        const mediaRow =
          media.rows[0] ??
          (
            await client.query(
              "select id,external_asset_id from media_assets where tenant_id=$1 and kind='tts_audio' and (sha256=$2 or external_asset_id=$3) order by created_at limit 1",
              [tenant_id, assetHash, assetId],
            )
          ).rows[0];
        if (!mediaRow) throw conflict("TTS media asset could not be persisted");
        const storedAsset =
          mediaRow.external_asset_id === assetId
            ? result
            : {
                ...result,
                asset_id: mediaRow.external_asset_id,
                url: `/v1/assets/${mediaRow.external_asset_id}`,
              };
        const inserted = await client.query(
          `insert into tts_requests (tenant_id,actor_id,request_id,idempotency_key,request_fingerprint,media_asset_id,result)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict (tenant_id,idempotency_key) do nothing returning result`,
          [
            tenant_id,
            actorUuid,
            request_id,
            fromKey.idempotency_key,
            fingerprint,
            mediaRow.id,
            JSON.stringify(storedAsset),
          ],
        );
        if (inserted.rowCount === 0) {
          const race = await client.query(
            "select request_fingerprint,result from tts_requests where tenant_id=$1 and idempotency_key=$2 for update",
            [tenant_id, fromKey.idempotency_key],
          );
          if (race.rows[0]?.request_fingerprint !== fingerprint)
            throw idempotencyConflict();
          return race.rows[0]?.result;
        }
        const persisted = inserted.rows[0].result;
        if (assetCreated) {
          await this.#writeAuditAndOutbox(client, {
            tenant_id,
            actorUuid,
            request_id,
            intent: "tts.asset.created",
            result: {
              action: "created",
              resource: { type: "asset", id: persisted.asset_id },
              aggregate_version: 1,
            },
          });
        }
        return persisted;
      },
    );
  }

  async assetFor(tenant_id, asset_id) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const row = await client.query(
          "select t.result from tts_requests t join media_assets m on m.id=t.media_asset_id where t.tenant_id=$1 and m.external_asset_id=$2 order by t.created_at desc limit 1",
          [tenant_id, asset_id],
        );
        return row.rows[0]?.result;
      },
      { requireActor: false },
    );
  }

  async objectKeyFor(tenant_id, asset_id) {
    return await this.#transaction(
      { tenant_id },
      async (client) => {
        const row = await client.query(
          "select object_key from media_assets where tenant_id=$1 and external_asset_id=$2 order by created_at desc limit 1",
          [tenant_id, asset_id],
        );
        return row.rows[0]?.object_key;
      },
      { requireActor: false },
    );
  }
}

export function createPostgresStore(options) {
  return new PostgresCrmStore(options);
}
