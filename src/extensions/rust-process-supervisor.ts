import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionManifest } from "./manifest.ts";
import {
  RUST_SUPERVISOR_LIMITS,
  RUST_SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_RESPONSE_KEYS,
  SUPERVISOR_STATES,
  type SupervisorRequest,
  type SupervisorResponse,
  type SupervisorState,
} from "./generated/runtime-supervisor-protocol.ts";

export { RUST_SUPERVISOR_PROTOCOL_VERSION };
const MAX_FRAME_BYTES = RUST_SUPERVISOR_LIMITS.maxFrameBytes;
const RESPONSE_KEYS = new Set<string>(SUPERVISOR_RESPONSE_KEYS);
const STATES = new Set<string>(SUPERVISOR_STATES);
type LaunchSpec = {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
};
type ResolveEntrypoint = (
  manifest: Readonly<ExtensionManifest>,
) => LaunchSpec | PromiseLike<LaunchSpec>;
type PendingRequest = {
  resolve: (response: SupervisorResponse) => void;
  reject: (error: unknown) => void;
};
type SpawnImpl = typeof spawn;

function abortError(
  reason: unknown,
  fallback: string,
): Error & { name: string; breakerEligible: boolean } {
  if (reason instanceof Error)
    return reason as Error & { name: string; breakerEligible: boolean };
  return Object.assign(new Error(fallback), {
    name: "AbortError",
    breakerEligible: false,
  });
}

function validateString(
  value: unknown,
  name: string,
  maxBytes: number = RUST_SUPERVISOR_LIMITS.argumentMax,
): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${name} must be a bounded string`);
  }
  return value;
}

function defaultSupervisorBinary() {
  const modulePath = fileURLToPath(import.meta.url);
  return modulePath.includes("/dist/src/")
    ? resolve(dirname(modulePath), "../../bin/sumi-runtime-supervisor")
    : resolve(
        dirname(modulePath),
        "../../target/release/sumi-runtime-supervisor",
      );
}

function normalizeLaunchSpec(
  spec: unknown,
  allowedEnvironmentKeys: ReadonlySet<string>,
): LaunchSpec {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError("extension launch resolver must return an object");
  }
  if (
    Object.keys(spec).some((key) => !["program", "args", "env"].includes(key))
  ) {
    throw new TypeError("extension launch resolver returned an unknown field");
  }
  const record = spec as Record<string, unknown>;
  const program = validateString(
    record.program,
    "extension program",
    RUST_SUPERVISOR_LIMITS.programMax,
  );
  if (!isAbsolute(program))
    throw new TypeError("extension program must be an absolute path");
  const args = record.args ?? [];
  if (!Array.isArray(args) || args.length > RUST_SUPERVISOR_LIMITS.argsMax)
    throw new TypeError("extension args exceed the supervisor bounds");
  for (const [index, arg] of args.entries())
    validateString(arg, `extension args[${index}]`);
  const env = record.env ?? {};
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.keys(env).length > RUST_SUPERVISOR_LIMITS.environmentKeysMax
  ) {
    throw new TypeError("extension env exceeds the supervisor bounds");
  }
  for (const [key, value] of Object.entries(env)) {
    if (!allowedEnvironmentKeys.has(key))
      throw new Error(`extension environment key ${key} is not allowlisted`);
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key))
      throw new TypeError("extension environment key is invalid");
    validateString(
      value,
      `extension env.${key}`,
      RUST_SUPERVISOR_LIMITS.environmentValueMax,
    );
  }
  return Object.freeze({
    program,
    args: Object.freeze([...args]),
    env: Object.freeze({ ...env }),
  }) as LaunchSpec;
}

export function validateSupervisorResponse(value: unknown): SupervisorResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("supervisor returned a non-object frame");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RESPONSE_KEYS.has(key)))
    throw new Error("supervisor returned an unknown field");
  if (record.protocol !== RUST_SUPERVISOR_PROTOCOL_VERSION)
    throw new Error("supervisor protocol version mismatch");
  if (
    typeof record.request_id !== "string" ||
    !record.request_id ||
    record.request_id.length > RUST_SUPERVISOR_LIMITS.requestIdMax
  )
    throw new Error("supervisor response omitted request_id");
  if (typeof record.ok !== "boolean" || !STATES.has(record.state as string))
    throw new Error("supervisor response shape is invalid");
  if (
    record.child_pid !== undefined &&
    (!Number.isSafeInteger(record.child_pid) ||
      (record.child_pid as number) <= 0)
  ) {
    throw new Error("supervisor child_pid is invalid");
  }
  for (const key of ["ready", "forced"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") {
      throw new Error(`supervisor ${key} is invalid`);
    }
  }
  for (const key of ["exit_code", "signal"] as const) {
    if (record[key] !== undefined && !Number.isSafeInteger(record[key])) {
      throw new Error(`supervisor ${key} is invalid`);
    }
  }
  if (typeof record.signal === "number" && record.signal < 1) {
    throw new Error("supervisor signal is invalid");
  }
  const error = record.error;
  if (error !== undefined) {
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      throw new Error("supervisor error response is invalid");
    }
    const fields = error as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !["code", "message"].includes(key)) ||
      typeof fields.code !== "string" ||
      !fields.code ||
      fields.code.length > RUST_SUPERVISOR_LIMITS.errorCodeMax ||
      typeof fields.message !== "string" ||
      !fields.message ||
      fields.message.length > RUST_SUPERVISOR_LIMITS.errorMessageMax
    ) {
      throw new Error("supervisor error response is invalid");
    }
  }
  if (!record.ok && error === undefined) {
    throw new Error("supervisor error response is invalid");
  }
  return record as unknown as SupervisorResponse;
}

/**
 * A process-isolated extension instance owned by the Rust lifecycle supervisor.
 * Business capabilities and ambient environment access are deliberately absent.
 */
export class RustSupervisedExtension {
  #allowedEnvironmentKeys: ReadonlySet<string>;
  #binaryPath: string;
  #childPid?: number;
  #exitPromise?: Promise<void>;
  #pending = new Map<string, PendingRequest>();
  #requestSequence = 0;
  #resolveEntrypoint: ResolveEntrypoint;
  #spawn: SpawnImpl;
  #state: "created" | "starting" | SupervisorState = "created";
  #stderrBytes = 0;
  #stdoutBuffer = "";
  #supervisor?: ChildProcessWithoutNullStreams;
  readonly manifest: ExtensionManifest;
  readonly shutdownGraceMs: number;
  readonly startupTimeoutMs: number;

  constructor({
    manifest,
    ports,
    binaryPath,
    resolveEntrypoint,
    allowedEnvironmentKeys,
    shutdownGraceMs,
    startupTimeoutMs,
    spawnImpl,
  }: {
    manifest: ExtensionManifest;
    ports: Record<string, unknown>;
    binaryPath: string;
    resolveEntrypoint: ResolveEntrypoint;
    allowedEnvironmentKeys: ReadonlySet<string>;
    shutdownGraceMs: number;
    startupTimeoutMs: number;
    spawnImpl: SpawnImpl;
  }) {
    if (process.platform !== "linux")
      throw new Error("Rust process supervision currently requires Linux");
    if (manifest.isolation !== "process")
      throw new TypeError("Rust supervisor requires process isolation");
    if (
      manifest.capabilities.some(
        (capability) => capability !== "runtime.health",
      )
    ) {
      throw new Error(
        "Rust supervisor capability RPC is not enabled; only runtime.health is allowed",
      );
    }
    if (Object.keys(ports).length !== 0) {
      throw new Error(
        "Rust supervisor capability RPC is not enabled; permission ports cannot cross the boundary",
      );
    }
    if (
      !Number.isSafeInteger(shutdownGraceMs) ||
      shutdownGraceMs < 1 ||
      shutdownGraceMs > RUST_SUPERVISOR_LIMITS.timeoutMax
    ) {
      throw new TypeError("shutdownGraceMs must be between 1 and 30000");
    }
    if (
      !Number.isSafeInteger(startupTimeoutMs) ||
      startupTimeoutMs < 1 ||
      startupTimeoutMs > RUST_SUPERVISOR_LIMITS.timeoutMax
    ) {
      throw new TypeError("startupTimeoutMs must be between 1 and 30000");
    }
    this.manifest = manifest;
    this.#binaryPath = binaryPath;
    this.#resolveEntrypoint = resolveEntrypoint;
    this.#allowedEnvironmentKeys = allowedEnvironmentKeys;
    this.shutdownGraceMs = shutdownGraceMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.#spawn = spawnImpl;
  }

  get state() {
    return this.#state;
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      extension_id: this.manifest.id,
      child_pid: this.#childPid,
    });
  }

  async start({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#state !== "created")
      throw new Error(`supervised extension cannot start from ${this.#state}`);
    if (signal?.aborted)
      throw abortError(signal.reason, "extension startup was aborted");
    const spec = normalizeLaunchSpec(
      await this.#resolveEntrypoint(this.manifest),
      this.#allowedEnvironmentKeys,
    );
    await access(this.#binaryPath, constants.X_OK);
    await access(spec.program, constants.X_OK);
    this.#spawnSupervisor();
    const onAbort = () => {
      void this.terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#request("start", {
        extension_id: this.manifest.id,
        program: spec.program,
        args: spec.args,
        env: spec.env,
        startup_timeout_ms: this.startupTimeoutMs,
        shutdown_grace_ms: this.shutdownGraceMs,
      });
      if (
        !response.ok ||
        response.state !== "running" ||
        response.ready !== true
      ) {
        throw new Error(
          `supervisor rejected extension start: ${response.error?.code ?? "START_FAILED"}`,
        );
      }
      this.#childPid = response.child_pid;
      this.#state = "running";
    } catch (error: unknown) {
      await this.terminate();
      throw signal?.aborted
        ? abortError(signal.reason, "extension startup was aborted")
        : error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async health(): Promise<Readonly<{ ready: boolean; reason?: string }>> {
    if (this.#state !== "running")
      return Object.freeze({
        ready: false,
        reason: `supervisor_${this.#state}`,
      });
    try {
      const response = await this.#request("health");
      if (response.state !== "running" || response.ready !== true) {
        this.#state = response.state;
        return Object.freeze({
          ready: false,
          reason: `process_${response.state}`,
        });
      }
      return Object.freeze({ ready: true });
    } catch {
      return Object.freeze({ ready: false, reason: "supervisor_unavailable" });
    }
  }

  async stop(): Promise<Readonly<{ forced: boolean }>> {
    if (this.#state === "stopped") return Object.freeze({ forced: false });
    if (!this.#supervisor || this.#supervisor.exitCode !== null) {
      this.#state = "stopped";
      return Object.freeze({ forced: false });
    }
    const response = await this.#request("stop");
    this.#state = "stopped";
    this.#supervisor.stdin.end();
    await this.#exitPromise;
    return Object.freeze({ forced: response.forced === true });
  }

  async terminate(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#childPid) {
      try {
        process.kill(-this.#childPid, "SIGKILL");
      } catch (error: unknown) {
        const code =
          error && typeof error === "object"
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== "ESRCH") throw error;
      }
    }
    if (this.#supervisor && this.#supervisor.exitCode === null) {
      this.#supervisor.kill("SIGKILL");
      await this.#exitPromise;
    }
    this.#state = "stopped";
  }

  #spawnSupervisor(): void {
    this.#supervisor = this.#spawn(this.#binaryPath, [], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const supervisor = this.#supervisor;
    this.#state = "starting";
    supervisor.stdout.setEncoding("utf8");
    supervisor.stdout.on("data", (chunk: string) => this.#receive(chunk));
    // Drain stderr to avoid a blocked trusted supervisor. Content is never
    // surfaced because an extension path or child diagnostic may be sensitive.
    supervisor.stderr.on("data", (chunk: string) => {
      this.#stderrBytes = Math.min(
        this.#stderrBytes + chunk.length,
        MAX_FRAME_BYTES,
      );
    });
    this.#exitPromise = new Promise<void>((resolveExit) => {
      supervisor.once("exit", () => {
        if (this.#state !== "stopped") this.#state = "stopped";
        const error = new Error("Rust runtime supervisor exited");
        for (const { reject } of this.#pending.values()) reject(error);
        this.#pending.clear();
        resolveExit();
      });
    });
    supervisor.once("error", (error: Error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  #receive(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (
      Buffer.byteLength(this.#stdoutBuffer) > MAX_FRAME_BYTES &&
      !this.#stdoutBuffer.includes("\n")
    ) {
      void this.terminate();
      return;
    }
    let newline;
    while ((newline = this.#stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        void this.terminate();
        continue;
      }
      let response;
      try {
        response = validateSupervisorResponse(JSON.parse(line));
      } catch (error: unknown) {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        void this.terminate();
        return;
      }
      const pending = this.#pending.get(response.request_id);
      if (!pending) {
        void this.terminate();
        return;
      }
      this.#pending.delete(response.request_id);
      pending.resolve(response);
    }
  }

  #request(
    op: SupervisorRequest["op"],
    fields: Record<string, unknown> = {},
  ): Promise<SupervisorResponse> {
    if (!this.#supervisor || this.#supervisor.exitCode !== null) {
      return Promise.reject(
        new Error("Rust runtime supervisor is not running"),
      );
    }
    const requestId = `${this.manifest.id}.${++this.#requestSequence}`;
    const frame = `${JSON.stringify({
      protocol: RUST_SUPERVISOR_PROTOCOL_VERSION,
      request_id: requestId,
      op,
      ...fields,
    })}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      return Promise.reject(
        new Error("supervisor request exceeds 65536 bytes"),
      );
    }
    const supervisor = this.#supervisor;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      supervisor.stdin.write(frame, (error) => {
        if (!error) return;
        this.#pending.delete(requestId);
        rejectRequest(error);
      });
    });
  }
}

/**
 * Creates the trusted registry launcher for process-isolated health extensions.
 * Entrypoint resolution stays deployment-owned and must return an absolute
 * executable plus explicitly allowlisted arguments and environment values.
 *
 * @param {object} options
 * @param {string} [options.binaryPath]
 * @param {(manifest: Readonly<object>) => Promise<{program: string, args?: string[], env?: Record<string, string>}> | {program: string, args?: string[], env?: Record<string, string>}} options.resolveEntrypoint
 * @param {string[]} [options.allowedEnvironmentKeys]
 * @param {number} [options.startupTimeoutMs]
 * @param {number} [options.shutdownGraceMs]
 * @param {typeof spawn} [options.spawnImpl]
 * @returns {(input: {manifest: Readonly<object>, ports: Record<string, never>}) => RustSupervisedExtension}
 */
export function createRustProcessExtensionLauncher({
  binaryPath = defaultSupervisorBinary(),
  resolveEntrypoint,
  allowedEnvironmentKeys = [],
  startupTimeoutMs = 2_000,
  shutdownGraceMs = 2_000,
  spawnImpl = spawn,
}: {
  binaryPath?: string;
  resolveEntrypoint?: ResolveEntrypoint;
  allowedEnvironmentKeys?: readonly string[];
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  spawnImpl?: SpawnImpl;
} = {}): (input: {
  manifest: ExtensionManifest;
  ports: Record<string, unknown>;
}) => RustSupervisedExtension {
  if (!isAbsolute(binaryPath))
    throw new TypeError("Rust supervisor binaryPath must be absolute");
  if (typeof resolveEntrypoint !== "function")
    throw new TypeError("resolveEntrypoint must be a trusted function");
  if (
    !Array.isArray(allowedEnvironmentKeys) ||
    allowedEnvironmentKeys.some((key) => typeof key !== "string")
  ) {
    throw new TypeError("allowedEnvironmentKeys must be a string array");
  }
  const allowed = new Set(allowedEnvironmentKeys);
  return ({
    manifest,
    ports,
  }: {
    manifest: ExtensionManifest;
    ports: Record<string, unknown>;
  }) =>
    new RustSupervisedExtension({
      manifest,
      ports,
      binaryPath,
      resolveEntrypoint,
      allowedEnvironmentKeys: allowed,
      startupTimeoutMs,
      shutdownGraceMs,
      spawnImpl,
    });
}
