import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUST_SUPERVISOR_PROTOCOL_VERSION = "sumi.runtime.supervisor.v1";
const MAX_FRAME_BYTES = 64 * 1024;
const RESPONSE_KEYS = new Set([
  "protocol",
  "request_id",
  "ok",
  "state",
  "ready",
  "child_pid",
  "forced",
  "exit_code",
  "signal",
  "error",
]);
const STATES = new Set(["created", "running", "stopped", "failed"]);

function abortError(reason, fallback) {
  if (reason instanceof Error) return reason;
  return Object.assign(new Error(fallback), {
    name: "AbortError",
    breakerEligible: false,
  });
}

function validateString(value, name, maxBytes = 4096) {
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

function normalizeLaunchSpec(spec, allowedEnvironmentKeys) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError("extension launch resolver must return an object");
  }
  if (
    Object.keys(spec).some((key) => !["program", "args", "env"].includes(key))
  ) {
    throw new TypeError("extension launch resolver returned an unknown field");
  }
  const program = validateString(spec.program, "extension program");
  if (!isAbsolute(program))
    throw new TypeError("extension program must be an absolute path");
  const args = spec.args ?? [];
  if (!Array.isArray(args) || args.length > 64)
    throw new TypeError("extension args exceed the supervisor bounds");
  for (const [index, arg] of args.entries())
    validateString(arg, `extension args[${index}]`);
  const env = spec.env ?? {};
  if (
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    Object.keys(env).length > 32
  ) {
    throw new TypeError("extension env exceeds the supervisor bounds");
  }
  for (const [key, value] of Object.entries(env)) {
    if (!allowedEnvironmentKeys.has(key))
      throw new Error(`extension environment key ${key} is not allowlisted`);
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key))
      throw new TypeError("extension environment key is invalid");
    validateString(value, `extension env.${key}`, 8192);
  }
  return Object.freeze({
    program,
    args: Object.freeze([...args]),
    env: Object.freeze({ ...env }),
  });
}

function validateResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("supervisor returned a non-object frame");
  if (Object.keys(value).some((key) => !RESPONSE_KEYS.has(key)))
    throw new Error("supervisor returned an unknown field");
  if (value.protocol !== RUST_SUPERVISOR_PROTOCOL_VERSION)
    throw new Error("supervisor protocol version mismatch");
  if (typeof value.request_id !== "string" || !value.request_id)
    throw new Error("supervisor response omitted request_id");
  if (typeof value.ok !== "boolean" || !STATES.has(value.state))
    throw new Error("supervisor response shape is invalid");
  if (
    value.child_pid !== undefined &&
    (!Number.isSafeInteger(value.child_pid) || value.child_pid <= 0)
  ) {
    throw new Error("supervisor child_pid is invalid");
  }
  if (!value.ok && (!value.error || typeof value.error.code !== "string")) {
    throw new Error("supervisor error response is invalid");
  }
  return value;
}

/**
 * A process-isolated extension instance owned by the Rust lifecycle supervisor.
 * Business capabilities and ambient environment access are deliberately absent.
 */
export class RustSupervisedExtension {
  #allowedEnvironmentKeys;
  #binaryPath;
  #childPid;
  #exitPromise;
  #pending = new Map();
  #requestSequence = 0;
  #resolveEntrypoint;
  #spawn;
  #state = "created";
  #stderrBytes = 0;
  #stdoutBuffer = "";
  #supervisor;

  constructor({
    manifest,
    ports,
    binaryPath,
    resolveEntrypoint,
    allowedEnvironmentKeys,
    shutdownGraceMs,
    startupTimeoutMs,
    spawnImpl,
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
      shutdownGraceMs > 30_000
    ) {
      throw new TypeError("shutdownGraceMs must be between 1 and 30000");
    }
    if (
      !Number.isSafeInteger(startupTimeoutMs) ||
      startupTimeoutMs < 1 ||
      startupTimeoutMs > 30_000
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

  async start({ signal } = {}) {
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
    } catch (error) {
      await this.terminate();
      throw signal?.aborted
        ? abortError(signal.reason, "extension startup was aborted")
        : error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async health() {
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

  async stop() {
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

  async terminate() {
    if (this.#state === "stopped") return;
    if (this.#childPid) {
      try {
        process.kill(-this.#childPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    if (this.#supervisor && this.#supervisor.exitCode === null) {
      this.#supervisor.kill("SIGKILL");
      await this.#exitPromise;
    }
    this.#state = "stopped";
  }

  #spawnSupervisor() {
    this.#supervisor = this.#spawn(this.#binaryPath, [], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#state = "starting";
    this.#supervisor.stdout.setEncoding("utf8");
    this.#supervisor.stdout.on("data", (chunk) => this.#receive(chunk));
    // Drain stderr to avoid a blocked trusted supervisor. Content is never
    // surfaced because an extension path or child diagnostic may be sensitive.
    this.#supervisor.stderr.on("data", (chunk) => {
      this.#stderrBytes = Math.min(
        this.#stderrBytes + chunk.length,
        MAX_FRAME_BYTES,
      );
    });
    this.#exitPromise = new Promise((resolveExit) => {
      this.#supervisor.once("exit", () => {
        if (this.#state !== "stopped") this.#state = "stopped";
        const error = new Error("Rust runtime supervisor exited");
        for (const { reject } of this.#pending.values()) reject(error);
        this.#pending.clear();
        resolveExit();
      });
    });
    this.#supervisor.once("error", (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  #receive(chunk) {
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
        response = validateResponse(JSON.parse(line));
      } catch (error) {
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

  #request(op, fields = {}) {
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
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      this.#supervisor.stdin.write(frame, (error) => {
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
} = {}) {
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
  return ({ manifest, ports }) =>
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
