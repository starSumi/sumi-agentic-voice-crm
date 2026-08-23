import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionManifest } from "./manifest.ts";
import {
  RUST_SUPERVISOR_LIMITS,
  RUST_SUPERVISOR_PROTOCOL_VERSION,
  type SupervisorResponse,
  type SupervisorState,
} from "./generated/runtime-supervisor-protocol.ts";

export { RUST_SUPERVISOR_PROTOCOL_VERSION };
const MAX_FRAME_CONTENT_BYTES = RUST_SUPERVISOR_LIMITS.maxFrameBytes;
const RESPONSE_KEYS = new Set(["jsonrpc", "id", "result", "error"]);
const RESULT_KEYS = new Set([
  "state",
  "ready",
  "child_pid",
  "forced",
  "exit_code",
  "signal",
]);
const ERROR_KEYS = new Set(["code", "message", "data"]);
const ERROR_DATA_KEYS = new Set(["state", "detail"]);
const STATES = new Set(["created", "running", "stopped", "failed"]);
type SupervisorOperation = "start" | "health" | "stop";
type LaunchSpec = {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
};
type ResolveEntrypoint = (
  manifest: Readonly<ExtensionManifest>,
) => LaunchSpec | PromiseLike<LaunchSpec>;
type PendingRequest = {
  operation: SupervisorOperation;
  resolve: (response: SupervisorResponse) => void;
  reject: (error: unknown) => void;
};
type SpawnImpl = typeof spawn;
type KillProcessGroupImpl = (childPid: number) => void;
type StopResult = Readonly<{ forced: boolean }>;

function killProcessGroup(childPid: number): void {
  process.kill(-childPid, "SIGKILL");
}

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
  maxCharacters: number = RUST_SUPERVISOR_LIMITS.argumentMax,
): string {
  if (typeof value !== "string" || unicodeLength(value) > maxCharacters) {
    throw new TypeError(`${name} must be a bounded string`);
  }
  return value;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
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

function validResponseId(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      unicodeLength(value) >= 1 &&
      unicodeLength(value) <= RUST_SUPERVISOR_LIMITS.requestIdMax) ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      Math.abs(value) <= RUST_SUPERVISOR_LIMITS.safeIntegerMax)
  );
}

function validInt32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= -2_147_483_648 &&
    value <= 2_147_483_647
  );
}

export function validateSupervisorResponse(
  value: unknown,
  operation?: SupervisorOperation,
): SupervisorResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("supervisor returned a non-object frame");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !RESPONSE_KEYS.has(key)))
    throw new Error("supervisor returned an unknown field");
  if (record.jsonrpc !== "2.0")
    throw new Error("supervisor JSON-RPC version mismatch");
  if (!Object.hasOwn(record, "id") || !validResponseId(record.id))
    throw new Error("supervisor response id is invalid");
  const result = record.result;
  if (result !== undefined) {
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("supervisor result is invalid");
    const fields = result as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !RESULT_KEYS.has(key)))
      throw new Error("supervisor result contains an unknown field");
    if (!STATES.has(fields.state as string))
      throw new Error("supervisor response state is invalid");
    if (
      fields.child_pid !== undefined &&
      (!Number.isSafeInteger(fields.child_pid) ||
        (fields.child_pid as number) < 2 ||
        (fields.child_pid as number) > 4_294_967_295)
    )
      throw new Error("supervisor child_pid is invalid");
    for (const key of ["ready", "forced"] as const)
      if (fields[key] !== undefined && typeof fields[key] !== "boolean")
        throw new Error(`supervisor ${key} is invalid`);
    for (const key of ["exit_code", "signal"] as const)
      if (fields[key] !== undefined && !validInt32(fields[key]))
        throw new Error(`supervisor ${key} is invalid`);
    if (typeof fields.signal === "number" && fields.signal < 1)
      throw new Error("supervisor signal is invalid");
    if (operation === "start") {
      if (
        fields.state !== "running" ||
        fields.ready !== true ||
        typeof fields.child_pid !== "number"
      )
        throw new Error("supervisor start result is invalid");
    } else if (operation === "health") {
      if (
        typeof fields.ready !== "boolean" ||
        fields.ready !== (fields.state === "running") ||
        (fields.state === "running" && typeof fields.child_pid !== "number")
      )
        throw new Error("supervisor health result is invalid");
    } else if (operation === "stop") {
      if (
        fields.state !== "stopped" ||
        fields.ready !== false ||
        typeof fields.forced !== "boolean"
      )
        throw new Error("supervisor stop result is invalid");
    }
  }
  const error = record.error;
  if (error !== undefined) {
    if (!error || typeof error !== "object" || Array.isArray(error))
      throw new Error("supervisor error response is invalid");
    const fields = error as Record<string, unknown>;
    if (
      Object.keys(fields).some((key) => !ERROR_KEYS.has(key)) ||
      !validInt32(fields.code) ||
      typeof fields.message !== "string" ||
      unicodeLength(fields.message) < 1 ||
      unicodeLength(fields.message) > RUST_SUPERVISOR_LIMITS.errorMessageMax ||
      !fields.data ||
      typeof fields.data !== "object" ||
      Array.isArray(fields.data)
    )
      throw new Error("supervisor error response is invalid");
    const data = fields.data as Record<string, unknown>;
    if (
      Object.keys(data).some((key) => !ERROR_DATA_KEYS.has(key)) ||
      !STATES.has(data.state as string) ||
      (data.detail !== undefined &&
        (typeof data.detail !== "string" ||
          unicodeLength(data.detail) > RUST_SUPERVISOR_LIMITS.errorMessageMax))
    )
      throw new Error("supervisor error data is invalid");
  }
  if ((result === undefined) === (error === undefined))
    throw new Error(
      "supervisor response must contain exactly one result or error",
    );
  return record as unknown as SupervisorResponse;
}

function responseResult(response: SupervisorResponse) {
  return "result" in response ? response.result : undefined;
}

function responseErrorCode(response: SupervisorResponse): string | number {
  return "error" in response ? response.error.code : "START_FAILED";
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
  #killProcessGroup: KillProcessGroupImpl;
  #spawn: SpawnImpl;
  #state: "created" | "starting" | SupervisorState = "created";
  #stderrBytes = 0;
  #stopPromise?: Promise<StopResult>;
  #stdoutBuffer = "";
  #supervisor?: ChildProcessWithoutNullStreams;
  #terminationPromise?: Promise<void>;
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
    killProcessGroupImpl,
  }: {
    manifest: ExtensionManifest;
    ports: Record<string, unknown>;
    binaryPath: string;
    resolveEntrypoint: ResolveEntrypoint;
    allowedEnvironmentKeys: ReadonlySet<string>;
    shutdownGraceMs: number;
    startupTimeoutMs: number;
    spawnImpl: SpawnImpl;
    killProcessGroupImpl: KillProcessGroupImpl;
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
    this.#killProcessGroup = killProcessGroupImpl;
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
    this.#state = "starting";
    const onAbort = () => {
      void this.terminate().catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const spec = normalizeLaunchSpec(
        await this.#resolveEntrypoint(this.manifest),
        this.#allowedEnvironmentKeys,
      );
      this.#assertStartActive(signal);
      await Promise.all([
        access(this.#binaryPath, constants.X_OK),
        access(spec.program, constants.X_OK),
      ]);
      this.#assertStartActive(signal);
      this.#spawnSupervisor();
      this.#assertStartActive(signal);
      const response = await this.#request("start", {
        extension_id: this.manifest.id,
        program: spec.program,
        args: spec.args,
        env: spec.env,
        startup_timeout_ms: this.startupTimeoutMs,
        shutdown_grace_ms: this.shutdownGraceMs,
      });
      this.#assertStartActive(signal);
      const result = responseResult(response);
      if (!result) {
        throw new Error(
          `supervisor rejected extension start: ${responseErrorCode(response)}`,
        );
      }
      this.#childPid = result.child_pid;
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
      const result = responseResult(response);
      if (!result || result.state !== "running" || result.ready !== true) {
        this.#state = result?.state ?? "failed";
        return Object.freeze({
          ready: false,
          reason: `process_${result?.state ?? "failed"}`,
        });
      }
      return Object.freeze({ ready: true });
    } catch {
      return Object.freeze({ ready: false, reason: "supervisor_unavailable" });
    }
  }

  async stop(): Promise<StopResult> {
    if (this.#stopPromise) return this.#stopPromise;
    const stopping = this.#stopOwned();
    this.#stopPromise = stopping;
    try {
      return await stopping;
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    }
  }

  async #stopOwned(): Promise<StopResult> {
    if (this.#terminationPromise) {
      await this.#terminationPromise;
      return Object.freeze({ forced: true });
    }
    if (this.#state === "stopped") return Object.freeze({ forced: false });
    if (this.#state === "starting") {
      await this.terminate();
      return Object.freeze({ forced: true });
    }
    if (this.#childPid !== undefined && !this.#supervisor) {
      await this.terminate();
      return Object.freeze({ forced: true });
    }
    if (!this.#supervisor || this.#supervisor.exitCode !== null) {
      this.#state = "stopped";
      return Object.freeze({ forced: false });
    }
    try {
      const response = await this.#request("stop");
      const result = responseResult(response);
      if (!result)
        throw new Error(
          `supervisor rejected extension stop: ${responseErrorCode(response)}`,
        );
      this.#state = "stopped";
      this.#supervisor?.stdin.end();
      await this.#exitPromise;
      return Object.freeze({ forced: result.forced === true });
    } catch (error: unknown) {
      await this.terminate();
      throw error;
    }
  }

  async terminate(): Promise<void> {
    if (this.#terminationPromise) return this.#terminationPromise;
    if (
      this.#state === "stopped" &&
      this.#childPid === undefined &&
      (!this.#supervisor || this.#supervisor.exitCode !== null)
    )
      return;
    this.#state = "stopped";
    const termination = Promise.resolve().then(async () => {
      let cleanupError: unknown;
      try {
        this.#killOwnedProcessGroup();
      } catch (error: unknown) {
        cleanupError = error;
      }
      try {
        if (this.#supervisor && this.#supervisor.exitCode === null) {
          this.#supervisor.kill("SIGKILL");
          await this.#exitPromise;
        }
      } catch (error: unknown) {
        cleanupError = cleanupError
          ? new AggregateError(
              [cleanupError, error],
              "supervised process termination failed",
            )
          : error;
      }
      if (!cleanupError) this.#childPid = undefined;
      if (cleanupError) {
        this.#state = "failed";
        throw cleanupError;
      }
    });
    this.#terminationPromise = termination;
    try {
      await termination;
    } finally {
      if (this.#terminationPromise === termination)
        this.#terminationPromise = undefined;
    }
  }

  #assertStartActive(signal?: AbortSignal): void {
    if (signal?.aborted)
      throw abortError(signal.reason, "extension startup was aborted");
    if (this.#state !== "starting")
      throw new Error(`supervised extension startup ended in ${this.#state}`);
  }

  #killOwnedProcessGroup(): void {
    if (this.#childPid === undefined) return;
    try {
      this.#killProcessGroup(this.#childPid);
    } catch (error: unknown) {
      const code =
        error && typeof error === "object"
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ESRCH") throw error;
    }
  }

  #spawnSupervisor(): void {
    this.#supervisor = this.#spawn(this.#binaryPath, [], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const supervisor = this.#supervisor;
    supervisor.stdout.setEncoding("utf8");
    supervisor.stdout.on("data", (chunk: string) => this.#receive(chunk));
    // Drain stderr to avoid a blocked trusted supervisor. Content is never
    // surfaced because an extension path or child diagnostic may be sensitive.
    supervisor.stderr.on("data", (chunk: string) => {
      this.#stderrBytes = Math.min(
        this.#stderrBytes + chunk.length,
        MAX_FRAME_CONTENT_BYTES,
      );
    });
    this.#exitPromise = new Promise<void>((resolveExit) => {
      supervisor.once("close", () => {
        let closeError: Error = new Error("Rust runtime supervisor exited");
        let processGroupSettled = true;
        if (this.#state !== "stopped") {
          try {
            this.#killOwnedProcessGroup();
          } catch (error: unknown) {
            processGroupSettled = false;
            closeError = new AggregateError(
              [closeError, error],
              "Rust runtime supervisor exited and process-group cleanup failed",
            );
          }
          this.#state = processGroupSettled ? "stopped" : "failed";
        }
        for (const { reject } of this.#pending.values()) reject(closeError);
        this.#pending.clear();
        if (processGroupSettled && !this.#terminationPromise)
          this.#childPid = undefined;
        if (this.#supervisor === supervisor) this.#supervisor = undefined;
        resolveExit();
      });
    });
    supervisor.once("error", (error: Error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      if (this.#state !== "stopped") this.#state = "failed";
    });
  }

  #receive(chunk: string): void {
    let remaining = chunk;
    while (remaining.length > 0) {
      const newline = remaining.indexOf("\n");
      const segment = newline === -1 ? remaining : remaining.slice(0, newline);
      if (
        Buffer.byteLength(this.#stdoutBuffer) + Buffer.byteLength(segment) >
        MAX_FRAME_CONTENT_BYTES
      ) {
        this.#failProtocol(
          new Error("supervisor response exceeds 65536 bytes"),
        );
        return;
      }
      this.#stdoutBuffer += segment;
      if (newline === -1) return;
      const line = this.#stdoutBuffer;
      this.#stdoutBuffer = "";
      remaining = remaining.slice(newline + 1);
      if (line.length === 0) continue;
      let response;
      try {
        response = validateSupervisorResponse(JSON.parse(line));
      } catch (error: unknown) {
        this.#failProtocol(error);
        return;
      }
      const pending = this.#pending.get(String(response.id));
      if (!pending) {
        this.#failProtocol(new Error("supervisor response id is not pending"));
        return;
      }
      try {
        validateSupervisorResponse(response, pending.operation);
      } catch (error: unknown) {
        this.#failProtocol(error);
        return;
      }
      if (pending.operation === "start")
        this.#childPid = responseResult(response)?.child_pid;
      this.#pending.delete(String(response.id));
      pending.resolve(response);
    }
  }

  #failProtocol(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#stdoutBuffer = "";
    void this.terminate().catch(() => {});
  }

  #request(
    op: SupervisorOperation,
    fields: Record<string, unknown> = {},
  ): Promise<SupervisorResponse> {
    if (!this.#supervisor || this.#supervisor.exitCode !== null) {
      return Promise.reject(
        new Error("Rust runtime supervisor is not running"),
      );
    }
    const requestId = `${this.manifest.id}.${++this.#requestSequence}`;
    const method = `runtime.${op}`;
    const content = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params: fields,
    });
    if (Buffer.byteLength(content) > MAX_FRAME_CONTENT_BYTES) {
      return Promise.reject(
        new Error("supervisor request exceeds 65536 bytes"),
      );
    }
    const frame = `${content}\n`;
    const supervisor = this.#supervisor;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(requestId, {
        operation: op,
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
 * @param {(childPid: number) => void} [options.killProcessGroupImpl]
 * @returns {(input: {manifest: Readonly<object>, ports: Record<string, never>}) => RustSupervisedExtension}
 */
export function createRustProcessExtensionLauncher({
  binaryPath = defaultSupervisorBinary(),
  resolveEntrypoint,
  allowedEnvironmentKeys = [],
  startupTimeoutMs = 2_000,
  shutdownGraceMs = 2_000,
  spawnImpl = spawn,
  killProcessGroupImpl = killProcessGroup,
}: {
  binaryPath?: string;
  resolveEntrypoint?: ResolveEntrypoint;
  allowedEnvironmentKeys?: readonly string[];
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  spawnImpl?: SpawnImpl;
  killProcessGroupImpl?: KillProcessGroupImpl;
} = {}): (input: {
  manifest: ExtensionManifest;
  ports: Record<string, unknown>;
}) => RustSupervisedExtension {
  if (!isAbsolute(binaryPath))
    throw new TypeError("Rust supervisor binaryPath must be absolute");
  if (typeof resolveEntrypoint !== "function")
    throw new TypeError("resolveEntrypoint must be a trusted function");
  if (typeof killProcessGroupImpl !== "function")
    throw new TypeError("killProcessGroupImpl must be a trusted function");
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
      killProcessGroupImpl,
    });
}
