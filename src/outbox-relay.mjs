import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createControlEngine } from "./control/index.mjs";

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function outboxConfig(env = process.env) {
  const tenantIds = String(env.OUTBOX_TENANT_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!env.OUTBOX_TARGET_URL) throw new Error("OUTBOX_TARGET_URL is required");
  const target = new URL(env.OUTBOX_TARGET_URL);
  if (env.APP_ENV === "production" && target.protocol !== "https:") throw new Error("OUTBOX_TARGET_URL must use HTTPS in production");
  if (!tenantIds.length) throw new Error("OUTBOX_TENANT_IDS must contain at least one tenant UUID");
  if (env.APP_ENV === "production" && !env.OUTBOX_HMAC_SECRET) throw new Error("OUTBOX_HMAC_SECRET is required in production");
  if (env.APP_ENV === "production" && env.OUTBOX_HMAC_SECRET.length < 32) throw new Error("OUTBOX_HMAC_SECRET must contain at least 32 characters");
  return {
    tenantIds,
    target: target.toString(),
    bearerToken: env.OUTBOX_TARGET_BEARER_TOKEN,
    hmacSecret: env.OUTBOX_HMAC_SECRET,
    batchSize: positiveInteger(env.OUTBOX_BATCH_SIZE, 25, "OUTBOX_BATCH_SIZE"),
    maxAttempts: positiveInteger(env.OUTBOX_MAX_ATTEMPTS, 8, "OUTBOX_MAX_ATTEMPTS"),
    lockTimeoutMs: positiveInteger(env.OUTBOX_LOCK_TIMEOUT_MS, 60_000, "OUTBOX_LOCK_TIMEOUT_MS"),
    pollIntervalMs: positiveInteger(env.OUTBOX_POLL_INTERVAL_MS, 1_000, "OUTBOX_POLL_INTERVAL_MS"),
  };
}

export class OutboxRelay {
  constructor({ store, config, fetchImpl = fetch, workerId = `relay-${randomUUID()}`, onResult = () => {}, control = createControlEngine() }) {
    this.store = store; this.config = config; this.fetch = fetchImpl; this.workerId = workerId; this.onResult = onResult; this.control = control;
  }

  async runOnce({ signal } = {}) {
    const result = { claimed: 0, published: 0, failed: 0, dead_lettered: 0 };
    for (const tenant_id of this.config.tenantIds) {
      signal?.throwIfAborted();
      const rows = await this.store.claimOutbox({ tenant_id, worker_id: this.workerId, batch_size: this.config.batchSize, lock_timeout_ms: this.config.lockTimeoutMs });
      result.claimed += rows.length;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        try {
          await this.#publish(row.event, signal);
          await this.store.markOutboxPublished({ tenant_id, worker_id: this.workerId, outbox_id: row.outbox_id });
          result.published += 1;
          this.onResult({ status: "published", tenant_id, outbox_id: row.outbox_id, event_id: row.event.id });
        } catch (error) {
          if (signal?.aborted || error?.circuitOpen === true) {
            await this.store.releaseOutboxLeases?.({
              tenant_id,
              worker_id: this.workerId,
              outbox_ids: rows.slice(index).map(({ outbox_id }) => outbox_id),
            });
            if (signal?.aborted) throw signal.reason ?? error;
            break;
          }
          const failure = await this.store.markOutboxFailed({ tenant_id, worker_id: this.workerId, outbox_id: row.outbox_id, error: error?.message ?? error, max_attempts: this.config.maxAttempts });
          result.failed += 1;
          if (failure.dead_lettered) result.dead_lettered += 1;
          this.onResult({ status: failure.dead_lettered ? "dead_lettered" : "retry_scheduled", tenant_id, outbox_id: row.outbox_id, event_id: row.event.id, error: error?.message ?? String(error) });
        }
      }
    }
    return result;
  }

  async #publish(event, signal) {
    const body = JSON.stringify(event);
    const headers = { "content-type": "application/cloudevents+json", "idempotency-key": event.id };
    if (this.config.bearerToken) headers.authorization = `Bearer ${this.config.bearerToken}`;
    if (this.config.hmacSecret) headers["x-sumi-signature"] = `sha256=${createHmac("sha256", this.config.hmacSecret).update(body).digest("hex")}`;
    const target = new URL(this.config.target);
    await this.control.run(`outbox.publish.${target.host}`, async (operationSignal) => {
      const response = await this.fetch(this.config.target, {
        method: "POST",
        headers,
        body,
        signal: operationSignal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`outbox target returned HTTP ${response.status}`), {
          breakerEligible: response.status >= 500 || response.status === 429,
        });
      }
    }, {
      signal,
      softTimeoutMs: 10_000,
      hardGraceMs: 2_000,
      label: "outbox publish",
      breaker: { threshold: 3, cooldownMs: 30_000 },
    });
  }
}

export function verifyOutboxSignature(body, signature, secret) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature || "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
