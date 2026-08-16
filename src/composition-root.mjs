import { createAuthenticator } from "./auth.mjs";
import { CrmStore } from "./store.mjs";
import { createPostgresStore } from "./postgres-store.mjs";
import { createProviderRuntime } from "./providers.mjs";
import { createObjectStorage } from "./object-storage.mjs";
import { createConfiguredTracer, createObservability } from "./observability.mjs";
import { validateProductionConfig } from "./production-config.mjs";

/**
 * The composition root owns process-singleton resources. Request and operation
 * state must be created below this boundary; no protocol DTOs are stored here.
 */
export function createRuntime({ env = process.env, overrides = {} } = {}) {
  const snapshot = Object.freeze({ ...env });
  validateProductionConfig(snapshot);
  const tracer = overrides.tracer ?? createConfiguredTracer({ env: snapshot });
  const runtime = {
    env: snapshot,
    authenticate: overrides.authenticate ?? createAuthenticator({ env: snapshot }),
    providers: overrides.providers ?? createProviderRuntime({ env: snapshot }),
    objectStorage: overrides.objectStorage ?? createObjectStorage({ env: snapshot }),
    tracer,
    observability: overrides.observability ?? createObservability({ env: snapshot, tracer }),
    store: overrides.store ?? (snapshot.STORE_PROVIDER === "postgres"
      ? createPostgresStore({ env: snapshot })
      : new CrmStore()),
  };
  let closePromise;
  function close() {
    closePromise ??= (async () => {
      const errors = [];
      for (const resource of [runtime.store, runtime.objectStorage, runtime.tracer]) {
        try { await resource?.close?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, "runtime resource shutdown failed");
    })();
    return closePromise;
  }
  return Object.freeze({
    ...runtime,
    close,
  });
}

/**
 * Request scope is explicit and immutable. Ports may accept this context, but
 * it never replaces protocol validation or the database transaction boundary.
 */
export function createRequestContext({ request_id, traceparent, identity, signal, deadline_at } = {}) {
  if (!request_id || !identity?.tenant_id || !identity?.actor_id) throw new Error("request context requires request_id and tenant identity");
  return Object.freeze({
    request_id,
    traceparent,
    identity: Object.freeze({ ...identity }),
    signal,
    deadline_at,
  });
}
