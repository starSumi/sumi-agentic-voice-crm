import { runWithStagedTimeout } from "../lifecycle/staged-timeout.ts";
import { validateExtensionManifest, type ExtensionManifest } from "./manifest.ts";

type ExtensionInstance = {
  start?: (options: { signal: AbortSignal }) => unknown | PromiseLike<unknown>;
  stop?: (options: { signal: AbortSignal }) => unknown | PromiseLike<unknown>;
  terminate?: () => unknown | PromiseLike<unknown>;
  health?: (options: { signal: AbortSignal }) => { ready?: boolean; reason?: string } | PromiseLike<{ ready?: boolean; reason?: string }>;
};
type ExtensionPorts = Readonly<Record<string, unknown>>;
type ExtensionFactoryInput = { manifest: ExtensionManifest; ports: ExtensionPorts; signal: AbortSignal };
type ExtensionFactory = (input: ExtensionFactoryInput) => ExtensionInstance | PromiseLike<ExtensionInstance>;
type ExtensionDescriptor = { manifest: ExtensionManifest; factory: ExtensionFactory };
type ExtensionContext = { signal?: AbortSignal; [key: string]: unknown };
type ExtensionRegistryOptions = {
  allowedPermissions?: readonly string[];
  trustedInProcessIds?: readonly string[];
  softTimeoutMs?: number;
  hardGraceMs?: number;
  permissionPorts?: Record<string, unknown>;
};
type ExtensionRegistration = { manifest: unknown; create?: ExtensionFactory; launch?: ExtensionFactory };
type ExtensionState = "created" | "starting" | "started" | "stopping" | "stopped" | "failed";

function dependencyOrder(descriptors: ReadonlyMap<string, ExtensionDescriptor>): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`extension dependency cycle includes ${id}`);
    const descriptor = descriptors.get(id);
    if (!descriptor) throw new Error(`extension dependency ${id} is not registered`);
    visiting.add(id);
    for (const dependency of descriptor.manifest.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }
  for (const id of descriptors.keys()) visit(id);
  return ordered;
}

function startupRollbackError(startupError: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [startupError, cleanupError],
    "extension startup and rollback failed",
    { cause: startupError },
  );
}

export class ExtensionRegistry {
  #descriptors = new Map<string, ExtensionDescriptor>();
  #instances = new Map<string, ExtensionInstance>();
  #started: string[] = [];
  #state: ExtensionState = "created";
  #allowedPermissions: Set<string>;
  #trustedInProcessIds: Set<string>;
  #softTimeoutMs?: number;
  #hardGraceMs?: number;
  #startPromise?: Promise<void>;
  #stopPromise?: Promise<void>;
  #startupController?: AbortController;
  #permissionPorts: ExtensionPorts;

  constructor({
    allowedPermissions = [],
    trustedInProcessIds = [],
    softTimeoutMs,
    hardGraceMs,
    permissionPorts = {},
  }: ExtensionRegistryOptions = {}) {
    this.#allowedPermissions = new Set(allowedPermissions);
    this.#trustedInProcessIds = new Set(trustedInProcessIds);
    this.#softTimeoutMs = softTimeoutMs;
    this.#hardGraceMs = hardGraceMs;
    this.#permissionPorts = Object.freeze({ ...permissionPorts });
  }

  get state() { return this.#state; }

  register({ manifest: input, create, launch }: ExtensionRegistration): ExtensionManifest {
    if (this.#state !== "created") throw new Error("extensions can only be registered before startup");
    const manifest = validateExtensionManifest(input);
    if (this.#descriptors.has(manifest.id)) throw new Error(`extension ${manifest.id} is already registered`);
    const factory = manifest.isolation === "process" ? launch : create;
    if (manifest.isolation === "process" && create !== undefined) throw new TypeError("process extension must use a trusted launch supervisor, not create");
    if (manifest.isolation === "in-process" && launch !== undefined) throw new TypeError("in-process extension must use create");
    if (typeof factory !== "function") throw new TypeError(`extension ${manifest.isolation === "process" ? "launch" : "create"} must be a function`);
    if (manifest.permissions.some((permission) => !this.#allowedPermissions.has(permission))) {
      throw new Error(`extension ${manifest.id} requests a permission outside the deployment allowlist`);
    }
    if (manifest.isolation === "in-process" && !this.#trustedInProcessIds.has(manifest.id)) {
      throw new Error(`extension ${manifest.id} is not trusted for in-process execution`);
    }
    this.#descriptors.set(manifest.id, Object.freeze({ manifest, factory: factory as ExtensionFactory }));
    return manifest;
  }

  manifests(): ExtensionManifest[] {
    return [...this.#descriptors.values()].map(({ manifest }) => manifest);
  }

  capability(name: string): Array<Readonly<{ manifest: ExtensionManifest; instance: ExtensionInstance | undefined }>> {
    if (this.#state !== "started") return [];
    return this.#started
      .filter((id) => this.#descriptors.get(id)?.manifest.capabilities.includes(name))
      .map((id) => Object.freeze({
        manifest: this.#descriptors.get(id)!.manifest,
        instance: this.#instances.get(id),
      }));
  }

  startAll(context: ExtensionContext = {}): Promise<void> {
    if (this.#state === "started") return Promise.resolve();
    if (this.#state === "starting") return this.#startPromise!;
    if (this.#state !== "created") throw new Error(`extension registry cannot start from ${this.#state}`);
    const order = dependencyOrder(this.#descriptors);
    this.#state = "starting";
    this.#startupController = new AbortController();
    const startupController = this.#startupController;
    const onAbort = () => startupController.abort(context.signal?.reason);
    if (context.signal?.aborted) onAbort();
    else context.signal?.addEventListener("abort", onAbort, { once: true });
    this.#startPromise = (async () => {
      try {
        for (const id of order) {
          const descriptor = this.#descriptors.get(id)!;
          const ports = Object.freeze(Object.fromEntries(
            descriptor.manifest.permissions
              .filter((permission) => Object.hasOwn(this.#permissionPorts, permission))
              .map((permission) => [permission, this.#permissionPorts[permission]]),
          ));
          let instance: ExtensionInstance | undefined;
          await runWithStagedTimeout(
            async (signal) => {
              instance = await descriptor.factory(Object.freeze({
                manifest: descriptor.manifest,
                ports,
                signal,
              }));
            if (!instance || typeof instance !== "object") throw new TypeError(`extension ${id} factory returned no instance`);
            if (descriptor.manifest.isolation === "process" && typeof instance.terminate !== "function") {
              throw new TypeError(`process extension ${id} must expose terminate()`);
            }
            this.#instances.set(id, instance);
            this.#started.push(id);
            await instance.start?.({ signal });
            },
            {
              signal: startupController.signal,
              label: `extension ${id} startup`,
              softTimeoutMs: this.#softTimeoutMs,
              hardGraceMs: this.#hardGraceMs,
              onHardTimeout: () => { void instance?.terminate?.(); },
            },
          );
        }
        this.#state = "started";
      } catch (error: unknown) {
        let cleanupError: unknown;
        try { await this.#stopStarted(); } catch (caught: unknown) { cleanupError = caught; }
        this.#state = "failed";
        if (cleanupError) throw startupRollbackError(error, cleanupError);
        throw error;
      } finally {
        context.signal?.removeEventListener("abort", onAbort);
      }
    })();
    return this.#startPromise;
  }

  async health({ signal }: { signal?: AbortSignal } = {}): Promise<Readonly<Record<string, { ready: boolean; reason?: string }>>> {
    const result: Record<string, { ready: boolean; reason?: string }> = {};
    await Promise.all(this.#started.map(async (id) => {
      const instance = this.#instances.get(id)!;
      try {
        const health = await runWithStagedTimeout(
          (operationSignal) => instance.health?.({ signal: operationSignal }),
          {
            signal,
            label: `extension ${id} health`,
            softTimeoutMs: this.#softTimeoutMs,
            hardGraceMs: this.#hardGraceMs,
            onHardTimeout: () => { void instance?.terminate?.(); },
          },
        );
        const healthResult = health as { ready?: boolean; reason?: string } | undefined;
        result[id] = Object.freeze({ ready: healthResult?.ready !== false, reason: healthResult?.reason });
      } catch {
        result[id] = Object.freeze({ ready: false, reason: "health_check_failed" });
      }
    }));
    return Object.freeze(result);
  }

  async #stopStarted({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const errors: unknown[] = [];
    for (const id of this.#started.toReversed()) {
      const descriptor = this.#descriptors.get(id)!;
      const instance = this.#instances.get(id)!;
      try {
        await runWithStagedTimeout(
          (operationSignal) => instance.stop
            ? instance.stop({ signal: operationSignal })
            : descriptor.manifest.isolation === "process"
              ? instance.terminate?.()
              : undefined,
          {
            signal,
            label: `extension ${id} shutdown`,
            softTimeoutMs: this.#softTimeoutMs,
            hardGraceMs: this.#hardGraceMs,
            onHardTimeout: () => { void instance.terminate?.(); },
          },
        );
      } catch (error: unknown) {
        if (descriptor.manifest.isolation === "process") {
          try { await instance.terminate?.(); } catch {}
        }
        errors.push(error);
      }
    }
    this.#started = [];
    this.#instances.clear();
    if (errors.length) throw new AggregateError(errors, "extension shutdown failed");
  }

  stopAll({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#state === "stopped") return Promise.resolve();
    if (this.#state === "stopping") return this.#stopPromise!;
    this.#stopPromise = (async () => {
      if (this.#state === "starting") {
        this.#startupController?.abort(Object.assign(new Error("extension registry is stopping"), { name: "AbortError" }));
        try { await this.#startPromise; } catch {}
      }
      this.#state = "stopping";
      await this.#stopStarted({ signal });
      this.#state = "stopped";
    })();
    return this.#stopPromise;
  }

  close(options?: { signal?: AbortSignal }): Promise<void> {
    return this.stopAll(options);
  }
}

export function createExtensionRegistry(options?: ExtensionRegistryOptions): ExtensionRegistry {
  return new ExtensionRegistry(options);
}
