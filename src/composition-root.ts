import { createAuthenticator, type AuthIdentity } from "./auth.ts";
import authorizationPolicy from "../contracts/authorization-policy.json" with { type: "json" };
import { evaluateAuthorization } from "./authorization/index.ts";
import { CrmStore } from "./store.ts";
import { createPostgresStore } from "./postgres-store.ts";
import { createProviderRuntime, type ProviderRuntime } from "./providers.ts";
import { createObjectStorage } from "./object-storage.ts";
import {
  createConfiguredTracer,
  createObservability,
} from "./observability.ts";
import { validateProductionConfig } from "./production-config.ts";
import { createExtensionRegistry } from "./extensions/index.ts";
import { createControlEngine } from "./control/index.ts";
import { createProgressEventBus } from "./application/progress-event-bus.ts";

/**
 * The composition root owns process-singleton resources. Request and operation
 * state must be created below this boundary; no protocol DTOs are stored here.
 */
type RuntimeEnvironment = NodeJS.ProcessEnv;
type RuntimeOverrides = Record<string, any>;
export type Runtime = Readonly<{
  env: Readonly<RuntimeEnvironment>;
  authenticate: (headers: Headers) => Promise<AuthIdentity>;
  providers: ProviderRuntime;
  objectStorage: any;
  tracer: any;
  progressEvents: any;
  observability: any;
  store: any;
  authorize: (request: any) => unknown | PromiseLike<unknown>;
  resolvePrincipal: (identity: any) => unknown | PromiseLike<unknown>;
  extensions: any;
  control: any;
  start(): Promise<unknown>;
  close(options?: unknown): Promise<void>;
}>;

export function createRuntime({ env = process.env, overrides = {} }: { env?: RuntimeEnvironment; overrides?: RuntimeOverrides } = {}): Runtime {
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
      teardownTimeoutMs: snapshot.RUNTIME_TEARDOWN_MS ? Number(snapshot.RUNTIME_TEARDOWN_MS) : undefined,
    });
  const policy = overrides.authorizationPolicy ?? authorizationPolicy;
  const authorize =
    overrides.authorize ??
    ((request: any) => evaluateAuthorization(policy, request));
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
      ((identity: any) =>
        typeof store.principalFor === "function"
          ? store.principalFor(identity)
          : identity),
    extensions,
    control,
  };
  let startPromise;
  function start(): Promise<unknown> {
    startPromise ??= control.start();
    return startPromise;
  }
  let closePromise;
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
          await resource?.close?.(
            resource === runtime.control ? options : undefined,
          );
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
}: { request_id?: string; traceparent?: string; identity?: AuthIdentity; signal?: AbortSignal; deadline_at?: number } = {}): Readonly<{ request_id: string; traceparent?: string; identity: AuthIdentity; signal?: AbortSignal; deadline_at?: number }> {
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
