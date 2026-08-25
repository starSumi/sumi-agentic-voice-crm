// Persistence adapter migration boundary: protocol and transaction behavior
// remain covered by the existing contract/PG tests while the public surface
// is moved to TypeScript. The SQL-shaped records are typed in the next pass.
import { randomUUID } from "node:crypto";
import { now, sha256 } from "./contracts.ts";
import { validateEvent } from "./protocol-validation.ts";
import {
  createMemoryMessageJobQueue,
  type MessageJobQueue,
} from "./message-job-queue.ts";
import { paginateEvents, type EventPageInput } from "./event-pagination.ts";
import {
  agentCrmIntentDefinition,
  assertAgentCrmActionProposal,
  assertExecutableAgentCrmEntities,
} from "./agent-crm-contract.ts";

type Clock = () => number;
type DataRecord = Record<string, unknown>;
type QueueInput<K extends keyof MessageJobQueue> = Parameters<
  MessageJobQueue[K]
>[0];
type Entity = {
  value?: string;
  name?: string;
  expected_version?: number;
  confidence?: number;
  [key: string]: unknown;
};
export type CrmEntities = Record<string, Entity | undefined>;
export type CrmActionProposal = DataRecord & { intent: string };
export type CrmUnderstanding = DataRecord & {
  intent: string;
  entities: CrmEntities;
};
export type StoredAsset = DataRecord & {
  asset_id: string;
  mime_type: string;
  status: string;
  url?: string;
};
type AssetRecord = {
  tenant_id: string;
  request_id?: string;
  asset: StoredAsset;
};
type IdempotencyEntry<T> = { fingerprint: string; result: T };
export type CrmCommandResult = {
  action: string;
  resource: { type: string; id: string } | null;
  aggregate_version: number;
};
type InteractionStatus = "processing" | "completed" | "needs_review" | "failed";
type ProviderInvocation = DataRecord & { operation: string; status?: string };
export type InteractionRecord = {
  tenant_id: string;
  actor_id?: string;
  request_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  input_type: string;
  input_payload: unknown;
  status: InteractionStatus;
  provider_invocations: ProviderInvocation[];
  model_versions: Record<string, unknown>;
  latency_ms: Record<string, unknown>;
  lease_owner?: string;
  lease_expires_at?: number;
  recovery_count: number;
  created_at: string;
  transcript?: unknown;
  understanding?: unknown;
  response?: DataRecord;
  error_code?: string;
  error_message?: string;
  http_status?: number;
  completed_at?: string;
  input_asset_id?: string;
};
type InteractionWalEntry = {
  tenant_id: string;
  idempotency_key: string;
  request_id: string;
  sequence: number;
  entry_type: string;
  payload: unknown;
  created_at: string;
};
type ConversationRecord = {
  tenant_id: string;
  actor_id?: string;
  conversation_id: string;
  revision: number;
  state: unknown;
  updated_at: string;
};
type EventEnvelope = DataRecord & {
  id: string;
  type: string;
  tenant_id: string;
  request_id: string;
  data: DataRecord;
};
type AuditRecord = {
  audit_id: string;
  tenant_id: string;
  actor_id?: string;
  request_id?: string;
  action: string;
  resource: { type: string; id: string } | null;
  decision: string;
  created_at: string;
  business_action?: CrmActionProposal;
};
type ReviewTask = {
  id: string;
  tenant_id: string;
  request_id: string;
  reason: string;
  status: string;
  candidates: CrmEntities;
  expires_at: string;
};
type Deal = { id: string; name: string; stage: string; version: number };
type Customer = { id: string; name: string; version: number };
type StoreOptions = { clock?: Clock; interactionLeaseMs?: number };
type TtsContext = {
  tenant_id?: string;
  actor_id?: string;
  request_id?: string;
  object_key?: string;
};
type RecordAssetInput = TtsContext & {
  tenant_id?: string;
  asset: StoredAsset;
};
export type BeginInteractionInput = {
  tenant_id: string;
  actor_id?: string;
  request_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  input_type: string;
  input_payload: unknown;
};
export type CheckpointInteractionInput = Pick<
  BeginInteractionInput,
  "tenant_id" | "request_id" | "idempotency_key"
> & {
  transcript?: unknown;
  understanding?: unknown;
  provider_invocations?: ProviderInvocation[];
  model_versions?: Record<string, unknown>;
  latency_ms?: Record<string, unknown>;
  input_asset_id?: string;
};
export type CompleteInteractionInput = Pick<
  BeginInteractionInput,
  "tenant_id" | "request_id" | "idempotency_key"
> & { response: DataRecord; http_status: number };
export type FailInteractionInput = Pick<
  BeginInteractionInput,
  "tenant_id" | "request_id" | "idempotency_key"
> & { error_code: string; error_message: string; http_status: number };
export type AbandonInteractionInput = Pick<
  BeginInteractionInput,
  "tenant_id" | "request_id" | "idempotency_key"
>;
export type RecordInputAssetInput = Pick<
  BeginInteractionInput,
  "tenant_id" | "actor_id" | "request_id" | "idempotency_key"
> & {
  asset: StoredAsset;
  object_key: string;
  byte_length: number;
  sha256: string;
};
export type ConversationIdentity = {
  tenant_id: string;
  actor_id?: string;
  conversation_id: string;
};
export type InitializeConversationInput = ConversationIdentity & {
  state: unknown;
};
export type ReplaceConversationInput = InitializeConversationInput & {
  expected_revision: number;
};
export type ExecuteCrmInput = {
  tenant_id: string;
  actor_id?: string;
  idempotency_key: string;
  intent: string;
  entities: CrmEntities;
  request_id?: string;
  request_fingerprint?: string;
  action?: CrmActionProposal;
};
export type CreateReviewInput = {
  tenant_id: string;
  actor_id?: string;
  request_id: string;
  idempotency_key?: string;
  request_fingerprint: string;
  understanding: CrmUnderstanding;
  action?: CrmActionProposal;
};

export class CrmStore {
  readonly clock: Clock;
  readonly interactionLeaseMs: number;
  #idempotency = new Map<string, IdempotencyEntry<CrmCommandResult>>();
  #tts = new Map<string, IdempotencyEntry<StoredAsset>>();
  #assets = new Map<string, AssetRecord>();
  #assetObjects = new Map<string, string>();
  #interactions = new Map<string, InteractionRecord>();
  #interactionWal: InteractionWalEntry[] = [];
  #conversations = new Map<string, ConversationRecord>();
  #events: EventEnvelope[] = [];
  #audits: AuditRecord[] = [];
  #outbox: EventEnvelope[] = [];
  #reviews = new Map<string, ReviewTask>();
  #reviewIdempotency = new Map<string, IdempotencyEntry<ReviewTask>>();
  #deals = new Map<string, Deal>();
  #customers = new Map<string, Customer>();
  #messageJobs: MessageJobQueue;
  constructor({
    clock = () => Date.now(),
    interactionLeaseMs = 30_000,
  }: StoreOptions = {}) {
    if (!Number.isSafeInteger(interactionLeaseMs) || interactionLeaseMs <= 0)
      throw new TypeError("interactionLeaseMs must be a positive integer");
    this.clock = clock;
    this.interactionLeaseMs = interactionLeaseMs;
    this.#messageJobs = createMemoryMessageJobQueue({
      clock,
      leaseMs: interactionLeaseMs,
    });
    this.#deals.set("tenant_demo:d1", {
      id: "d1",
      name: "Acme renewal",
      stage: "Proposal",
      version: 1,
    });
  }
  async health() {
    return { ready: true, provider: "memory" };
  }
  enqueueMessageJob(input: QueueInput<"enqueueMessageJob">) {
    return this.#messageJobs.enqueueMessageJob(input);
  }
  claimMessageJobs(input: QueueInput<"claimMessageJobs">) {
    return this.#messageJobs.claimMessageJobs(input);
  }
  getMessageJob(input: QueueInput<"getMessageJob">) {
    return this.#messageJobs.getMessageJob(input);
  }
  messageJobTransitions(input: QueueInput<"messageJobTransitions">) {
    return this.#messageJobs.messageJobTransitions(input);
  }
  completeMessageJob(input: QueueInput<"completeMessageJob">) {
    return this.#messageJobs.completeMessageJob(input);
  }
  renewMessageJobLease(input: QueueInput<"renewMessageJobLease">) {
    return this.#messageJobs.renewMessageJobLease(input);
  }
  failMessageJob(input: QueueInput<"failMessageJob">) {
    return this.#messageJobs.failMessageJob(input);
  }
  releaseMessageJob(input: QueueInput<"releaseMessageJob">) {
    return this.#messageJobs.releaseMessageJob(input);
  }
  messageJobStats(input?: QueueInput<"messageJobStats">) {
    return this.#messageJobs.messageJobStats(input);
  }
  claimEventDelivery(input: QueueInput<"claimEventDelivery">) {
    return this.#messageJobs.claimEventDelivery(input);
  }
  completeEventDelivery(input: QueueInput<"completeEventDelivery">) {
    return this.#messageJobs.completeEventDelivery(input);
  }
  releaseEventDelivery(input: QueueInput<"releaseEventDelivery">) {
    return this.#messageJobs.releaseEventDelivery(input);
  }
  replay(key: string) {
    const entry = this.#idempotency.get(key);
    return entry
      ? { ...entry, result: structuredClone(entry.result) }
      : undefined;
  }
  replayTts(key: string, fingerprint: string) {
    const previous = this.#tts.get(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw Object.assign(
        new Error("idempotency key was reused with a different TTS request"),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
    return previous ? structuredClone(previous.result) : undefined;
  }
  recordTts(
    key: string,
    fingerprint: string,
    result: StoredAsset,
    { tenant_id, actor_id, request_id, object_key }: TtsContext = {},
  ) {
    const previous = this.#tts.get(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw Object.assign(
        new Error("idempotency key was reused with a different TTS request"),
        { code: "IDEMPOTENCY_CONFLICT" },
      );
    if (previous) return structuredClone(previous.result);
    const asset = structuredClone(result);
    // Asset, idempotency record, audit and outbox event are one logical commit.
    this.#tts.set(key, { fingerprint, result: asset });
    if (tenant_id) {
      const event = this.#event(
        "tts.asset.created.v1",
        tenant_id,
        `asset/${asset.asset_id}`,
        {
          actor_id,
          request_id: request_id ?? "unknown",
          asset: {
            asset_id: asset.asset_id,
            mime_type: asset.mime_type,
            status: asset.status,
          },
        },
      );
      const audit: AuditRecord = {
        audit_id: randomUUID(),
        tenant_id,
        actor_id,
        request_id,
        action: "tts.asset.created",
        resource: { type: "asset", id: asset.asset_id },
        decision: "committed",
        created_at: now(),
      };
      this.recordAsset({ tenant_id, actor_id, request_id, asset, object_key });
      this.#events.push(event);
      this.#outbox.push(event);
      this.#audits.push(audit);
    }
    return structuredClone(asset);
  }
  recordAsset({ tenant_id, request_id, asset, object_key }: RecordAssetInput) {
    if (!tenant_id || !asset?.asset_id) return;
    this.#assets.set(`${tenant_id}:${asset.asset_id}`, {
      tenant_id,
      request_id,
      asset: structuredClone(asset),
    });
    if (object_key)
      this.#assetObjects.set(`${tenant_id}:${asset.asset_id}`, object_key);
  }
  assetFor(tenant_id: string, asset_id: string) {
    const entry = this.#assets.get(`${tenant_id}:${asset_id}`);
    return entry ? structuredClone(entry.asset) : undefined;
  }
  objectKeyFor(tenant_id: string, asset_id: string) {
    return this.#assetObjects.get(`${tenant_id}:${asset_id}`);
  }
  beginInteraction({
    tenant_id,
    actor_id,
    request_id,
    idempotency_key,
    request_fingerprint,
    input_type,
    input_payload,
  }: BeginInteractionInput) {
    const key = `${tenant_id}:${idempotency_key}`;
    const previous = this.#interactions.get(key);
    if (previous) {
      if (previous.request_fingerprint !== request_fingerprint)
        throw Object.assign(
          new Error("idempotency key was reused with a different request"),
          { code: "IDEMPOTENCY_CONFLICT" },
        );
      if (previous.status === "completed" || previous.status === "needs_review")
        return {
          replay: true,
          response: structuredClone(previous.response),
          http_status: previous.http_status,
        };
      if (previous.status === "failed")
        throw Object.assign(new Error(previous.error_message), {
          code: previous.error_code,
        });
      if (
        previous.status === "processing" &&
        (previous.lease_expires_at ?? 0) <= this.clock()
      ) {
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
        for (const field of [
          "transcript",
          "understanding",
          "response",
          "error_code",
          "error_message",
          "http_status",
          "completed_at",
          "input_asset_id",
        ] as const)
          delete previous[field];
        this.#appendInteractionWal(previous, "recovered", {
          previous_request_id_hash: sha256(previousRequestId),
          recovery_count: previous.recovery_count,
        });
        return { replay: false, recovered: true };
      }
      throw Object.assign(
        new Error("interaction with this idempotency key is still processing"),
        { code: "CRM_CONFLICT" },
      );
    }
    const interaction: InteractionRecord = {
      tenant_id,
      actor_id,
      request_id,
      idempotency_key,
      request_fingerprint,
      input_type,
      input_payload: structuredClone(input_payload),
      status: "processing",
      provider_invocations: [],
      model_versions: {},
      latency_ms: {},
      lease_owner: request_id,
      lease_expires_at: this.clock() + this.interactionLeaseMs,
      recovery_count: 0,
      created_at: now(),
    };
    this.#interactions.set(key, interaction);
    this.#appendInteractionWal(interaction, "started", {
      input_type,
      idempotency_key_hash: sha256(idempotency_key),
    });
    return { replay: false };
  }
  checkpointInteraction({
    tenant_id,
    request_id,
    idempotency_key,
    transcript,
    understanding,
    provider_invocations,
    model_versions,
    latency_ms,
    input_asset_id,
  }: CheckpointInteractionInput) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (!row) throw new Error("interaction was not started");
    if (
      row.status !== "processing" ||
      row.lease_owner !== request_id ||
      (row.lease_expires_at ?? 0) <= this.clock()
    ) {
      throw Object.assign(new Error("interaction checkpoint lease was lost"), {
        code: "CRM_CONFLICT",
      });
    }
    if (transcript !== undefined) row.transcript = structuredClone(transcript);
    if (understanding !== undefined)
      row.understanding = structuredClone(understanding);
    if (provider_invocations)
      row.provider_invocations.push(...structuredClone(provider_invocations));
    if (model_versions)
      row.model_versions = { ...row.model_versions, ...model_versions };
    if (latency_ms) row.latency_ms = { ...row.latency_ms, ...latency_ms };
    if (input_asset_id) row.input_asset_id = input_asset_id;
    row.lease_expires_at = this.clock() + this.interactionLeaseMs;
    this.#appendInteractionWal(row, "checkpointed", {
      transcript: transcript !== undefined,
      understanding: understanding !== undefined,
      provider_operations: (provider_invocations ?? []).map(
        ({ operation, status }) => ({ operation, status }),
      ),
      input_asset: Boolean(input_asset_id),
    });
  }
  completeInteraction({
    tenant_id,
    request_id,
    idempotency_key,
    response,
    http_status,
  }: CompleteInteractionInput) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (!row) throw new Error("interaction was not started");
    if (
      row.status !== "processing" ||
      row.lease_owner !== request_id ||
      (row.lease_expires_at ?? 0) <= this.clock()
    )
      throw Object.assign(new Error("interaction completion lease was lost"), {
        code: "CRM_CONFLICT",
      });
    row.status =
      response.status === "needs_review" ? "needs_review" : "completed";
    row.response = structuredClone(response);
    row.http_status = http_status;
    row.completed_at = now();
    row.lease_owner = undefined;
    row.lease_expires_at = undefined;
    this.#appendInteractionWal(row, "completed", {
      status: row.status,
      http_status,
    });
  }
  failInteraction({
    tenant_id,
    request_id,
    idempotency_key,
    error_code,
    error_message,
    http_status,
  }: FailInteractionInput) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (
      !row ||
      row.status !== "processing" ||
      row.lease_owner !== request_id ||
      (row.lease_expires_at ?? 0) <= this.clock()
    )
      return;
    Object.assign(row, {
      status: "failed",
      error_code,
      error_message,
      http_status,
      completed_at: now(),
      lease_owner: undefined,
      lease_expires_at: undefined,
    });
    this.#appendInteractionWal(row, "failed", { error_code, http_status });
  }
  abandonInteraction({
    tenant_id,
    request_id,
    idempotency_key,
  }: AbandonInteractionInput) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    if (
      !row ||
      row.status !== "processing" ||
      row.lease_owner !== request_id ||
      (row.lease_expires_at ?? 0) <= this.clock()
    ) {
      return { released: false };
    }
    row.lease_expires_at = this.clock();
    this.#appendInteractionWal(row, "abandoned", {
      reason: "request_cancelled",
    });
    return { released: true };
  }
  interactionFor(tenant_id: string, idempotency_key: string) {
    const row = this.#interactions.get(`${tenant_id}:${idempotency_key}`);
    return row ? structuredClone(row) : undefined;
  }
  interactionWal(tenant_id: string, idempotency_key: string) {
    return structuredClone(
      this.#interactionWal.filter(
        (entry) =>
          entry.tenant_id === tenant_id &&
          entry.idempotency_key === idempotency_key,
      ),
    );
  }
  recordInputAsset({
    tenant_id,
    actor_id,
    request_id,
    idempotency_key,
    asset,
    object_key,
    byte_length,
    sha256: assetSha256,
  }: RecordInputAssetInput) {
    const interaction = this.#interactions.get(
      `${tenant_id}:${idempotency_key}`,
    );
    if (
      interaction &&
      (interaction.lease_owner !== request_id ||
        (interaction.lease_expires_at ?? 0) <= this.clock())
    ) {
      throw Object.assign(new Error("input asset interaction lease was lost"), {
        code: "CRM_CONFLICT",
      });
    }
    this.recordAsset({
      tenant_id,
      actor_id,
      request_id,
      asset: { ...asset, url: `/v1/assets/${asset.asset_id}` },
      object_key,
    });
    if (interaction) {
      interaction.input_asset_id = asset.asset_id;
      interaction.lease_expires_at = this.clock() + this.interactionLeaseMs;
    }
    return {
      asset_id: asset.asset_id,
      object_key,
      byte_length,
      sha256: assetSha256,
    };
  }
  initializeConversationState({
    tenant_id,
    actor_id,
    conversation_id,
    state,
  }: InitializeConversationInput) {
    const key = `${tenant_id}:${conversation_id}`;
    const previous = this.#conversations.get(key);
    if (previous)
      return {
        created: false,
        conversation_id,
        revision: previous.revision,
        state: structuredClone(previous.state),
      };
    const conversation = {
      tenant_id,
      actor_id,
      conversation_id,
      revision: 0,
      state: structuredClone(state),
      updated_at: now(),
    };
    this.#conversations.set(key, conversation);
    return {
      created: true,
      conversation_id,
      revision: 0,
      state: structuredClone(state),
    };
  }
  conversationState({ tenant_id, conversation_id }: ConversationIdentity) {
    const row = this.#conversations.get(`${tenant_id}:${conversation_id}`);
    return row
      ? {
          conversation_id,
          revision: row.revision,
          state: structuredClone(row.state),
        }
      : undefined;
  }
  replaceConversationStateIfCurrent({
    tenant_id,
    actor_id,
    conversation_id,
    expected_revision,
    state,
  }: ReplaceConversationInput) {
    const row = this.#conversations.get(`${tenant_id}:${conversation_id}`);
    if (!row || row.revision !== expected_revision) return { replaced: false };
    row.actor_id = actor_id;
    row.state = structuredClone(state);
    row.revision += 1;
    row.updated_at = now();
    return { replaced: true, conversation_id, revision: row.revision };
  }
  execute({
    tenant_id,
    actor_id,
    idempotency_key,
    intent,
    entities,
    request_id,
    request_fingerprint,
    action,
  }: ExecuteCrmInput) {
    const definition = agentCrmIntentDefinition(intent);
    if (definition.effect === "write")
      assertExecutableAgentCrmEntities(intent, entities);
    if (action !== undefined) {
      assertAgentCrmActionProposal(action);
      if (action.intent !== intent)
        throw Object.assign(
          new Error("CRM action intent does not match command intent"),
          { code: "INVALID_REQUEST" },
        );
    }
    const fingerprint =
      request_fingerprint ?? sha256(JSON.stringify({ intent, entities }));
    const replayKey = `${tenant_id}:${idempotency_key}`;
    const previous = this.replay(replayKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw Object.assign(
          new Error("idempotency key was reused with a different request"),
          { code: "IDEMPOTENCY_CONFLICT" },
        );
      return previous.result;
    }
    if (intent === "crm.deal.update_stage") {
      const deal = this.#deals.get(`${tenant_id}:${entities.deal?.value}`);
      if (!deal)
        throw Object.assign(new Error("deal not found"), {
          code: "CRM_CONFLICT",
        });
      const before = { ...deal };
      deal.stage = entities.stage?.value ?? deal.stage;
      deal.version += 1;
      const result = {
        action: "updated",
        resource: { type: "deal", id: deal.id },
        aggregate_version: deal.version,
      };
      try {
        this.#commit(
          tenant_id,
          actor_id,
          idempotency_key,
          intent,
          request_id,
          result,
          fingerprint,
          action,
        );
      } catch (error) {
        Object.assign(deal, before);
        throw error;
      }
      return structuredClone(result);
    }
    if (intent === "crm.customer.create") {
      const id = `cus_${randomUUID().slice(0, 8)}`;
      const customer = {
        id,
        name: entities.customer?.name ?? "Unknown",
        version: 1,
      };
      this.#customers.set(`${tenant_id}:${id}`, customer);
      const result = {
        action: "created",
        resource: { type: "customer", id },
        aggregate_version: 1,
      };
      try {
        this.#commit(
          tenant_id,
          actor_id,
          idempotency_key,
          intent,
          request_id,
          result,
          fingerprint,
          action,
        );
      } catch (error) {
        this.#customers.delete(`${tenant_id}:${id}`);
        throw error;
      }
      return structuredClone(result);
    }
    if (intent === "crm.search")
      return { action: "read_only", resource: null, aggregate_version: 0 };
    throw Object.assign(new Error("CRM intent has no execution handler"), {
      code: "INVALID_REQUEST",
    });
  }
  createReview({
    tenant_id,
    actor_id,
    request_id,
    idempotency_key,
    request_fingerprint,
    understanding,
    action,
  }: CreateReviewInput) {
    agentCrmIntentDefinition(understanding.intent);
    if (action !== undefined) {
      assertAgentCrmActionProposal(action);
      if (action.intent !== understanding.intent)
        throw Object.assign(
          new Error("CRM action intent does not match review intent"),
          { code: "INVALID_REQUEST" },
        );
    }
    const key = idempotency_key ? `${tenant_id}:${idempotency_key}` : undefined;
    if (key) {
      const previous = this.#reviewIdempotency.get(key);
      if (previous) {
        if (previous.fingerprint !== request_fingerprint)
          throw Object.assign(
            new Error("idempotency key was reused with a different request"),
            { code: "IDEMPOTENCY_CONFLICT" },
          );
        return structuredClone(previous.result);
      }
    }
    const id = `rev_${randomUUID().slice(0, 8)}`;
    const task = {
      id,
      tenant_id,
      request_id,
      reason: "low_confidence",
      status: "open",
      candidates: understanding.entities,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    const event = this.#event(
      "crm.review.requested.v1",
      tenant_id,
      `review/${id}`,
      { ...task, request_id, action },
    );
    const audit = {
      audit_id: randomUUID(),
      tenant_id,
      actor_id,
      request_id,
      action: "crm.review.requested",
      resource: { type: "review", id },
      decision: "needs_review",
      created_at: now(),
      business_action: action,
    };
    this.#reviews.set(id, task);
    this.#events.push(event);
    this.#outbox.push(event);
    this.#audits.push(audit);
    if (key)
      this.#reviewIdempotency.set(key, {
        fingerprint: request_fingerprint,
        result: structuredClone(task),
      });
    return structuredClone(task);
  }
  events() {
    return structuredClone(this.#events);
  }
  eventPage(
    tenantId: string,
    _actorId?: string,
    input: EventPageInput = {},
  ) {
    return paginateEvents(
      this.#events.filter((event) => event.tenant_id === tenantId),
      input,
    );
  }
  audits() {
    return structuredClone(this.#audits);
  }
  outbox() {
    return structuredClone(this.#outbox);
  }
  #appendInteractionWal(
    row: InteractionRecord,
    entry_type: string,
    payload: unknown,
  ) {
    const sequence =
      this.#interactionWal.filter(
        (entry) =>
          entry.tenant_id === row.tenant_id &&
          entry.idempotency_key === row.idempotency_key,
      ).length + 1;
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
  #commit(
    tenant_id: string,
    actor_id: string | undefined,
    key: string,
    intent: string,
    request_id: string | undefined,
    result: CrmCommandResult,
    fingerprint: string,
    action: CrmActionProposal | undefined,
  ) {
    const event = this.#event(
      "crm.command.committed.v1",
      tenant_id,
      `${result.resource?.type ?? "command"}/${result.resource?.id ?? key}`,
      {
        actor_id,
        intent,
        action,
        result,
        aggregate_version: result.aggregate_version,
        request_id,
      },
    );
    const audit = {
      audit_id: randomUUID(),
      tenant_id,
      actor_id,
      request_id,
      action: intent,
      resource: result.resource,
      decision: "committed",
      created_at: now(),
      business_action: action,
    };
    // Construct and validate all records before publishing any of them. This
    // models the database transaction + transactional outbox boundary: a
    // failed audit/event/idempotency write cannot leave a partial mutation.
    const entry = { fingerprint, result: structuredClone(result) };
    this.#events.push(event);
    this.#outbox.push(event);
    this.#audits.push(audit);
    this.#idempotency.set(`${tenant_id}:${key}`, entry);
  }
  #event(
    type: string,
    tenant_id: string,
    subject: string,
    data: DataRecord,
  ): EventEnvelope {
    const event: EventEnvelope = {
      specversion: "1.0",
      id: `evt_${randomUUID()}`,
      type,
      source: "urn:sumi:voice-crm/crm",
      subject,
      time: now(),
      datacontenttype: "application/json",
      tenant_id,
      request_id:
        typeof data.request_id === "string" ? data.request_id : "unknown",
      data,
    };
    validateEvent(event);
    return event;
  }
}
