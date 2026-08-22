import { ERROR_CODES, sha256 } from "../contracts.ts";
import {
  assertAskCommand,
  assertRequestContext,
  assertReviewCommand,
  assertTtsCommand,
} from "./commands.ts";
import type { ApplicationRequestContext } from "./commands.ts";
import { normalizeUnderstanding } from "./mutation-policy.ts";
import { authorizationError } from "../authorization/errors.ts";
import { createAgentCrmActionProposal } from "../agent-crm-contract.ts";

const PROGRESS_SINK_KEYS = ["progressSink", "eventSink"];
const NOOP_PROGRESS_SINK = () => {};

/** Dynamic ports are an adapter boundary; protocol/domain values stay typed at callers. */
type AdapterRecord = Record<string, any>;
type ServicePorts = AdapterRecord;
type ServiceCommand = AdapterRecord;
type ProgressContext = ApplicationRequestContext & { readonly conversation_id?: string };
type ProgressSink = (event: AdapterRecord) => unknown | PromiseLike<unknown>;

function resolveProgressSink(ports: ServicePorts = {}): ProgressSink {
  for (const key of PROGRESS_SINK_KEYS) {
    const candidate = ports[key];
    if (typeof candidate === "function") return candidate;
    if (candidate && typeof candidate.emit === "function") {
      return candidate.emit.bind(candidate);
    }
  }
  return NOOP_PROGRESS_SINK;
}

function createServicePorts(ports: ServicePorts, defaults: ServicePorts = {}): ServicePorts {
  return Object.freeze({
    now: () => Date.now(),
    ...defaults,
    ...ports,
    progressSink: resolveProgressSink(ports),
  });
}

function opaque(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function finiteNumber(value: unknown, fallback?: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeResource(resource: unknown): string {
  if (typeof resource === "string" && resource.length > 0) return resource;
  if (!resource || typeof resource !== "object") return "none";
  const record = resource as AdapterRecord;
  const type = opaque(record.type, "resource");
  const id = opaque(record.id, "unknown");
  return `${type}/${id}`;
}

function jsonScalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function occurredAt(ports: ServicePorts): string {
  let timestamp;
  try {
    timestamp = ports.now?.();
  } catch {}
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof timestamp === "string") {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function progressEvent(context: ProgressContext, ports: ServicePorts, type: string, fields: AdapterRecord = {}, conversationId?: string): AdapterRecord {
  const event: AdapterRecord = {
    type,
    request_id: opaque(context?.request_id),
    tenant_id: opaque(context?.identity?.tenant_id),
    actor_id: opaque(context?.identity?.actor_id),
    occurred_at: occurredAt(ports),
  };
  const conversation = conversationId ?? context?.conversation_id;
  if (typeof conversation === "string" && conversation.length > 0) {
    event.conversation_id = conversation;
  }
  for (const [key, value] of Object.entries(fields)) {
    const scalar = jsonScalar(value);
    if (scalar !== undefined) event[key] = scalar;
  }
  return event;
}

async function emitProgress(ports: ServicePorts, context: ProgressContext, type: string, fields?: AdapterRecord, conversationId?: string): Promise<void> {
  const sink = ports.progressSink;
  if (typeof sink !== "function") return;
  try {
    await sink(progressEvent(context, ports, type, fields, conversationId));
  } catch {
    // Progress is observational. Sink failures must never change the result.
  }
}

async function traced<T>(ports: ServicePorts, context: ProgressContext, name: string, attributes: AdapterRecord, operation: () => T | PromiseLike<T>): Promise<T> {
  if (typeof ports.tracer?.runSpan !== "function") return operation();
  return ports.tracer.runSpan(
    name,
    {
      parent: context.traceparent,
      signal: context.signal,
      attributes,
    },
    operation,
  );
}

function assertActive(context: ProgressContext): void {
  context.signal?.throwIfAborted();
}

function authorizationRequest(context: ProgressContext, action: string, resource: AdapterRecord = {}): AdapterRecord {
  const identity = context.identity;
  const principal: AdapterRecord = {
    subject_id: opaque(identity.subject_id ?? identity.actor_id),
    kind: opaque(identity.kind ?? identity.principal_kind, "human"),
    tenant_id: identity.tenant_id,
    status: opaque(identity.status),
    roles: Array.isArray(identity.roles) ? [...identity.roles] : [],
    actor_scopes: Array.isArray(identity.actor_scopes)
      ? [...identity.actor_scopes]
      : [],
  };
  if (
    typeof identity.workload_id === "string" &&
    identity.workload_id.length > 0
  ) {
    principal.workload_id = identity.workload_id;
  }
  const decisionContext: AdapterRecord = {
    token_scopes: Array.isArray(identity.token_scopes)
      ? [...identity.token_scopes]
      : [],
    request_id: context.request_id,
  };
  if (Array.isArray(identity.authentication_methods)) {
    decisionContext.authentication_methods = [
      ...identity.authentication_methods,
    ];
  }
  if (
    typeof identity.network_zone === "string" &&
    identity.network_zone.length > 0
  ) {
    decisionContext.network_zone = identity.network_zone;
  }
  const normalizedResource: AdapterRecord = {
    type: opaque(resource?.type, "interaction"),
    id: opaque(resource?.id, context.request_id),
    tenant_id: opaque(resource?.tenant_id, identity.tenant_id),
  };
  if (typeof resource?.owner_id === "string" && resource.owner_id.length > 0) {
    normalizedResource.owner_id = resource.owner_id;
  }
  return Object.freeze({
    action,
    principal: Object.freeze(principal),
    resource: Object.freeze(normalizedResource),
    context: Object.freeze(decisionContext),
  });
}

export async function authorizeAction(ports: ServicePorts, context: ProgressContext, action: string, resource: AdapterRecord = {}): Promise<unknown> {
  assertActive(context);
  if (typeof ports?.authorize !== "function") throw authorizationError();
  let decision;
  try {
    decision = await ports.authorize(
      authorizationRequest(context, action, resource),
    );
  } catch (error: unknown) {
    const candidate = error && typeof error === "object" ? error as { code?: unknown; details?: unknown } : {};
    if (candidate.code === "FORBIDDEN") throw authorizationError(candidate.details);
    throw error;
  }
  assertActive(context);
  if (decision?.effect !== "allow") throw authorizationError(decision);
  return decision;
}

function entityId(understanding: AdapterRecord, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const entity = understanding?.entities?.[name];
    const candidate =
      entity && typeof entity === "object" ? entity.value : entity;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return fallback;
}

function resourceForIntent(context: ProgressContext, understanding: AdapterRecord): AdapterRecord {
  if (understanding.intent === "crm.customer.create") {
    return {
      type: "customer",
      id: entityId(
        understanding,
        ["customer", "customer_id", "name"],
        context.request_id,
      ),
    };
  }
  if (understanding.intent === "crm.deal.update_stage") {
    return {
      type: "deal",
      id: entityId(understanding, ["deal", "deal_id"], context.request_id),
    };
  }
  return {
    type: understanding?.entities?.deal ? "deal" : "customer",
    id: entityId(
      understanding,
      ["customer", "customer_id", "deal", "deal_id", "query"],
      context.request_id,
    ),
  };
}

function identityArgs(context: ProgressContext, idempotencyKey: string): AdapterRecord {
  return {
    ...context.identity,
    request_id: context.request_id,
    idempotency_key: idempotencyKey,
  };
}

function knownErrorCode(error: unknown): string {
  const candidate = error && typeof error === "object" ? error as { code?: unknown } : {};
  return typeof candidate.code === "string" && Object.hasOwn(ERROR_CODES, candidate.code)
    ? candidate.code
    : "INVALID_REQUEST";
}

function result(kind: string, response: unknown): Readonly<{ kind: string; response: unknown }> {
  return Object.freeze({ kind, response });
}

function askFingerprint(command: ServiceCommand): string {
  return sha256(
    JSON.stringify({
      input:
        command.input.type === "audio"
          ? {
              type: "audio",
              sha256: command.input.sha256,
              content_type: command.input.content_type,
            }
          : { type: "text", text: command.input.text },
      locale: command.locale,
      output_mode: command.outputMode,
      conversation_id: command.conversationId ?? null,
    }),
  );
}

function interactionPayload(command: ServiceCommand): AdapterRecord {
  const common = {
    locale: command.locale,
    output_mode: command.outputMode,
    conversation_id: command.conversationId ?? null,
  };
  return command.input.type === "audio"
    ? {
        type: "audio",
        content_type: command.input.content_type,
        byte_length: Buffer.from(command.input.data_base64, "base64").length,
        sha256: command.input.sha256,
        ...common,
      }
    : { type: "text", text: command.input.text, ...common };
}

export class AskService {
  readonly ports: ServicePorts;

  constructor(ports: ServicePorts = {}) {
    this.ports = createServicePorts(ports, { intentProviderName: "unknown" });
  }

  async execute(context: ProgressContext, command: ServiceCommand): Promise<Readonly<{ kind: string; response: unknown }>> {
    assertRequestContext(context);
    assertAskCommand(command);
    assertActive(context);
    const ports = this.ports;
    await authorizeAction(ports, context, "interaction.ask", {
      type: "interaction",
      id: command.conversationId ?? context.request_id,
    });
    if (command.outputMode === "audio" || command.outputMode === "both") {
      await authorizeAction(ports, context, "media.tts.create", {
        type: "media_asset",
        id: `${context.request_id}:tts`,
      });
    }
    const storeArgs = identityArgs(context, command.idempotencyKey);
    const requestFingerprint = askFingerprint(command);
    await emitProgress(
      ports,
      context,
      "interaction.started",
      {
        input_type: command.input.type,
        output_mode: command.outputMode,
      },
      command.conversationId,
    );
    let interaction: AdapterRecord;
    try {
      interaction = await ports.beginInteraction({
        ...storeArgs,
        request_fingerprint: requestFingerprint,
        input_type: command.input.type,
        input_payload: interactionPayload(command),
      });
    } catch (error) {
      await emitProgress(
        ports,
        context,
        "interaction.failed",
        {
          error_code: knownErrorCode(error),
        },
        command.conversationId,
      );
      throw error;
    }
    if (interaction.replay) {
      const schema =
        interaction.response?.status === "needs_review"
          ? "ReviewResponse"
          : "AskResponse";
      try {
        const validated = ports.validateResponse(schema, interaction.response);
        await emitProgress(
          ports,
          context,
          "interaction.replayed",
          undefined,
          command.conversationId,
        );
        return result("ask.replayed", validated);
      } catch (error) {
        await emitProgress(
          ports,
          context,
          "interaction.failed",
          {
            error_code: knownErrorCode(error),
          },
          command.conversationId,
        );
        throw error;
      }
    }

    try {
      let audioBytes: Buffer | undefined;
      if (command.input.type === "audio") {
        audioBytes = Buffer.from(command.input.data_base64, "base64");
        const persistedInput = await traced(
          ports,
          context,
          "storage.object",
          {
            "storage.kind": ports.storageKind ?? "unknown",
            "input.type": "audio",
          },
          () =>
            ports.persistInputAudio(audioBytes, {
              tenantId: context.identity.tenant_id,
              requestId: context.request_id,
              contentType: command.input.content_type,
            }),
        );
        assertActive(context);
        await ports.recordInputAsset({
          ...storeArgs,
          ...persistedInput,
          asset: persistedInput.asset,
        });
        await emitProgress(
          ports,
          context,
          "input.asset.persisted",
          {
            asset_id: opaque(
              persistedInput.asset_id ?? persistedInput.asset?.asset_id,
            ),
            sha256: opaque(
              persistedInput.sha256 ?? persistedInput.asset?.sha256,
            ),
            byte_length: finiteNumber(
              persistedInput.byte_length ?? persistedInput.asset?.byte_length,
              0,
            ),
          },
          command.conversationId,
        );
      }

      const asrStarted = ports.now();
      const transcriptResult =
        command.input.type === "audio"
          ? await traced(
              ports,
              context,
              "provider.asr",
              {
                "input.type": "audio",
                "provider.kind": ports.asrProviderKind ?? "unknown",
              },
              () =>
                ports.transcribe(audioBytes, {
                  locale: command.locale,
                  contentType: command.input.content_type,
                  signal: context.signal,
                }),
            )
          : {
              text: command.input.text,
              language: command.locale.split("-")[0],
              confidence: 1,
              provider: "direct",
              model: "none",
              duration_ms: 0,
            };
      if (!transcriptResult?.text?.trim()) {
        throw Object.assign(new Error("no speech detected"), {
          code: "EMPTY_TRANSCRIPT",
        });
      }
      assertActive(context);
      await ports.checkpointInteraction({
        ...storeArgs,
        transcript: transcriptResult,
        provider_invocations: [
          {
            operation: "asr",
            provider: transcriptResult.provider,
            model: transcriptResult.model,
            status: "succeeded",
          },
        ],
        model_versions: { asr: transcriptResult.model },
        latency_ms: { asr: ports.now() - asrStarted },
      });
      await emitProgress(
        ports,
        context,
        "transcript.created",
        {
          language: opaque(transcriptResult.language),
          provider: opaque(transcriptResult.provider),
          model: opaque(transcriptResult.model),
          length: transcriptResult.text.length,
        },
        command.conversationId,
      );

      const intentStarted = ports.now();
      const understanding: AdapterRecord = normalizeUnderstanding(
        await traced(
          ports,
          context,
          "provider.intent",
          {
            "provider.kind": ports.intentProviderKind ?? "unknown",
          },
          () =>
            ports.understand(transcriptResult.text, {
              locale: command.locale,
              signal: context.signal,
            }),
        ),
      ) as AdapterRecord;
      const intentModel =
        understanding.source?.model ?? understanding.model ?? "unknown";
      assertActive(context);
      const resource = resourceForIntent(context, understanding);
      const businessAction = createAgentCrmActionProposal({
        context,
        understanding,
        target: resource,
        idempotencyKey: command.idempotencyKey,
        requestFingerprint,
      });
      await authorizeAction(
        ports,
        context,
        businessAction.policy.authorization_action,
        resource,
      );
      await ports.checkpointInteraction({
        ...storeArgs,
        understanding,
        business_action: businessAction,
        provider_invocations: [
          {
            operation: "intent",
            provider: ports.intentProviderName,
            model: intentModel,
            status: "succeeded",
          },
        ],
        model_versions: { intent: intentModel },
        latency_ms: { intent: ports.now() - intentStarted },
      });
      await emitProgress(
        ports,
        context,
        "understanding.created",
        {
          intent: opaque(understanding.intent),
          confidence: finiteNumber(understanding.confidence, 0),
          needs_confirmation: Boolean(understanding.needs_confirmation),
          model: opaque(intentModel),
        },
        command.conversationId,
      );

      const response: AdapterRecord = {
        request_id: context.request_id,
        status: understanding.needs_confirmation ? "needs_review" : "completed",
        input: {
          type: command.input.type,
          transcript: transcriptResult.text,
          language: transcriptResult.language,
          asr: transcriptResult,
        },
        understanding,
        answer: {
          text:
            understanding.intent === "crm.deal.update_stage"
              ? "已更新商机阶段。"
              : "已解析请求，正在处理。",
          language: command.locale,
        },
      };

      if (understanding.needs_confirmation) {
        assertActive(context);
        response.review_task = await traced(
          ports,
          context,
          "store.transaction",
          {
            "db.system": ports.databaseKind ?? "unknown",
            "app.result": "needs_review",
          },
          () =>
            ports.createReview({
              ...storeArgs,
              request_fingerprint: requestFingerprint,
              understanding,
              action: businessAction,
            }),
        );
        await emitProgress(
          ports,
          context,
          "review.required",
          {
            review_id: opaque(
              response.review_task?.id ?? response.review_task?.review_id,
            ),
          },
          command.conversationId,
        );
        const validated = ports.validateResponse("ReviewResponse", response);
        await ports.completeInteraction({
          ...storeArgs,
          response: validated,
          outcome: "review_required",
        });
        await emitProgress(
          ports,
          context,
          "interaction.completed",
          {
            outcome: "review_required",
          },
          command.conversationId,
        );
        return result("ask.review_required", validated);
      }

      assertActive(context);
      response.crm = await traced(
        ports,
        context,
        "store.transaction",
        {
          "db.system": ports.databaseKind ?? "unknown",
          "app.operation": "ask",
        },
        () =>
          ports.executeCrm({
            ...storeArgs,
            request_fingerprint: requestFingerprint,
            intent: understanding.intent,
            entities: understanding.entities,
            action: businessAction,
          }),
      );
      await emitProgress(
        ports,
        context,
        "crm.committed",
        {
          resource: safeResource(response.crm?.resource),
          action: opaque(response.crm?.action),
          aggregate_version: finiteNumber(response.crm?.aggregate_version, 0),
        },
        command.conversationId,
      );
      if (command.outputMode === "audio" || command.outputMode === "both") {
        const format = ports.ttsDefaultFormat();
        const audioFingerprint = sha256(
          JSON.stringify({
            text: response.answer.text,
            language: command.locale,
            format,
          }),
        );
        const ttsStarted = ports.now();
        const generated = await traced(
          ports,
          context,
          "provider.tts",
          {
            "output.mode": command.outputMode,
            "provider.kind": ports.ttsProviderKind ?? "unknown",
          },
          () =>
            ports.synthesize(response.answer.text, {
              language: command.locale,
              format,
              signal: context.signal,
            }),
        );
        const persisted = await traced(
          ports,
          context,
          "storage.object",
          {
            "storage.kind": ports.storageKind ?? "unknown",
          },
          () =>
            ports.persistAudioAsset(generated, {
              tenantId: context.identity.tenant_id,
              kind: "tts",
            }),
        );
        assertActive(context);
        response.audio = await traced(
          ports,
          context,
          "store.transaction",
          {
            "db.system": ports.databaseKind ?? "unknown",
          },
          () =>
            ports.recordTts(
              `${context.identity.tenant_id}:${command.idempotencyKey}:audio:${audioFingerprint}`,
              audioFingerprint,
              persisted.asset,
              {
                ...storeArgs,
                object_key: persisted.object_key,
                byte_length: persisted.byte_length,
                sha256: persisted.sha256,
              },
            ),
        );
        await emitProgress(
          ports,
          context,
          "tts.asset.created",
          {
            asset_id: opaque(response.audio?.asset_id),
            mime: opaque(response.audio?.mime_type),
            status: opaque(response.audio?.status),
          },
          command.conversationId,
        );
        await ports.checkpointInteraction({
          ...storeArgs,
          provider_invocations: [
            {
              operation: "tts",
              provider: generated.provider,
              model: generated.model,
              status: "succeeded",
            },
          ],
          model_versions: { tts: generated.model },
          latency_ms: { tts: ports.now() - ttsStarted },
        });
      }
      const validated = ports.validateResponse("AskResponse", response);
      await ports.completeInteraction({
        ...storeArgs,
        response: validated,
        outcome: "completed",
      });
      await emitProgress(
        ports,
        context,
        "interaction.completed",
        {
          outcome: "completed",
        },
        command.conversationId,
      );
      return result("ask.completed", validated);
    } catch (error: unknown) {
      const errorCode = knownErrorCode(error);
      if (
        context.signal?.aborted &&
        typeof ports.abandonInteraction === "function"
      ) {
        try {
          await ports.abandonInteraction(storeArgs);
        } catch {}
        await emitProgress(
          ports,
          context,
          "interaction.cancelled",
          undefined,
          command.conversationId,
        );
      } else {
        try {
          await ports.failInteraction({
            ...storeArgs,
            error_code: errorCode,
            error_message: error instanceof Error ? error.message : "request failed",
          });
        } catch {}
        await emitProgress(
          ports,
          context,
          "interaction.failed",
          {
            error_code: errorCode,
          },
          command.conversationId,
        );
      }
      throw error;
    }
  }
}

export class TtsService {
  readonly ports: ServicePorts;

  constructor(ports: ServicePorts = {}) {
    this.ports = createServicePorts(ports);
  }

  async execute(context: ProgressContext, command: ServiceCommand): Promise<Readonly<{ kind: string; response: unknown }>> {
    assertRequestContext(context);
    assertTtsCommand(command);
    assertActive(context);
    await authorizeAction(this.ports, context, "media.tts.create", {
      type: "media_asset",
      id: `${context.request_id}:tts`,
    });
    const key = `${context.identity.tenant_id}:${command.idempotencyKey}`;
    const fingerprint = sha256(
      JSON.stringify({
        text: command.text,
        language: command.language,
        voice: command.voice,
        format: command.format,
      }),
    );
    const replay = await this.ports.replayTts(key, fingerprint);
    if (replay) {
      const response = this.ports.validateResponse("TtsSynthesizeResponse", {
        request_id: context.request_id,
        asset: replay,
        idempotency_replay: true,
      });
      await emitProgress(this.ports, context, "tts.replayed", {
        asset_id: opaque(response.asset?.asset_id),
      });
      return result("tts.replayed", response);
    }
    const generated = await traced(
      this.ports,
      context,
      "provider.tts",
      {
        "output.mode": "audio",
        "provider.kind": this.ports.ttsProviderKind ?? "unknown",
      },
      () =>
        this.ports.synthesize(command.text, {
          language: command.language,
          voice: command.voice,
          format: command.format,
          signal: context.signal,
        }),
    );
    const persisted = await traced(
      this.ports,
      context,
      "storage.object",
      {
        "storage.kind": this.ports.storageKind ?? "unknown",
      },
      () =>
        this.ports.persistAudioAsset(generated, {
          tenantId: context.identity.tenant_id,
          kind: "tts",
        }),
    );
    assertActive(context);
    const asset = await traced(
      this.ports,
      context,
      "store.transaction",
      {
        "db.system": this.ports.databaseKind ?? "unknown",
      },
      () =>
        this.ports.recordTts(key, fingerprint, persisted.asset, {
          ...identityArgs(context, command.idempotencyKey),
          object_key: persisted.object_key,
          byte_length: persisted.byte_length,
          sha256: persisted.sha256,
        }),
    );
    const response = this.ports.validateResponse("TtsSynthesizeResponse", {
      request_id: context.request_id,
      asset,
      idempotency_replay: false,
    });
    await emitProgress(this.ports, context, "tts.asset.created", {
      asset_id: opaque(asset?.asset_id),
      mime: opaque(asset?.mime_type),
      status: opaque(asset?.status),
    });
    return result("tts.created", response);
  }
}

export class ReviewService {
  readonly ports: ServicePorts;

  constructor(ports: ServicePorts = {}) {
    this.ports = createServicePorts(ports);
  }

  async execute(context: ProgressContext, command: ServiceCommand): Promise<Readonly<{ kind: string; response: unknown }>> {
    assertRequestContext(context);
    assertReviewCommand(command);
    assertActive(context);
    await authorizeAction(this.ports, context, "review.decide", {
      type: "review",
      id: command.reviewId,
    });
    if (typeof this.ports.decideReview !== "function") {
      throw Object.assign(
        new Error("review decisions require STORE_PROVIDER=postgres"),
        { code: "UPSTREAM_UNAVAILABLE" },
      );
    }
    const decision = await traced(
      this.ports,
      context,
      "store.transaction",
      {
        "db.system": this.ports.databaseKind ?? "unknown",
        "app.operation": "review",
      },
      () =>
        this.ports.decideReview({
          ...identityArgs(context, command.idempotencyKey),
          review_id: command.reviewId,
          decision: command.decision,
          correction: command.correction,
        }),
    );
    const response = this.ports.validateResponse(
      "ReviewDecisionResponse",
      decision,
    );
    await emitProgress(this.ports, context, "review.decided", {
      review_id: opaque(response.review_id ?? command.reviewId),
      decision: command.decision,
      status: opaque(response.status),
    });
    return result("review.decided", response);
  }
}
