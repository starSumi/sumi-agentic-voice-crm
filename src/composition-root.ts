import { createAuthenticator, type AuthIdentity } from "./auth.ts";
import authorizationPolicy from "../contracts/authorization-policy.json" with { type: "json" };
import {
  evaluateAuthorization,
  type AuthorizationDecision,
  type AuthorizationPolicy,
  type AuthorizationRequest,
} from "./authorization/index.ts";
import { CrmStore } from "./store.ts";
import { createPostgresStore } from "./postgres-store.ts";
import { createProviderRuntime, type ProviderRuntime } from "./providers.ts";
import { createObjectStorage, type ObjectStorage } from "./object-storage.ts";
import {
  createConfiguredTracer,
  createObservability,
  type Observability,
  type OtelTracer,
  type Tracer,
} from "./observability.ts";
import { validateProductionConfig } from "./production-config.ts";
import {
  createExtensionRegistry,
  type ExtensionRegistry,
} from "./extensions/index.ts";
import { createControlEngine, type ControlEngine } from "./control/index.ts";
import {
  createProgressEventBus,
  type ProgressEventBus,
} from "./application/progress-event-bus.ts";

/**
 * The composition root owns process-singleton resources. Request and operation
 * state must be created below this boundary; no protocol DTOs are stored here.
 */
type RuntimeEnvironment = NodeJS.ProcessEnv;
type PostgresStore = ReturnType<typeof createPostgresStore>;
export type RuntimeStore = CrmStore | PostgresStore;
type RuntimeTracer = Tracer | OtelTracer;
type RuntimeAuthorize = (
  request: AuthorizationRequest,
) => AuthorizationDecision | PromiseLike<AuthorizationDecision>;
type RuntimePrincipalResolver = (
  identity: AuthIdentity,
  options?: { signal?: AbortSignal },
) => unknown | PromiseLike<unknown>;
type ExtensionRegistration = Parameters<ExtensionRegistry["register"]>[0];
// This repository-owned artifact is validated against the canonical policy schema by
// scripts/check-authorization-policy.ts before runtime packaging.
const defaultAuthorizationPolicy = authorizationPolicy as AuthorizationPolicy;
type RuntimeOverrides = Partial<
  Pick<
    Runtime,
    | "authenticate"
    | "providers"
    | "objectStorage"
    | "tracer"
    | "progressEvents"
    | "observability"
    | "store"
    | "authorize"
    | "resolvePrincipal"
    | "extensions"
    | "control"
  >
> & {
  authorizationPolicy?: AuthorizationPolicy;
  extensionRegistrations?: readonly ExtensionRegistration[];
};
export type Runtime = Readonly<{
  env: Readonly<RuntimeEnvironment>;
  authenticate: (headers: Headers) => Promise<AuthIdentity>;
  providers: ProviderRuntime;
  objectStorage: ObjectStorage;
  tracer: RuntimeTracer;
  progressEvents: ProgressEventBus;
  observability: Observability;
  store: RuntimeStore;
  authorize: RuntimeAuthorize;
  resolvePrincipal: RuntimePrincipalResolver;
  extensions: ExtensionRegistry;
  control: ControlEngine;
  start(): Promise<void>;
  close(options?: unknown): Promise<void>;
}>;

type PostgresIdentity = Parameters<PostgresStore["principalFor"]>[0];

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function postgresIdentity(identity: AuthIdentity): PostgresIdentity {
  const tenantId = optionalString(identity.tenant_id);
  if (!tenantId)
    throw new TypeError("authenticated identity requires tenant_id");
  const networkZone = identity.network_zone;
  return {
    tenant_id: tenantId,
    actor_id: optionalString(identity.actor_id),
    subject_id: optionalString(identity.subject_id),
    kind: optionalString(identity.kind),
    principal_kind: optionalString(identity.principal_kind),
    token_scopes: optionalStringArray(identity.token_scopes),
    authentication_methods: optionalStringArray(
      identity.authentication_methods,
    ),
    network_zone:
      networkZone === "public" ||
      networkZone === "private" ||
      networkZone === "service"
        ? networkZone
        : undefined,
    workload_id: optionalString(identity.workload_id),
  };
}

function isCloseable(
  value: unknown,
): value is { close(options?: unknown): unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "close" in value &&
    typeof value.close === "function"
  );
}

export function createRuntime({
  env = process.env,
  overrides = {},
}: { env?: RuntimeEnvironment; overrides?: RuntimeOverrides } = {}): Runtime {
  const snapshot = Object.freeze({ ...env });
  validateProductionConfig(snapshot);
  const tracer = overrides.tracer ?? createConfiguredTracer({ env: snapshot });
  const progressEvents = overrides.progressEvents ?? createProgressEventBus();
  const extensions = overrides.extensions ?? createExtensionRegistry();
  const extensionRegistrations = overrides.extensionRegistrations ?? [];
  if (!Array.isArray(extensionRegistrations)) {
    throw new TypeError("extensionRegistrations must be an array");
  }
  for (const registration of extensionRegistrations)
    extensions.register(registration);
  const control =
    overrides.control ??
    createControlEngine({
      extensions,
      teardownTimeoutMs: snapshot.RUNTIME_TEARDOWN_MS
        ? Number(snapshot.RUNTIME_TEARDOWN_MS)
        : undefined,
    });
  const policy = overrides.authorizationPolicy ?? defaultAuthorizationPolicy;
  const authorize =
    overrides.authorize ??
    ((request: AuthorizationRequest) => evaluateAuthorization(policy, request));
  const store =
    overrides.store ??
    (snapshot.STORE_PROVIDER === "postgres"
      ? createPostgresStore({ env: snapshot, authorize })
      : new CrmStore());
  const runtime = {
    env: snapshot,
    authenticate:
      overrides.authenticate ?? createAuthenticator({ env: snapshot }),
    providers:
      overrides.providers ?? createProviderRuntime({ env: snapshot, control }),
    objectStorage:
      overrides.objectStorage ?? createObjectStorage({ env: snapshot }),
    tracer,
    progressEvents,
    observability:
      overrides.observability ?? createObservability({ env: snapshot, tracer }),
    store,
    authorize,
    resolvePrincipal:
      overrides.resolvePrincipal ??
      ((identity: AuthIdentity) =>
        "principalFor" in store && typeof store.principalFor === "function"
          ? store.principalFor(postgresIdentity(identity))
          : identity),
    extensions,
    control,
  };
  let startPromise: Promise<void> | undefined;
  function start(): Promise<void> {
    startPromise ??= control.start();
    return startPromise;
  }
  let closePromise: Promise<void> | undefined;
  function close(options?: unknown): Promise<void> {
    closePromise ??= (async () => {
      const errors = [];
      for (const resource of [
        runtime.control,
        runtime.store,
        runtime.objectStorage,
        runtime.progressEvents,
        runtime.tracer,
      ]) {
        try {
          if (isCloseable(resource)) {
            await resource.close(
              resource === runtime.control ? options : undefined,
            );
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(errors, "runtime resource shutdown failed");
    })();
    return closePromise;
  }
  return Object.freeze({
    ...runtime,
    start,
    close,
  });
}

/**
 * Request scope is explicit and immutable. Ports may accept this context, but
 * it never replaces protocol validation or the database transaction boundary.
 */
export function createRequestContext({
  request_id,
  traceparent,
  identity,
  signal,
  deadline_at,
}: {
  request_id?: string;
  traceparent?: string;
  identity?: AuthIdentity;
  signal?: AbortSignal;
  deadline_at?: number;
} = {}): Readonly<{
  request_id: string;
  traceparent?: string;
  identity: AuthIdentity;
  signal?: AbortSignal;
  deadline_at?: number;
}> {
  if (!request_id || !identity?.tenant_id || !identity?.actor_id)
    throw new Error("request context requires request_id and tenant identity");
  return Object.freeze({
    request_id,
    traceparent,
    identity: Object.freeze({ ...identity }),
    signal,
    deadline_at,
  });
}
