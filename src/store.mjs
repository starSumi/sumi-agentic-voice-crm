import { randomUUID } from "node:crypto";
import { now, sha256 } from "./contracts.mjs";
import { validateEvent } from "./protocol-validation.mjs";
import { createMemoryMessageJobQueue } from "./message-job-queue.mjs";

export class CrmStore {
  #idempotency = new Map(); #tts = new Map(); #assets = new Map(); #assetObjects = new Map(); #interactions = new Map(); #interactionWal = []; #conversations = new Map(); #events = []; #audits = []; #outbox = []; #reviews = new Map(); #reviewIdempotency = new Map(); #deals = new Map(); #customers = new Map(); #messageJobs;
  constructor({ clock = () => Date.now(), interactionLeaseMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(interactionLeaseMs) || interactionLeaseMs <= 0) throw new TypeError("interactionLeaseMs must be a positive integer");
    this.clock = clock;
    this.interactionLeaseMs = interactionLeaseMs;
    this.#messageJobs = createMemoryMessageJobQueue({ clock, leaseMs: interactionLeaseMs });
    this.#deals.set("tenant_demo:d1", { id: "d1", name: "Acme renewal", stage: "Proposal", version: 1 });
  }
  async health() { return { ready: true, provider: "memory" }; }
  enqueueMessageJob(input) { return this.#messageJobs.enqueueMessageJob(input); }
  claimMessageJobs(input) { return this.#messageJobs.claimMessageJobs(input); }
  getMessageJob(input) { return this.#messageJobs.getMessageJob(input); }
  messageJobTransitions(input) { return this.#messageJobs.messageJobTransitions(input); }
  completeMessageJob(input) { return this.#messageJobs.completeMessageJob(input); }
  failMessageJob(input) { return this.#messageJobs.failMessageJob(input); }
  releaseMessageJob(input) { return this.#messageJobs.releaseMessageJob(input); }
  messageJobStats(input) { return this.#messageJobs.messageJobStats(input); }
  claimEventDelivery(input) { return this.#messageJobs.claimEventDelivery(input); }
  completeEventDelivery(input) { return this.#messageJobs.completeEventDelivery(input); }
  releaseEventDelivery(input) { return this.#messageJobs.releaseEventDelivery(input); }
  replay(key) { const entry = this.#idempotency.get(key); return entry ? { ...entry, result: structuredClone(entry.result) } : undefined; }
  replayTts(key, fingerprint) { const previous = this.#tts.get(key); if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error("idempotency key was reused with a different TTS request"), { code: "IDEMPOTENCY_CONFLICT" }); return previous ? structuredClone(previous.result) : undefined; }
  recordTts(key, fingerprint, result, { tenant_id, actor_id, request_id, object_key } = {}) {
    const previous = this.#tts.get(key);
    if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error("idempotency key was reused with a different TTS request"), { code: "IDEMPOTENCY_CONFLICT" });
    if (previous) return structuredClone(previous.result);
    const asset = structuredClone(result);
    const event = tenant_id ? this.#event("tts.asset.created.v1", tenant_id, `asset/${asset.asset_id}`, { actor_id, request_id: request_id ?? "unknown", asset: { asset_id: asset.asset_id, mime_type: asset.mime_type, status: asset.status } }) : undefined;
    const audit = tenant_id ? { audit_id: randomUUID(), tenant_id, actor_id, request_id, action: "tts.asset.created", resource: { type: "asset", id: asset.asset_id }, decision: "committed", created_at: now() } : undefined;
    // Asset, idempotency record, audit and outbox event are one logical commit.
    this.#tts.set(key, { fingerprint, result: asset });
    if (tenant_id) { this.recordAsset({ tenant_id, actor_id, request_id, asset, object_key }); this.#events.push(event); this.#outbox.push(event); this.#audits.push(audit); }
    return structuredClone(asset);
  }
  recordAsset({ tenant_id, request_id, asset, object_key }) {
    if (!tenant_id || !asset?.asset_id) return;
    this.#assets.set(`${tenant_id}:${asset.asset_id}`, { tenant_id, request_id, asset: structuredClone(asset) });
    if (object_key) this.#assetObjects.set(`${tenant_id}:${asset.asset_id}`, object_key);
  }
  assetFor(tenant_id, asset_id) {
    const entry = this.#assets.get(`${tenant_id}:${asset_id}`);
    return entry ? structuredClone(entry.asset) : undefined;
  }
  objectKeyFor(tenant_id, asset_id) { return this.#assetObjects.get(`${tenant_id}:${asset_id}`); }
  beginInteraction({ tenant_id, actor_id, request_id, idempotency_key, request_fingerprint, input_type, input_payload }) {
    const key = `${tenant_id}:${idempotency_key}`;
    const previous = this.#interactions.get(key);
    if (previous) {
      if (previous.request_fingerprint !== request_fingerprint) throw Object.assign(new Error("idempotency key was reused with a different request"), { code: "IDEMPOTENCY_CONFLICT" });
      if (previous.status === "completed" || previous.status === "needs_review") return { replay: true, response: structuredClone(previous.response), http_status: previous.http_status };
      if (previous.status === "failed") throw Object.assign(new Error(previous.error_message), { code: previous.error_code });
      if (previous.status === "processing" && previous.lease_expires_at <= this.clock()) {
        const previousRequestId = previous.request_id;
        Object.assign(previous, {
          actor_id,
          request_id,
          input_type,
          input_payload: structuredClone(input_payload),
          status: "processing",
          provider_invocations: [],
          model_versions: {},
          latency_ms: {},
          lease_owner: request_id,
          lease_expires_at: this.clock() + this.interactionLeaseMs,
          recovery_count: (previous.recovery_count ?? 0) + 1,
        });
        for (const field of ["transcript", "understanding", "response", "error_code", "error_message", "http_status", "completed_at", "input_asset_id"]) delete previous[field];
        this.#appendInteractionWal(previous, "recovered", {
          previous_request_id_hash: sha256(previousRequestId),
          recovery_count: previous.recovery_count,
        });
        return { replay: false, recovered: true };
      }
      throw Object.assign(new Error("interaction with this idempotency key is still processing"), { code: "CRM_CONFLICT" });
    }
    const interaction = { tenant_id, actor_id, request_id, idempotency_key, request_fingerprint, input_type, input_payload: structuredClone(input_payload), status: "processing", provider_invocations: [], model_versions: {}, latency_ms: {}, lease_owner: request_id, lease_expires_at: this.clock() + this.interactionLeaseMs, recovery_count: 0, created_at: now() };
    this.#interactions.set(key, interaction);
    this.#appendInteractionWal(interaction, "started", { input_type, idempotency_key_hash: sha256(idempotency_key) });
    return { replay: false };
  }
  checkpointInteraction({ tenant_id, request_id, idempotency_key, transcript, understanding, provider_invocations, model_versions, latency_ms, input_asset_id }) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (!row) throw new Error("interaction was not started");
    if (row.status !== "processing" || row.lease_owner !== request_id || row.lease_expires_at <= this.clock()) {
      throw Object.assign(new Error("interaction checkpoint lease was lost"), { code: "CRM_CONFLICT" });
    }
    if (transcript !== undefined) row.transcript = structuredClone(transcript);
    if (understanding !== undefined) row.understanding = structuredClone(understanding);
    if (provider_invocations) row.provider_invocations.push(...structuredClone(provider_invocations));
    if (model_versions) row.model_versions = { ...row.model_versions, ...model_versions };
    if (latency_ms) row.latency_ms = { ...row.latency_ms, ...latency_ms };
    if (input_asset_id) row.input_asset_id = input_asset_id;
    row.lease_expires_at = this.clock() + this.interactionLeaseMs;
    this.#appendInteractionWal(row, "checkpointed", {
      transcript: transcript !== undefined,
      understanding: understanding !== undefined,
      provider_operations: (provider_invocations ?? []).map(({ operation, status }) => ({ operation, status })),
      input_asset: Boolean(input_asset_id),
    });
  }
  completeInteraction({ tenant_id, request_id, idempotency_key, response, http_status }) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (!row) throw new Error("interaction was not started");
    if (row.status !== "processing" || row.lease_owner !== request_id || row.lease_expires_at <= this.clock()) throw Object.assign(new Error("interaction completion lease was lost"), { code: "CRM_CONFLICT" });
    row.status = response.status === "needs_review" ? "needs_review" : "completed";
    row.response = structuredClone(response); row.http_status = http_status; row.completed_at = now(); row.lease_owner = undefined; row.lease_expires_at = undefined;
    this.#appendInteractionWal(row, "completed", { status: row.status, http_status });
  }
  failInteraction({ tenant_id, request_id, idempotency_key, error_code, error_message, http_status }) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (!row || row.status !== "processing" || row.lease_owner !== request_id || row.lease_expires_at <= this.clock()) return;
    Object.assign(row, { status: "failed", error_code, error_message, http_status, completed_at: now(), lease_owner: undefined, lease_expires_at: undefined });
    this.#appendInteractionWal(row, "failed", { error_code, http_status });
  }
  abandonInteraction({ tenant_id, request_id, idempotency_key }) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (!row || row.status !== "processing" || row.lease_owner !== request_id || row.lease_expires_at <= this.clock()) {
      return { released: false };
    }
    row.lease_expires_at = this.clock();
    this.#appendInteractionWal(row, "abandoned", { reason: "request_cancelled" });
    return { released: true };
  }
  interactionFor(tenant_id, idempotency_key) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    return row ? structuredClone(row) : undefined;
  }
  interactionWal(tenant_id, idempotency_key) {
    return structuredClone(this.#interactionWal.filter((entry) => entry.tenant_id === tenant_id && entry.idempotency_key === idempotency_key));
  }
  recordInputAsset({ tenant_id, actor_id, request_id, idempotency_key, asset, object_key, byte_length, sha256: assetSha256 }) {
    const interaction = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (interaction && (interaction.lease_owner !== request_id || interaction.lease_expires_at <= this.clock())) {
      throw Object.assign(new Error("input asset interaction lease was lost"), { code: "CRM_CONFLICT" });
    }
    this.recordAsset({ tenant_id, actor_id, request_id, asset: { ...asset, url: `/v1/assets/${asset.asset_id}` }, object_key });
    if (interaction) {
      interaction.input_asset_id = asset.asset_id;
      interaction.lease_expires_at = this.clock() + this.interactionLeaseMs;
    }
    return { asset_id: asset.asset_id, object_key, byte_length, sha256: assetSha256 };
  }
  initializeConversationState({ tenant_id, actor_id, conversation_id, state }) {
    const key = `${tenant_id}:${conversation_id}`;
    const previous = this.#conversations.get(key);
    if (previous) return { created: false, conversation_id, revision: previous.revision, state: structuredClone(previous.state) };
    const conversation = { tenant_id, actor_id, conversation_id, revision: 0, state: structuredClone(state), updated_at: now() };
    this.#conversations.set(key, conversation);
    return { created: true, conversation_id, revision: 0, state: structuredClone(state) };
  }
  conversationState({ tenant_id, conversation_id }) {
    const row = this.#conversations.get(`${tenant_id}:${conversation_id}`);
    return row ? { conversation_id, revision: row.revision, state: structuredClone(row.state) } : undefined;
  }
  replaceConversationStateIfCurrent({ tenant_id, actor_id, conversation_id, expected_revision, state }) {
    const row = this.#conversations.get(`${tenant_id}:${conversation_id}`);
    if (!row || row.revision !== expected_revision) return { replaced: false };
    row.actor_id = actor_id;
    row.state = structuredClone(state);
    row.revision += 1;
    row.updated_at = now();
    return { replaced: true, conversation_id, revision: row.revision };
  }
  execute({ tenant_id, actor_id, idempotency_key, intent, entities, request_id, request_fingerprint }) {
    const fingerprint = request_fingerprint ?? sha256(JSON.stringify({ intent, entities }));
    const replayKey = `${tenant_id}:${idempotency_key}`;
    const previous = this.replay(replayKey); if (previous) {
      if (previous.fingerprint !== fingerprint) throw Object.assign(new Error("idempotency key was reused with a different request"), { code: "IDEMPOTENCY_CONFLICT" });
      return previous.result;
    }
    if (intent === "crm.deal.update_stage") {
      const deal = this.#deals.get(`${tenant_id}:${entities.deal?.value}`);
      if (!deal) throw Object.assign(new Error("deal not found"), { code: "CRM_CONFLICT" });
      const before = { ...deal };
      deal.stage = entities.stage?.value ?? deal.stage; deal.version += 1;
      const result = { action: "updated", resource: { type: "deal", id: deal.id }, aggregate_version: deal.version };
      try { this.#commit(tenant_id, actor_id, idempotency_key, intent, request_id, result, fingerprint); } catch (error) { Object.assign(deal, before); throw error; }
      return structuredClone(result);
    }
    if (intent === "crm.customer.create") {
      const id = `cus_${randomUUID().slice(0, 8)}`;
      const customer = { id, name: entities.customer?.name ?? "Unknown", version: 1 };
      this.#customers.set(`${tenant_id}:${id}`, customer);
      const result = { action: "created", resource: { type: "customer", id }, aggregate_version: 1 };
      try { this.#commit(tenant_id, actor_id, idempotency_key, intent, request_id, result, fingerprint); } catch (error) { this.#customers.delete(`${tenant_id}:${id}`); throw error; }
      return structuredClone(result);
    }
    return { action: "read_only", resource: null, aggregate_version: 0 };
  }
  createReview({ tenant_id, actor_id, request_id, idempotency_key, request_fingerprint, understanding }) {
    const key = idempotency_key ? `${tenant_id}:${idempotency_key}` : undefined;
    if (key) {
      const previous = this.#reviewIdempotency.get(key);
      if (previous) {
        if (previous.fingerprint !== request_fingerprint) throw Object.assign(new Error("idempotency key was reused with a different request"), { code: "IDEMPOTENCY_CONFLICT" });
        return structuredClone(previous.result);
      }
    }
    const id = `rev_${randomUUID().slice(0, 8)}`; const task = { id, tenant_id, request_id, reason: "low_confidence", status: "open", candidates: understanding.entities, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
    const event = this.#event("crm.review.requested.v1", tenant_id, `review/${id}`, { ...task, request_id });
    const audit = { audit_id: randomUUID(), tenant_id, actor_id, request_id, action: "crm.review.requested", resource: { type: "review", id }, decision: "needs_review", created_at: now() };
    this.#reviews.set(id, task); this.#events.push(event); this.#outbox.push(event); this.#audits.push(audit);
    if (key) this.#reviewIdempotency.set(key, { fingerprint: request_fingerprint, result: structuredClone(task) });
    return structuredClone(task);
  }
  events() { return structuredClone(this.#events); }
  audits() { return structuredClone(this.#audits); }
  outbox() { return structuredClone(this.#outbox); }
  #appendInteractionWal(row, entry_type, payload) {
    const sequence = this.#interactionWal.filter((entry) => entry.tenant_id === row.tenant_id && entry.idempotency_key === row.idempotency_key).length + 1;
    this.#interactionWal.push({
      tenant_id: row.tenant_id,
      idempotency_key: row.idempotency_key,
      request_id: row.request_id,
      sequence,
      entry_type,
      payload: structuredClone(payload),
      created_at: now(),
    });
  }
  #commit(tenant_id, actor_id, key, intent, request_id, result, fingerprint) {
    const event = this.#event("crm.command.committed.v1", tenant_id, `${result.resource?.type ?? "command"}/${result.resource?.id ?? key}`, { actor_id, intent, result, aggregate_version: result.aggregate_version, request_id });
    const audit = { audit_id: randomUUID(), tenant_id, actor_id, request_id, action: intent, resource: result.resource, decision: "committed", created_at: now() };
    // Construct and validate all records before publishing any of them. This
    // models the database transaction + transactional outbox boundary: a
    // failed audit/event/idempotency write cannot leave a partial mutation.
    const entry = { fingerprint, result: structuredClone(result) };
    this.#events.push(event); this.#outbox.push(event); this.#audits.push(audit); this.#idempotency.set(`${tenant_id}:${key}`, entry);
  }
  #event(type, tenant_id, subject, data) { return validateEvent({ specversion: "1.0", id: `evt_${randomUUID()}`, type, source: "urn:sumi:voice-crm/crm", subject, time: now(), datacontenttype: "application/json", tenant_id, request_id: data.request_id ?? "unknown", data }); }
}
