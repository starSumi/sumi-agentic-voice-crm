import {
  createServer as createHttpServer,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import authorizationPolicy from "../contracts/authorization-policy.json" with { type: "json" };
// HTTP transport adapter: Node request/response shapes are intentionally kept
// at this edge; application services and protocol validators remain strict TS.
import {
  AskService,
  createAttachmentRef,
  normalizeAskCommand,
  normalizeReviewCommand,
  normalizeTtsCommand,
  ReviewService,
  TtsService,
} from "./application/index.ts";
import { authorizeAction } from "./application/services.ts";
import {
  createRequestContext,
  createRuntime,
  type Runtime,
  type RuntimeStore,
} from "./composition-root.ts";
import type { ApplicationRequestContext } from "./application/commands.ts";
import type { AuthIdentity } from "./auth.ts";
import {
  ERROR_CODES,
  errorEnvelope,
  requestId,
  sha256,
  validateAudioInput,
  validateIdempotencyKey,
  validateTextAsk,
} from "./contracts.ts";
import { validateEvent, validateProtocol } from "./protocol-validation.ts";
import { persistAudioAsset, persistInputAudio } from "./object-storage.ts";
import {
  DEFAULT_AUDIO_OUTPUT_MODE,
  DEFAULT_LOCALE,
  REQUEST_BODY_LIMITS,
  REVIEW_ID_PATTERN,
} from "./protocol-policy.ts";
import { DEFAULT_TEARDOWN_TIMEOUT_MS } from "./control/index.ts";
import { createMessageJobWorker } from "./message-job-worker.ts";
import { parseMultipartRequest } from "./multipart.ts";
import { createRateLimiter } from "./rate-limiter.ts";
import type { AudioInput, TextAskInput } from "./contracts.ts";
import type { MessageJob, MessageJobWorkerQueue } from "./message-job-queue.ts";
import type {
  CheckpointInteractionInput,
  CreateReviewInput,
  CrmStore,
  ExecuteCrmInput,
} from "./store.ts";
import type {
  Action,
  ActionGrant,
  AuthorizationRequest,
  PrincipalKind,
  ResourceType,
  Role,
} from "./authorization/index.ts";

type DataRecord = Record<string, unknown>;
type AskInput = TextAskInput | (AudioInput & { readonly sha256?: string });
type RequestBodyChunk = Buffer | string | Uint8Array;
type RequestBodyStream = {
  readonly headers?: IncomingHttpHeaders;
  [Symbol.asyncIterator]?: () => AsyncIterator<RequestBodyChunk>;
};
type ApplicationOutcome = Readonly<{ kind: string; response: unknown }>;
type ApplicationService = {
  execute(
    context: ApplicationRequestContext,
    command: DataRecord,
  ): Promise<ApplicationOutcome>;
};
type JobPayload = {
  traceparent?: string;
  identity: AuthIdentity;
  command: DataRecord & { input: DataRecord };
};
type PrincipalResolver = (
  identity: AuthIdentity,
  options?: { signal?: AbortSignal },
) => unknown | PromiseLike<unknown>;
type RequestAuthenticator = (
  headers: Headers,
  options?: { signal?: AbortSignal },
) => AuthIdentity | PromiseLike<AuthIdentity>;
type Awaitable<T> = T | PromiseLike<T>;
type AppStore = MessageJobWorkerQueue & {
  health(): Awaitable<DataRecord & { ready: boolean }>;
  beginInteraction(
    input: Parameters<CrmStore["beginInteraction"]>[0],
  ): Awaitable<unknown>;
  checkpointInteraction(input: CheckpointInteractionInput): Awaitable<unknown>;
  completeInteraction(
    input: Parameters<CrmStore["completeInteraction"]>[0],
  ): Awaitable<unknown>;
  failInteraction(
    input: Parameters<CrmStore["failInteraction"]>[0],
  ): Awaitable<unknown>;
  abandonInteraction(
    input: Parameters<CrmStore["abandonInteraction"]>[0],
  ): Awaitable<unknown>;
  createReview(input: CreateReviewInput): Awaitable<unknown>;
  execute(input: ExecuteCrmInput): Awaitable<unknown>;
  recordInputAsset(
    input: Parameters<CrmStore["recordInputAsset"]>[0],
  ): Awaitable<unknown>;
  recordTts(...input: Parameters<CrmStore["recordTts"]>): Awaitable<unknown>;
  replayTts(...input: Parameters<CrmStore["replayTts"]>): Awaitable<unknown>;
  enqueueMessageJob(
    input: Parameters<CrmStore["enqueueMessageJob"]>[0],
  ): Awaitable<{ duplicate: boolean; job: MessageJob }>;
  messageJobStats(input?: {
    tenant_id?: string;
  }): Awaitable<Record<string, number>>;
  getMessageJob(input: {
    tenant_id?: string;
    actor_id?: string;
    job_id?: string;
    idempotency_key?: string;
  }): Awaitable<MessageJob | undefined>;
  events(tenantId?: string, actorId?: string): Awaitable<unknown[]>;
  eventPage(
    tenantId: string,
    actorId: string | undefined,
    input?: { limit?: unknown; cursor?: unknown },
  ): Awaitable<{ events: unknown[]; next_cursor?: string }>;
  assetFor(
    tenantId: string,
    assetId: string,
  ): Awaitable<DataRecord | undefined>;
  objectKeyFor(
    tenantId: string,
    assetId: string,
  ): Awaitable<string | undefined>;
  decideReview?: (args: DataRecord) => unknown | PromiseLike<unknown>;
};
type AppRuntime = Pick<
  Runtime,
  "providers" | "objectStorage" | "observability" | "close"
> & {
  authenticate: RequestAuthenticator;
  store: AppStore;
} & Partial<
    Pick<
      Runtime,
      | "authorize"
      | "control"
      | "env"
      | "extensions"
      | "progressEvents"
      | "resolvePrincipal"
      | "start"
      | "tracer"
    >
  >;
type CreateAppOptions = {
  runtime?: AppRuntime;
  runtimeFactory?: () => Runtime;
  teardownTimeoutMs?: number;
};
type PostgresRuntimeStore = Exclude<RuntimeStore, CrmStore>;
type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const AUTHORIZATION_ACTIONS = new Set<string>(authorizationPolicy.actions);
const AUTHORIZATION_GRANTS = new Set<string>([
  ...authorizationPolicy.actions,
  ...authorizationPolicy.allowed_action_wildcards,
]);
const AUTHORIZATION_ROLES = new Set<string>(authorizationPolicy.roles);
const AUTHORIZATION_RESOURCE_TYPES = new Set<string>(
  authorizationPolicy.resource_types,
);

function isDataRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPostgresStore(store: RuntimeStore): store is PostgresRuntimeStore {
  return "principalFor" in store && typeof store.principalFor === "function";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isDataRecord(value) && Object.values(value).every(isJsonValue);
}

function isAction(value: unknown): value is Action {
  return typeof value === "string" && AUTHORIZATION_ACTIONS.has(value);
}

function isActionGrant(value: unknown): value is ActionGrant {
  return typeof value === "string" && AUTHORIZATION_GRANTS.has(value);
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && AUTHORIZATION_ROLES.has(value);
}

function isResourceType(value: unknown): value is ResourceType {
  return typeof value === "string" && AUTHORIZATION_RESOURCE_TYPES.has(value);
}

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return value === "human" || value === "agent" || value === "workload";
}

function runtimeAuthorizationRequest(value: unknown): AuthorizationRequest {
  if (!isDataRecord(value))
    throw new TypeError("authorization request must be an object");
  const principal = value.principal;
  const resource = value.resource;
  const context = value.context;
  if (
    !isDataRecord(principal) ||
    !isDataRecord(resource) ||
    !isDataRecord(context)
  ) {
    throw new TypeError("authorization request fields must be objects");
  }
  if (!isAction(value.action))
    throw new TypeError("authorization action is invalid");
  if (!isPrincipalKind(principal.kind))
    throw new TypeError("authorization principal kind is invalid");
  if (principal.status !== "active" && principal.status !== "suspended") {
    throw new TypeError("authorization principal status is invalid");
  }
  if (!Array.isArray(principal.roles) || !principal.roles.every(isRole)) {
    throw new TypeError("authorization principal roles are invalid");
  }
  if (
    !Array.isArray(principal.actor_scopes) ||
    !principal.actor_scopes.every(isActionGrant)
  ) {
    throw new TypeError("authorization principal scopes are invalid");
  }
  if (!isResourceType(resource.type)) {
    throw new TypeError("authorization resource type is invalid");
  }
  if (
    !Array.isArray(context.token_scopes) ||
    !context.token_scopes.every(isActionGrant)
  ) {
    throw new TypeError("authorization token scopes are invalid");
  }
  const authenticationMethods = context.authentication_methods;
  if (
    authenticationMethods !== undefined &&
    (!Array.isArray(authenticationMethods) ||
      !authenticationMethods.every((entry) => typeof entry === "string"))
  ) {
    throw new TypeError("authorization authentication methods are invalid");
  }
  const networkZone = context.network_zone;
  if (
    networkZone !== undefined &&
    networkZone !== "public" &&
    networkZone !== "private" &&
    networkZone !== "service"
  ) {
    throw new TypeError("authorization network zone is invalid");
  }
  return {
    action: value.action,
    principal: {
      subject_id: requiredString(principal.subject_id, "principal.subject_id"),
      kind: principal.kind,
      tenant_id: requiredString(principal.tenant_id, "principal.tenant_id"),
      status: principal.status,
      roles: principal.roles,
      actor_scopes: principal.actor_scopes,
      workload_id:
        principal.workload_id === undefined
          ? undefined
          : requiredString(principal.workload_id, "principal.workload_id"),
    },
    resource: {
      type: resource.type,
      id: requiredString(resource.id, "resource.id"),
      tenant_id: requiredString(resource.tenant_id, "resource.tenant_id"),
      owner_id:
        resource.owner_id === undefined
          ? undefined
          : requiredString(resource.owner_id, "resource.owner_id"),
    },
    context: {
      token_scopes: context.token_scopes,
      authentication_methods: authenticationMethods,
      network_zone: networkZone,
      request_id:
        context.request_id === undefined
          ? undefined
          : requiredString(context.request_id, "context.request_id"),
    },
  };
}

function postgresCheckpoint(
  input: CheckpointInteractionInput,
): Parameters<PostgresRuntimeStore["checkpointInteraction"]>[0] {
  const providerInvocations = input.provider_invocations?.map((invocation) => {
    if (typeof invocation.status !== "string") {
      throw new TypeError(
        "provider invocation status is required for PostgreSQL",
      );
    }
    return { ...invocation, status: invocation.status };
  });
  return { ...input, provider_invocations: providerInvocations };
}

function postgresReview(
  input: CreateReviewInput,
): Parameters<PostgresRuntimeStore["createReview"]>[0] {
  return {
    ...input,
    idempotency_key: requiredString(input.idempotency_key, "idempotency_key"),
  };
}

function postgresExecute(
  input: ExecuteCrmInput,
): Parameters<PostgresRuntimeStore["execute"]>[0] {
  return {
    ...input,
    request_id: requiredString(input.request_id, "request_id"),
  };
}

function postgresReviewDecision(
  input: DataRecord,
): Parameters<PostgresRuntimeStore["decideReview"]>[0] {
  const decision = input.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new TypeError("review decision must be approve or reject");
  }
  if (
    input.correction !== undefined &&
    (!isDataRecord(input.correction) || !isJsonValue(input.correction))
  ) {
    throw new TypeError("review correction must be JSON-safe");
  }
  return {
    tenant_id: requiredString(input.tenant_id, "tenant_id"),
    actor_id: typeof input.actor_id === "string" ? input.actor_id : undefined,
    subject_id:
      typeof input.subject_id === "string" ? input.subject_id : undefined,
    kind: typeof input.kind === "string" ? input.kind : undefined,
    principal_kind:
      typeof input.principal_kind === "string"
        ? input.principal_kind
        : undefined,
    token_scopes: Array.isArray(input.token_scopes)
      ? input.token_scopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : undefined,
    authentication_methods: Array.isArray(input.authentication_methods)
      ? input.authentication_methods.filter(
          (method): method is string => typeof method === "string",
        )
      : undefined,
    network_zone:
      input.network_zone === "public" ||
      input.network_zone === "private" ||
      input.network_zone === "service"
        ? input.network_zone
        : undefined,
    workload_id:
      typeof input.workload_id === "string" ? input.workload_id : undefined,
    review_id: requiredString(input.review_id, "review_id"),
    decision,
    idempotency_key: requiredString(input.idempotency_key, "idempotency_key"),
    request_id: requiredString(input.request_id, "request_id"),
    correction: input.correction,
  };
}

function appStore(store: RuntimeStore): AppStore {
  if (!isPostgresStore(store)) return store;
  return {
    health: () => store.health(),
    beginInteraction: (input) => store.beginInteraction(input),
    checkpointInteraction: (input) =>
      store.checkpointInteraction(postgresCheckpoint(input)),
    completeInteraction: (input) => store.completeInteraction(input),
    failInteraction: (input) => store.failInteraction(input),
    abandonInteraction: (input) => store.abandonInteraction(input),
    createReview: (input) => store.createReview(postgresReview(input)),
    execute: (input) => store.execute(postgresExecute(input)),
    recordInputAsset: (input) => store.recordInputAsset(input),
    recordTts: (...input) => store.recordTts(...input),
    replayTts: (...input) => store.replayTts(...input),
    claimMessageJobs: (input) =>
      store.claimMessageJobs({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        worker_id: requiredString(input.worker_id, "worker_id"),
        batch_size:
          input.limit === undefined
            ? undefined
            : positiveNumber(input.limit, "limit"),
        lease_ms:
          input.lease_ms === undefined
            ? undefined
            : positiveNumber(input.lease_ms, "lease_ms"),
      }),
    completeMessageJob: (input) =>
      store.completeMessageJob({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        job_id: requiredString(input.job_id, "job_id"),
        worker_id: requiredString(input.worker_id, "worker_id"),
        result: input.result,
      }),
    renewMessageJobLease: (input) =>
      store.renewMessageJobLease({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        job_id: requiredString(input.job_id, "job_id"),
        worker_id: requiredString(input.worker_id, "worker_id"),
        lease_ms:
          input.lease_ms === undefined
            ? undefined
            : positiveNumber(input.lease_ms, "lease_ms"),
      }),
    failMessageJob: (input) =>
      store.failMessageJob({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        job_id: requiredString(input.job_id, "job_id"),
        worker_id: requiredString(input.worker_id, "worker_id"),
        error_code: input.error_code,
        error_message: input.error_message,
        max_attempts:
          input.max_attempts === undefined
            ? undefined
            : positiveNumber(input.max_attempts, "max_attempts"),
        retryable: input.retryable,
      }),
    releaseMessageJob: (input) =>
      store.releaseMessageJob({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        job_id: requiredString(input.job_id, "job_id"),
        worker_id: requiredString(input.worker_id, "worker_id"),
        reason: input.reason,
      }),
    enqueueMessageJob: (input) =>
      store.enqueueMessageJob({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        actor_id:
          typeof input.actor_id === "string" ? input.actor_id : undefined,
        request_id: requiredString(input.request_id, "request_id"),
        idempotency_key: requiredString(
          input.idempotency_key,
          "idempotency_key",
        ),
        request_fingerprint: requiredString(
          input.request_fingerprint,
          "request_fingerprint",
        ),
        payload: input.payload,
      }),
    messageJobStats: (input) =>
      store.messageJobStats({
        tenant_id: requiredString(input?.tenant_id, "tenant_id"),
      }),
    getMessageJob: (input) =>
      store.getMessageJob({
        tenant_id: requiredString(input.tenant_id, "tenant_id"),
        actor_id: input.actor_id,
        job_id: input.job_id,
        idempotency_key: input.idempotency_key,
      }),
    events: (tenantId, actorId) =>
      store.events(requiredString(tenantId, "tenant_id"), actorId),
    eventPage: (tenantId, actorId, input) =>
      store.eventPage(requiredString(tenantId, "tenant_id"), actorId, input),
    assetFor: async (...input) => {
      const asset = await store.assetFor(...input);
      return isDataRecord(asset) ? asset : undefined;
    },
    objectKeyFor: async (...input) => {
      const key = await store.objectKeyFor(...input);
      return typeof key === "string" ? key : undefined;
    },
    decideReview: (input) => store.decideReview(postgresReviewDecision(input)),
  };
}

function appRuntime(runtime: Runtime): AppRuntime {
  return Object.freeze({ ...runtime, store: appStore(runtime.store) });
}

function tenantIdentity(value: unknown): AuthIdentity & {
  tenant_id: string;
  actor_id: string;
} {
  if (
    !isDataRecord(value) ||
    typeof value.tenant_id !== "string" ||
    typeof value.actor_id !== "string"
  ) {
    throw new Error("request context requires request_id and tenant identity");
  }
  return { ...value, tenant_id: value.tenant_id, actor_id: value.actor_id };
}

function applicationRequestContext({
  request_id,
  traceparent,
  identity,
  signal,
}: {
  request_id: string;
  traceparent?: string;
  identity: unknown;
  signal?: AbortSignal;
}): ApplicationRequestContext {
  const resolvedIdentity = Object.freeze(tenantIdentity(identity));
  const context = createRequestContext({
    request_id,
    traceparent,
    identity: resolvedIdentity,
    signal,
  });
  return Object.freeze({ ...context, identity: resolvedIdentity });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw Object.assign(new Error(`${name} must be a non-empty string`), {
      code: "INVALID_REQUEST",
    });
  return value;
}

function positiveNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) result.append(name, entry);
    } else if (typeof value === "string") {
      result.set(name, value);
    }
  }
  return result;
}

function protocolRecord(
  name: Parameters<typeof validateProtocol>[0],
  value: unknown,
): DataRecord {
  const parsed = validateProtocol(name, value);
  if (!isDataRecord(parsed))
    throw Object.assign(new Error(`${name} must be an object`), {
      code: "INVALID_REQUEST",
    });
  return parsed;
}

function errorDetails(error: unknown): {
  code?: string;
  details?: DataRecord;
  message?: string;
} {
  if (!isDataRecord(error)) return {};
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    details: isDataRecord(error.details) ? error.details : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
  };
}

function jobPayload(value: unknown): JobPayload {
  if (
    !isDataRecord(value) ||
    !isDataRecord(value.identity) ||
    !isDataRecord(value.command) ||
    !isDataRecord(value.command.input)
  ) {
    throw Object.assign(new Error("message job payload is invalid"), {
      code: "INVALID_REQUEST",
    });
  }
  return {
    traceparent:
      typeof value.traceparent === "string" ? value.traceparent : undefined,
    identity: value.identity,
    command: { ...value.command, input: value.command.input },
  };
}

function payloadTooLarge(limit: number) {
  return Object.assign(new Error("request body exceeds " + limit + " bytes"), {
    code: "PAYLOAD_TOO_LARGE",
    details: { max_bytes: limit },
  });
}

export async function readRequestBody(
  req: RequestBodyStream,
  maxBytes: number,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("request body limit must be a positive integer");
  const declaredLength = Number(req.headers?.["content-length"]);
  if (
    Number.isSafeInteger(declaredLength) &&
    declaredLength >= 0 &&
    declaredLength > maxBytes
  )
    throw payloadTooLarge(maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  const iteratorFactory = req[Symbol.asyncIterator];
  if (!iteratorFactory)
    throw new TypeError("request body must be an async iterable");
  const body: AsyncIterable<RequestBodyChunk> = {
    [Symbol.asyncIterator]: () => iteratorFactory.call(req),
  };
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw payloadTooLarge(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function teardownTimeout(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_TEARDOWN_TIMEOUT_MS);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 30_000) {
    throw new Error(
      "RUNTIME_TEARDOWN_MS must be a positive integer no greater than 30000",
    );
  }
  return parsed;
}

function configuredMessageJobTenants(env: NodeJS.ProcessEnv): string[] {
  return String(env?.MESSAGE_JOB_TENANT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function serializableJobInput(input: AskInput) {
  if (input?.type !== "audio") return input;
  return {
    type: "audio",
    data_base64: Buffer.from(input.data).toString("base64"),
    content_type: input.content_type,
    sha256: input.sha256,
  };
}

function jobIdentity(identity: AuthIdentity): AuthIdentity {
  const fields = [
    "subject_id",
    "actor_id",
    "kind",
    "principal_kind",
    "tenant_id",
    "status",
    "workload_id",
    "network_zone",
  ];
  const result = Object.fromEntries(
    fields
      .filter((field) => identity?.[field] !== undefined)
      .map((field) => [field, identity[field]]),
  );
  for (const field of [
    "roles",
    "actor_scopes",
    "token_scopes",
    "authentication_methods",
  ]) {
    if (Array.isArray(identity?.[field])) result[field] = [...identity[field]];
  }
  return result;
}

function jobResponse(job: MessageJob, request_id: string, duplicate = false) {
  return {
    request_id,
    job_id: job.id,
    status: job.status,
    attempts: job.attempts,
    idempotency_replay: duplicate,
    ...(job.result === undefined ? {} : { result: job.result }),
  };
}

function askRequestFingerprint({
  input,
  locale,
  outputMode,
  conversationId,
}: {
  input: AskInput;
  locale: string;
  outputMode: string;
  conversationId?: string;
}) {
  return sha256(
    JSON.stringify({
      input:
        input.type === "audio"
          ? {
              type: "audio",
              sha256: input.sha256,
              content_type: input.content_type,
            }
          : { type: "text", text: input.text },
      locale,
      output_mode: outputMode,
      conversation_id: conversationId ?? null,
    }),
  );
}

export function createApp({
  runtime: suppliedRuntime,
  runtimeFactory = createRuntime,
  teardownTimeoutMs,
}: CreateAppOptions = {}) {
  const runtime = suppliedRuntime ?? appRuntime(runtimeFactory());
  const { store, authenticate, objectStorage, observability } = runtime;
  const env = runtime.env ?? {};
  const authenticateRequest: RequestAuthenticator = authenticate;
  const resolvePrincipal: PrincipalResolver | undefined =
    typeof runtime.resolvePrincipal === "function"
      ? runtime.resolvePrincipal
      : undefined;
  const providers = runtime.providers;
  const { providerReadiness } = providers;
  let draining = false;
  const shutdownController = new AbortController();
  const resolvedTeardownTimeoutMs = teardownTimeout(
    teardownTimeoutMs ?? env.RUNTIME_TEARDOWN_MS,
  );
  const rateLimiter = createRateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    maxKeys: env.RATE_LIMIT_MAX_KEYS,
  });
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
  const authorize = runtime.authorize;
  const authorizationPorts = Object.freeze({
    authorize:
      typeof authorize === "function"
        ? (request: DataRecord) =>
            authorize(runtimeAuthorizationRequest(request))
        : undefined,
  });
  const askService = new AskService({
    ...authorizationPorts,
    beginInteraction: (args: Parameters<CrmStore["beginInteraction"]>[0]) =>
      store.beginInteraction(args),
    checkpointInteraction: (
      args: Parameters<CrmStore["checkpointInteraction"]>[0],
    ) => store.checkpointInteraction(args),
    completeInteraction: ({
      outcome,
      ...args
    }: Omit<Parameters<CrmStore["completeInteraction"]>[0], "http_status"> & {
      outcome: string;
    }) =>
      store.completeInteraction({
        ...args,
        http_status: outcome === "review_required" ? 202 : 200,
      }),
    failInteraction: (
      args: Omit<Parameters<CrmStore["failInteraction"]>[0], "http_status">,
    ) =>
      store.failInteraction({
        ...args,
        http_status: ERROR_CODES[args.error_code][0],
      }),
    abandonInteraction: (args: Parameters<CrmStore["abandonInteraction"]>[0]) =>
      store.abandonInteraction?.(args),
    createReview: (args: Parameters<CrmStore["createReview"]>[0]) =>
      store.createReview(args),
    executeCrm: (args: Parameters<CrmStore["execute"]>[0]) =>
      store.execute(args),
    recordInputAsset: (args: Parameters<CrmStore["recordInputAsset"]>[0]) =>
      store.recordInputAsset(args),
    recordTts: (...args: Parameters<CrmStore["recordTts"]>) =>
      store.recordTts(...args),
    transcribe: (...args: Parameters<typeof providers.transcribe>) =>
      providers.transcribe(...args),
    understand: (...args: Parameters<typeof providers.understand>) =>
      providers.understand(...args),
    synthesize: (...args: Parameters<typeof providers.synthesize>) =>
      providers.synthesize(...args),
    ttsDefaultFormat: () => providers.ttsDefaultFormat(),
    persistInputAudio: (
      ...args: Parameters<typeof persistInputAudio> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => persistInputAudio(objectStorage, ...args),
    persistAudioAsset: (
      ...args: Parameters<typeof persistAudioAsset> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => persistAudioAsset(objectStorage, ...args),
    validateResponse: validateProtocol,
    intentProviderName: runtime.env?.INTENT_PROVIDER || "mock",
    intentProviderKind: runtime.env?.INTENT_PROVIDER || "unknown",
    asrProviderKind: runtime.env?.ASR_PROVIDER || "unknown",
    ttsProviderKind: runtime.env?.TTS_PROVIDER || "unknown",
    storageKind: runtime.objectStorage?.provider || "unknown",
    databaseKind:
      runtime.env?.STORE_PROVIDER === "postgres" ? "postgresql" : "memory",
    tracer: runtime.tracer,
    progressSink: runtime.progressEvents,
  });
  const ttsService = new TtsService({
    ...authorizationPorts,
    replayTts: (...args: Parameters<CrmStore["replayTts"]>) =>
      store.replayTts(...args),
    recordTts: (...args: Parameters<CrmStore["recordTts"]>) =>
      store.recordTts(...args),
    synthesize: (...args: Parameters<typeof providers.synthesize>) =>
      providers.synthesize(...args),
    persistAudioAsset: (
      ...args: Parameters<typeof persistAudioAsset> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => persistAudioAsset(objectStorage, ...args),
    validateResponse: validateProtocol,
    ttsProviderKind: runtime.env?.TTS_PROVIDER || "unknown",
    storageKind: runtime.objectStorage?.provider || "unknown",
    databaseKind:
      runtime.env?.STORE_PROVIDER === "postgres" ? "postgresql" : "memory",
    tracer: runtime.tracer,
    progressSink: runtime.progressEvents,
  });
  const decideReview = store.decideReview;
  const reviewService = new ReviewService({
    ...authorizationPorts,
    decideReview:
      typeof decideReview === "function"
        ? (args: DataRecord) => decideReview(args)
        : undefined,
    validateResponse: validateProtocol,
    databaseKind:
      runtime.env?.STORE_PROVIDER === "postgres" ? "postgresql" : "memory",
    tracer: runtime.tracer,
    progressSink: runtime.progressEvents,
  });

  async function runApplication(
    name: string,
    context: ApplicationRequestContext,
    service: ApplicationService,
    command: DataRecord,
  ): Promise<ApplicationOutcome> {
    const tracer = runtime.tracer;
    if (typeof tracer?.startSpan !== "function")
      return service.execute(context, command);
    const span = tracer.startSpan(name, {
      parent: context.traceparent,
      signal: context.signal,
      attributes: { "app.operation": name.slice("application.".length) },
    });
    const serviceContext = applicationRequestContext({
      request_id: context.request_id,
      identity: context.identity,
      signal: context.signal,
      traceparent: span.context.traceparent,
    });
    try {
      const outcome = await service.execute(serviceContext, command);
      span.end({
        status: "ok",
        attributes: {
          "app.result": outcome.kind?.includes("review")
            ? "needs_review"
            : "completed",
        },
      });
      return outcome;
    } catch (error) {
      span.end({
        status: "error",
        error,
        attributes: { "app.result": "failed" },
      });
      throw error;
    }
  }

  const messageJobWorker =
    typeof store.claimMessageJobs === "function"
      ? createMessageJobWorker({
          queue: store,
          tenantIds: configuredMessageJobTenants(env),
          batchSize: Number(env.MESSAGE_JOB_BATCH_SIZE || 10),
          leaseMs: Number(env.MESSAGE_JOB_LEASE_MS || 30_000),
          maxAttempts: Number(env.MESSAGE_JOB_MAX_ATTEMPTS || 3),
          pollIntervalMs: Number(env.MESSAGE_JOB_POLL_INTERVAL_MS || 1_000),
          processJob: async (job, { signal }) => {
            const payload = jobPayload(job.payload);
            const identity = resolvePrincipal
              ? await resolvePrincipal(payload.identity, { signal })
              : payload.identity;
            const input =
              payload.command.input?.type === "audio"
                ? {
                    ...payload.command.input,
                    data: Buffer.from(
                      requiredString(
                        payload.command.input.data_base64,
                        "message job audio data_base64",
                      ),
                      "base64",
                    ),
                  }
                : payload.command.input;
            const command = normalizeAskCommand({
              ...payload.command,
              input,
            });
            const context = applicationRequestContext({
              request_id: job.request_id,
              traceparent: payload.traceparent,
              identity,
              signal,
            });
            const outcome = await runApplication(
              "application.ask",
              context,
              askService,
              command,
            );
            return outcome.response;
          },
          onResult: (result) => observability.recordMessageJob(result),
        })
      : undefined;
  for (const tenantId of configuredMessageJobTenants(env))
    messageJobWorker?.registerTenant(tenantId);

  function requestSignal(
    req: IncomingMessage,
    res: ServerResponse,
  ): AbortSignal {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          Object.assign(new Error("client disconnected"), {
            name: "AbortError",
            code: "UPSTREAM_UNAVAILABLE",
            breakerEligible: false,
          }),
        );
      }
      cleanup();
    };
    const close = () => {
      if (!res.writableEnded) abort();
    };
    const stopForShutdown = () => {
      if (!controller.signal.aborted)
        controller.abort(shutdownController.signal.reason);
      cleanup();
    };
    const cleanup = () => {
      req.removeListener("aborted", abort);
      res.removeListener("close", close);
      shutdownController.signal.removeEventListener("abort", stopForShutdown);
    };
    req.once("aborted", abort);
    res.once("close", close);
    res.once("finish", cleanup);
    if (shutdownController.signal.aborted) stopForShutdown();
    else
      shutdownController.signal.addEventListener("abort", stopForShutdown, {
        once: true,
      });
    if (req.destroyed || res.destroyed) abort();
    return controller.signal;
  }
  async function authenticateContext(
    req: IncomingMessage,
    res: ServerResponse,
    rid: string,
    signal: AbortSignal,
  ): Promise<ApplicationRequestContext> {
    signal.throwIfAborted();
    const authenticatedIdentity = await authenticateRequest(
      webHeaders(req.headers),
      {
        signal,
      },
    );
    const identity = resolvePrincipal
      ? await resolvePrincipal(authenticatedIdentity, { signal })
      : authenticatedIdentity;
    signal.throwIfAborted();
    const traceparent = res.getHeader("traceparent");
    return applicationRequestContext({
      request_id: rid,
      traceparent: typeof traceparent === "string" ? traceparent : undefined,
      identity,
      signal,
    });
  }
  async function ask(
    req: IncomingMessage,
    res: ServerResponse,
    rid: string,
    signal: AbortSignal,
  ) {
    const context = await authenticateContext(req, res, rid, signal);
    const key = validateIdempotencyKey(req.headers["idempotency-key"]);
    const multipart = req.headers["content-type"]?.startsWith(
      "multipart/form-data",
    );
    const raw = multipart
      ? undefined
      : await readRequestBody(req, REQUEST_BODY_LIMITS.askJson);
    let input: AskInput;
    let outputMode = "text";
    let locale = DEFAULT_LOCALE;
    let conversationId: string | undefined;
    if (multipart) {
      const parts = await parseMultipartRequest(
        req,
        REQUEST_BODY_LIMITS.askMultipart,
      );
      let metadata: DataRecord;
      try {
        const metadataPart = parts.metadata;
        const decoded: unknown = JSON.parse(
          typeof metadataPart === "string" ? metadataPart : "{}",
        );
        if (!isDataRecord(decoded)) throw new Error("metadata must be JSON");
        metadata = decoded;
      } catch {
        throw Object.assign(new Error("metadata must be JSON"), {
          code: "INVALID_REQUEST",
        });
      }
      const parsed = protocolRecord("MultipartAskMetadata", {
        ...metadata,
        output_mode: metadata.output_mode ?? DEFAULT_AUDIO_OUTPUT_MODE,
      });
      outputMode = requiredString(parsed.output_mode, "output_mode");
      locale =
        typeof parsed.locale === "string" ? parsed.locale : DEFAULT_LOCALE;
      conversationId =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : undefined;
      const audio = parts.audio;
      input = validateAudioInput({
        data: typeof audio === "object" ? audio.data : Buffer.alloc(0),
        content_type:
          typeof audio === "object"
            ? audio.content_type
            : "application/octet-stream",
        locale,
        output_mode: outputMode,
        env: runtime.env,
      });
    } else {
      const parsed = protocolRecord(
        "AskRequest",
        JSON.parse(raw?.toString("utf8") || "{}"),
      );
      conversationId =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : undefined;
      const parsedInput = isDataRecord(parsed.input) ? parsed.input : undefined;
      if (parsedInput?.type === "audio") {
        input = validateAudioInput({
          data:
            typeof parsedInput.data_base64 === "string"
              ? Buffer.from(parsedInput.data_base64, "base64")
              : Buffer.alloc(0),
          content_type:
            typeof parsedInput.content_type === "string"
              ? parsedInput.content_type
              : "audio/wav",
          locale: typeof parsed.locale === "string" ? parsed.locale : locale,
          output_mode:
            typeof parsed.output_mode === "string"
              ? parsed.output_mode
              : "text",
          env: runtime.env,
        });
      } else {
        input = validateTextAsk(parsed);
      }
      outputMode = input.output_mode;
      locale = input.locale;
    }
    const respondAsync = /\brespond-async\b/i.test(
      String(req.headers.prefer ?? ""),
    );
    if (respondAsync) {
      if (typeof store.enqueueMessageJob !== "function" || !messageJobWorker) {
        throw Object.assign(
          new Error("asynchronous message jobs are unavailable"),
          {
            code: "UPSTREAM_UNAVAILABLE",
          },
        );
      }
      await authorizeAction(authorizationPorts, context, "interaction.ask", {
        type: "interaction",
        id: conversationId ?? rid,
      });
      if (outputMode === "audio" || outputMode === "both") {
        await authorizeAction(authorizationPorts, context, "media.tts.create", {
          type: "media_asset",
          id: `${rid}:tts`,
        });
      }
      const queued = await store.enqueueMessageJob({
        tenant_id: context.identity.tenant_id,
        actor_id: context.identity.actor_id,
        request_id: rid,
        idempotency_key: key,
        request_fingerprint: askRequestFingerprint({
          input,
          locale,
          outputMode,
          conversationId,
        }),
        payload: {
          traceparent: context.traceparent,
          identity: jobIdentity(context.identity),
          command: {
            idempotency_key: key,
            input: serializableJobInput(input),
            locale,
            output_mode: outputMode,
            conversation_id: conversationId,
          },
        },
      });
      messageJobWorker.registerTenant(context.identity.tenant_id);
      messageJobWorker.start();
      const response = jobResponse(queued.job, rid, queued.duplicate);
      return json(
        res,
        queued.job.status === "succeeded" ? 200 : 202,
        validateProtocol("MessageJobResponse", response),
      );
    }
    const outcome = await runApplication(
      "application.ask",
      context,
      askService,
      normalizeAskCommand({
        idempotency_key: key,
        input,
        locale,
        output_mode: outputMode,
        conversation_id: conversationId,
      }),
    );
    const response = isDataRecord(outcome.response) ? outcome.response : {};
    return json(
      res,
      response.status === "needs_review" ? 202 : 200,
      outcome.response,
    );
  }
  async function tts(
    req: IncomingMessage,
    res: ServerResponse,
    rid: string,
    signal: AbortSignal,
  ) {
    const context = await authenticateContext(req, res, rid, signal);
    const key = validateIdempotencyKey(req.headers["idempotency-key"]);
    const parsed = protocolRecord(
      "TtsRequest",
      JSON.parse(
        (await readRequestBody(req, REQUEST_BODY_LIMITS.ttsJson)).toString(
          "utf8",
        ) || "{}",
      ),
    );
    const outcome = await runApplication(
      "application.tts",
      context,
      ttsService,
      normalizeTtsCommand({
        idempotency_key: key,
        ...parsed,
      }),
    );
    return json(res, 201, outcome.response);
  }
  async function reviewDecision(
    req: IncomingMessage,
    res: ServerResponse,
    rid: string,
    signal: AbortSignal,
  ) {
    const context = await authenticateContext(req, res, rid, signal);
    const key = validateIdempotencyKey(req.headers["idempotency-key"]);
    const reviewId = decodeURIComponent(
      requiredString(req.url, "request URL").slice(
        "/v1/reviews/".length,
        -"/decision".length,
      ),
    );
    if (!REVIEW_ID_PATTERN.test(reviewId))
      throw Object.assign(
        new Error("review id is outside the published contract"),
        { code: "INVALID_REQUEST" },
      );
    const parsed = protocolRecord(
      "ReviewDecisionRequest",
      JSON.parse(
        (await readRequestBody(req, REQUEST_BODY_LIMITS.reviewJson)).toString(
          "utf8",
        ) || "{}",
      ),
    );
    const outcome = await runApplication(
      "application.review",
      context,
      reviewService,
      normalizeReviewCommand({
        idempotency_key: key,
        review_id: reviewId,
        ...parsed,
      }),
    );
    return json(res, 200, outcome.response);
  }
  const server = createHttpServer(async (req, res) => {
    const rid = requestId();
    const telemetry = observability.begin(req, rid);
    const signal = requestSignal(req, res);
    let errorCode: string | undefined;
    if (telemetry.traceparent)
      res.setHeader("traceparent", telemetry.traceparent);
    res.setHeader("x-request-id", rid);
    res.once("finish", () =>
      observability.finish(telemetry, res.statusCode, errorCode),
    );
    try {
      if (req.url?.split("?", 1)[0].startsWith("/v1/")) {
        const decision = rateLimiter.check(
          req.socket.remoteAddress ?? "unknown",
        );
        if (!decision.allowed) {
          res.setHeader("retry-after", decision.retry_after_seconds);
          throw Object.assign(new Error("request rate limit exceeded"), {
            code: "RATE_LIMITED",
          });
        }
      }
      if (req.method === "GET" && req.url === "/health/live")
        return json(res, 200, {
          status: "ok",
          service: "sumi-agentic-voice-crm",
          request_id: rid,
        });
      if (req.method === "GET" && req.url === "/health/ready") {
        const [database, objects, rawExtensionStatus] = await Promise.all([
          store.health(),
          objectStorage.health(),
          runtime.extensions?.health?.({ signal }) ?? {},
        ]);
        const extensionStatus = isDataRecord(rawExtensionStatus)
          ? rawExtensionStatus
          : {};
        const providerStatus = providerReadiness();
        const extensionsReady = Object.values(extensionStatus).every(
          (status) => isDataRecord(status) && status.ready === true,
        );
        const ready =
          !draining &&
          database.ready &&
          objects.ready &&
          providerStatus.ready &&
          extensionsReady;
        return json(res, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          dependencies: {
            database,
            objects,
            providers: providerStatus.statuses,
            extensions: extensionStatus,
          },
          request_id: rid,
        });
      }
      if (req.method === "GET" && req.url === "/metrics") {
        if (!observability.authorizeMetrics(req.headers.authorization))
          throw Object.assign(new Error("metrics authentication required"), {
            code: "UNAUTHORIZED",
          });
        res.statusCode = 200;
        res.setHeader(
          "content-type",
          "text/plain; version=0.0.4; charset=utf-8",
        );
        return res.end(observability.renderMetrics());
      }
      if (req.method === "GET" && req.url === "/v1/jobs/stats") {
        const context = await authenticateContext(req, res, rid, signal);
        await authorizeAction(authorizationPorts, context, "interaction.ask", {
          type: "interaction",
          id: `${context.identity.tenant_id}:jobs`,
        });
        if (typeof store.messageJobStats !== "function")
          throw Object.assign(new Error("message jobs are unavailable"), {
            code: "UPSTREAM_UNAVAILABLE",
          });
        return json(
          res,
          200,
          validateProtocol("MessageJobStatsResponse", {
            request_id: rid,
            tenant_id: context.identity.tenant_id,
            jobs: await store.messageJobStats({
              tenant_id: context.identity.tenant_id,
            }),
          }),
        );
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/jobs/")) {
        const context = await authenticateContext(req, res, rid, signal);
        await authorizeAction(authorizationPorts, context, "interaction.ask", {
          type: "interaction",
          id: req.url.slice("/v1/jobs/".length),
        });
        const jobId = decodeURIComponent(req.url.slice("/v1/jobs/".length));
        if (!/^job_[0-9a-f]{32}$/.test(jobId))
          throw Object.assign(new Error("invalid message job id"), {
            code: "INVALID_REQUEST",
          });
        if (typeof store.getMessageJob !== "function")
          throw Object.assign(new Error("message jobs are unavailable"), {
            code: "UPSTREAM_UNAVAILABLE",
          });
        const job = await store.getMessageJob({
          tenant_id: context.identity.tenant_id,
          actor_id: context.identity.actor_id,
          job_id: jobId,
        });
        if (!job)
          throw Object.assign(new Error("message job not found"), {
            code: "FORBIDDEN",
          });
        return json(
          res,
          200,
          validateProtocol("MessageJobResponse", {
            ...jobResponse(job, rid),
            original_request_id: job.request_id,
            ...(job.error_code === undefined
              ? {}
              : { error_code: job.error_code }),
          }),
        );
      }
      if (
        req.method === "GET" &&
        req.url?.split("?", 1)[0] === "/v1/events"
      ) {
        const requestUrl = new URL(req.url, "http://localhost");
        const context = await authenticateContext(req, res, rid, signal);
        const { identity } = context;
        await authorizeAction(authorizationPorts, context, "events.read", {
          type: "event_stream",
          id: `${identity.tenant_id}:events`,
        });
        const page = await store.eventPage(
          identity.tenant_id,
          identity.actor_id,
          {
            limit: requestUrl.searchParams.get("limit") ?? undefined,
            cursor: requestUrl.searchParams.get("cursor") ?? undefined,
          },
        );
        return json(res, 200, {
          events: page.events.filter((event) => {
            validateEvent(event);
            return (
              isDataRecord(event) && event.tenant_id === identity.tenant_id
            );
          }),
          ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
          request_id: rid,
        });
      }
      if (req.method === "POST" && req.url === "/v1/ask")
        return await ask(req, res, rid, signal);
      if (req.method === "POST" && req.url === "/v1/tts/synthesize")
        return await tts(req, res, rid, signal);
      if (
        req.method === "POST" &&
        req.url?.startsWith("/v1/reviews/") &&
        req.url.endsWith("/decision")
      )
        return await reviewDecision(req, res, rid, signal);
      if (req.method === "GET" && req.url?.startsWith("/v1/assets/")) {
        const context = await authenticateContext(req, res, rid, signal);
        const { identity } = context;
        const contentRequest = req.url.endsWith("/content");
        const encodedAssetId = contentRequest
          ? req.url.slice(11, -"/content".length)
          : req.url.slice(11);
        const assetId = decodeURIComponent(encodedAssetId);
        if (!/^ast_[A-Za-z0-9_-]{8,128}$/.test(assetId))
          throw Object.assign(new Error("invalid asset id"), {
            code: "INVALID_REQUEST",
          });
        await authorizeAction(authorizationPorts, context, "media.asset.read", {
          type: "media_asset",
          id: assetId,
        });
        const asset = await store.assetFor(identity.tenant_id, assetId);
        if (!asset)
          throw Object.assign(new Error("asset not found"), {
            code: "FORBIDDEN",
          });
        if (
          typeof asset.mime_type !== "string" ||
          !asset.mime_type.startsWith("audio/")
        ) {
          throw Object.assign(new Error("asset media type is unavailable"), {
            code: "UNSUPPORTED_MEDIA",
          });
        }
        const objectKey = await store.objectKeyFor?.(
          identity.tenant_id,
          assetId,
        );
        if (contentRequest) {
          if (!objectKey || typeof objectStorage.get !== "function") {
            throw Object.assign(new Error("asset content is unavailable"), {
              code: "UPSTREAM_UNAVAILABLE",
            });
          }
          const stored = await objectStorage.get(objectKey);
          res.statusCode = 200;
          res.setHeader("content-type", asset.mime_type);
          res.setHeader("content-length", stored.body.length);
          res.setHeader("cache-control", "private, no-store");
          res.setHeader("x-content-type-options", "nosniff");
          return res.end(stored.body);
        }
        const attachment = createAttachmentRef({
          ...asset,
          kind: "audio",
          url: `/v1/assets/${assetId}/content`,
        });
        return json(res, 200, validateProtocol("AttachmentRef", attachment));
      }
      return json(
        res,
        404,
        validateProtocol(
          "ErrorEnvelope",
          errorEnvelope("INVALID_REQUEST", "route not found", rid),
        ),
      );
    } catch (error) {
      const failure = errorDetails(error);
      errorCode =
        failure.code && ERROR_CODES[failure.code]
          ? failure.code
          : "INVALID_REQUEST";
      const status = ERROR_CODES[errorCode]?.[0] ?? 400;
      const details = failure.details ?? {};
      return json(
        res,
        status,
        validateProtocol(
          "ErrorEnvelope",
          errorEnvelope(errorCode, failure.message, rid, details),
        ),
      );
    }
  });
  let shutdownPromise: Promise<void> | undefined;
  async function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    shutdownPromise = (async () => {
      if (!server.listening) {
        shutdownController.abort(
          Object.assign(new Error("runtime is closing"), {
            name: "AbortError",
            breakerEligible: false,
          }),
        );
        await messageJobWorker?.close(
          Object.assign(new Error("message job worker is stopping"), {
            name: "AbortError",
            breakerEligible: false,
          }),
        );
        return await runtime.close({ timeoutMs: resolvedTeardownTimeoutMs });
      }
      let timer: NodeJS.Timeout | undefined;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeIdleConnections?.();
      timer = setTimeout(() => {
        shutdownController.abort(
          Object.assign(new Error("runtime teardown deadline reached"), {
            name: "AbortError",
            code: "UPSTREAM_UNAVAILABLE",
            breakerEligible: false,
          }),
        );
        server.closeAllConnections?.();
      }, resolvedTeardownTimeoutMs);
      const errors: unknown[] = [];
      try {
        await serverClosed;
      } catch (error) {
        errors.push(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        await messageJobWorker?.close(
          Object.assign(new Error("message job worker is stopping"), {
            name: "AbortError",
            breakerEligible: false,
          }),
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        await runtime.close({ timeoutMs: resolvedTeardownTimeoutMs });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "application shutdown failed");
    })();
    return shutdownPromise;
  }
  return Object.freeze({
    server,
    runtime,
    get draining() {
      return draining;
    },
    listen(
      port: number,
      hostOrCallback?: string | (() => void),
      callback?: () => void,
    ) {
      return typeof hostOrCallback === "string"
        ? server.listen(port, hostOrCallback, callback)
        : server.listen(port, hostOrCallback);
    },
    startMessageJobs() {
      return messageJobWorker?.start();
    },
    close: shutdown,
  });
}

export const createServer = createApp;

export async function createStartedApp(options = {}) {
  const app = createApp(options);
  await app.runtime.start?.();
  if (configuredMessageJobTenants(app.runtime.env ?? {}).length > 0)
    app.startMessageJobs?.();
  return app;
}

async function main() {
  const port = Number(process.env.PORT || 8080);
  const app = await createStartedApp();
  app.listen(port, () =>
    console.log(`sumi-agentic-voice-crm listening on :${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () =>
      app.close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      }),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await main();
