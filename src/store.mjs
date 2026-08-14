import { randomUUID } from "node:crypto";
import { now, sha256 } from "./contracts.mjs";

export class CrmStore {
  #idempotency = new Map(); #tts = new Map(); #events = []; #audits = []; #outbox = []; #reviews = new Map(); #deals = new Map(); #customers = new Map();
  constructor() { this.#deals.set("tenant_demo:d1", { id: "d1", name: "Acme renewal", stage: "Proposal", version: 1 }); }
  replay(key) { return this.#idempotency.get(key); }
  replayTts(key, fingerprint) { const previous = this.#tts.get(key); if (previous && previous.fingerprint !== fingerprint) throw Object.assign(new Error("idempotency key was reused with a different TTS request"), { code: "IDEMPOTENCY_CONFLICT" }); return previous?.result; }
  recordTts(key, fingerprint, result) { this.#tts.set(key, { fingerprint, result }); }
  execute({ tenant_id, actor_id, idempotency_key, intent, entities, request_id }) {
    const fingerprint = sha256(JSON.stringify({ intent, entities }));
    const replayKey = `${tenant_id}:${idempotency_key}`;
    const previous = this.replay(replayKey); if (previous) {
      if (previous.fingerprint !== fingerprint) throw Object.assign(new Error("idempotency key was reused with a different request"), { code: "IDEMPOTENCY_CONFLICT" });
      return previous.result;
    }
    if (intent === "crm.deal.update_stage") {
      const deal = this.#deals.get(`${tenant_id}:${entities.deal?.value}`);
      if (!deal) throw Object.assign(new Error("deal not found"), { code: "CRM_CONFLICT" });
      deal.stage = entities.stage?.value ?? deal.stage; deal.version += 1;
      const result = { action: "updated", resource: { type: "deal", id: deal.id }, aggregate_version: deal.version };
      this.#commit(tenant_id, actor_id, idempotency_key, intent, request_id, result, fingerprint); return result;
    }
    if (intent === "crm.customer.create") {
      const id = `cus_${randomUUID().slice(0, 8)}`;
      const customer = { id, name: entities.customer?.name ?? "Unknown", version: 1 };
      this.#customers.set(`${tenant_id}:${id}`, customer);
      const result = { action: "created", resource: { type: "customer", id }, aggregate_version: 1 };
      this.#commit(tenant_id, actor_id, idempotency_key, intent, request_id, result, fingerprint); return result;
    }
    return { action: "read_only", resource: null, aggregate_version: 0 };
  }
  createReview({ tenant_id, request_id, understanding }) {
    const id = `rev_${randomUUID().slice(0, 8)}`; const task = { id, tenant_id, request_id, reason: "low_confidence", status: "open", candidates: understanding.entities, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() };
    this.#reviews.set(id, task); this.#events.push(this.#event("crm.review.requested.v1", tenant_id, `review/${id}`, { ...task, request_id })); return task;
  }
  events() { return [...this.#events]; }
  audits() { return [...this.#audits]; }
  #commit(tenant_id, actor_id, key, intent, request_id, result, fingerprint) {
    const event = this.#event("crm.command.committed.v1", tenant_id, `${result.resource?.type ?? "command"}/${result.resource?.id ?? key}`, { actor_id, intent, result, aggregate_version: result.aggregate_version, request_id });
    this.#events.push(event); this.#outbox.push(event);
    this.#audits.push({ audit_id: randomUUID(), tenant_id, actor_id, request_id, action: intent, resource: result.resource, decision: "committed", created_at: now() });
    this.#idempotency.set(`${tenant_id}:${key}`, { fingerprint, result });
  }
  #event(type, tenant_id, subject, data) { return { specversion: "1.0", id: `evt_${randomUUID()}`, type, source: "urn:sumi:voice-crm/crm", subject, time: now(), datacontenttype: "application/json", tenant_id, request_id: data.request_id ?? "unknown", data }; }
}
