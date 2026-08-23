import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { createRuntime } from "../src/composition-root.ts";
import {
  createExtensionRegistry,
  createRustProcessExtensionLauncher,
  RUST_SUPERVISOR_PROTOCOL_VERSION,
  validateSupervisorResponse,
} from "../src/extensions/index.ts";
import { RUST_SUPERVISOR_LIMITS } from "../src/extensions/generated/runtime-supervisor-protocol.ts";
import type { ExtensionManifest } from "../src/extensions/manifest.ts";

const binaryPath = resolve("target/release/sumi-runtime-supervisor");
const addFormats = createRequire(import.meta.url)(
  "ajv-formats",
) as FormatsPlugin;

function unicodeBoundary(character: string, maximum: number) {
  return {
    atLimit: character.repeat(maximum),
    overLimit: character.repeat(maximum + 1),
  } as const;
}

function manifest(id = "fixture.health"): ExtensionManifest {
  return {
    schema_version: "sumi.extension-manifest.v1",
    id,
    version: "1.0.0",
    protocol_version: "sumi.runtime.extension.v1",
    owner: "Sumi tests",
    isolation: "process",
    entrypoint: `fixture:${id}`,
    capabilities: ["runtime.health"],
    permissions: [],
    dependencies: [],
  };
}

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "sumi-rust-supervisor-"));
  const script = join(root, "extension.mjs");
  await writeFile(script, source);
  return { root, script };
}

async function waitForExit(pid: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`process ${pid} remained alive`);
}

type SpawnImpl = typeof import("node:child_process").spawn;
type RequestFrame = {
  id: string | number;
  method: "runtime.start" | "runtime.health" | "runtime.stop";
};

class FakeSupervisor extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  #closed = false;

  constructor(
    handleRequest: (request: RequestFrame, supervisor: FakeSupervisor) => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          const request = JSON.parse(String(chunk).trim()) as RequestFrame;
          handleRequest(request, this);
          callback();
        } catch (error: unknown) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  }

  respond(response: unknown, tail = ""): void {
    this.stdout.write(`${JSON.stringify(response)}\n${tail}`);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.exitCode = 0;
    this.emit("close", 0, null);
  }

  kill(): boolean {
    this.close();
    return true;
  }
}

function fakeSpawn(
  handleRequest: (request: RequestFrame, supervisor: FakeSupervisor) => void,
  onSpawn?: (supervisor: FakeSupervisor) => void,
): { spawnImpl: SpawnImpl; supervisors: FakeSupervisor[] } {
  const supervisors: FakeSupervisor[] = [];
  const spawnImpl = (() => {
    const supervisor = new FakeSupervisor(handleRequest);
    supervisors.push(supervisor);
    onSpawn?.(supervisor);
    return supervisor;
  }) as unknown as SpawnImpl;
  return { spawnImpl, supervisors };
}

function lifecycleResponse(
  request: RequestFrame,
  supervisor: FakeSupervisor,
): void {
  if (request.method === "runtime.start") {
    supervisor.respond({
      jsonrpc: "2.0",
      id: request.id,
      result: { state: "running", ready: true, child_pid: 42_424 },
    });
    return;
  }
  if (request.method === "runtime.health") {
    supervisor.respond({
      jsonrpc: "2.0",
      id: request.id,
      result: { state: "running", ready: true, child_pid: 42_424 },
    });
    return;
  }
  supervisor.respond({
    jsonrpc: "2.0",
    id: request.id,
    result: { state: "stopped", ready: false, forced: false, exit_code: 0 },
  });
  queueMicrotask(() => supervisor.close());
}

test.before(async () => {
  await access(binaryPath, constants.X_OK);
});

test("Rust supervisor protocol version is bound across binary and Node adapter", async () => {
  const { execFile } = await import("node:child_process");
  const output = await new Promise((resolveOutput, rejectOutput) => {
    execFile(
      binaryPath,
      ["--protocol-version"],
      { encoding: "utf8", env: {} },
      (error, stdout) => {
        if (error) rejectOutput(error);
        else resolveOutput(stdout.trim());
      },
    );
  });
  assert.equal(output, RUST_SUPERVISOR_PROTOCOL_VERSION);
});

test("supervisor protocol fixtures conform to the committed closed schema", async () => {
  const schema = JSON.parse(
    await readFile("contracts/runtime-supervisor.schema.json", "utf8"),
  );
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  ajv.addFormat("int64", true);
  ajv.addFormat("uint64", true);
  ajv.addFormat("int32", true);
  ajv.addFormat("uint32", true);
  const validate = ajv.compile(schema);
  const start = {
    jsonrpc: "2.0",
    id: "fixture.start.1",
    method: "runtime.start",
    params: {
      extension_id: "fixture.health",
      program: process.execPath,
      args: [],
      env: {},
      startup_timeout_ms: 2_000,
      shutdown_grace_ms: 2_000,
    },
  };
  const requestId = unicodeBoundary("界", RUST_SUPERVISOR_LIMITS.requestIdMax);
  const program = unicodeBoundary("界", RUST_SUPERVISOR_LIMITS.programMax - 1);
  const argument = unicodeBoundary("界", RUST_SUPERVISOR_LIMITS.argumentMax);
  const environmentValue = unicodeBoundary(
    "界",
    RUST_SUPERVISOR_LIMITS.environmentValueMax,
  );
  const errorText = unicodeBoundary(
    "界",
    RUST_SUPERVISOR_LIMITS.errorMessageMax,
  );
  assert.equal(validate(start), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...start, unknown: true }), false);
  assert.equal(validate({ ...start, id: "" }), false);
  assert.equal(validate({ ...start, id: requestId.atLimit }), true);
  assert.equal(validate({ ...start, id: requestId.overLimit }), false);
  assert.equal(
    validate({ ...start, id: RUST_SUPERVISOR_LIMITS.safeIntegerMax }),
    true,
  );
  assert.equal(
    validate({ ...start, id: -RUST_SUPERVISOR_LIMITS.safeIntegerMax }),
    true,
  );
  assert.equal(
    validate({ ...start, id: RUST_SUPERVISOR_LIMITS.safeIntegerMax + 1 }),
    false,
  );
  assert.equal(
    validate({ ...start, id: -RUST_SUPERVISOR_LIMITS.safeIntegerMax - 1 }),
    false,
  );
  assert.equal(
    validate({ ...start, params: { ...start.params, program: "node" } }),
    false,
  );
  assert.equal(
    validate({
      ...start,
      params: {
        ...start.params,
        env: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`KEY_${index}`, "value"]),
        ),
      },
    }),
    false,
  );
  assert.equal(
    validate({
      ...start,
      params: { ...start.params, env: { "BAD KEY": "value" } },
    }),
    false,
  );
  assert.equal(
    validate({
      ...start,
      params: { ...start.params, env: { VALUE: "x".repeat(8_193) } },
    }),
    false,
  );
  assert.equal(
    validate({
      ...start,
      params: {
        ...start.params,
        program: `/${program.atLimit}`,
        args: [argument.atLimit],
        env: { VALUE: environmentValue.atLimit },
      },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate({
      ...start,
      params: { ...start.params, program: `/${program.overLimit}` },
    }),
    false,
  );
  assert.equal(
    validate({
      ...start,
      params: { ...start.params, args: [argument.overLimit] },
    }),
    false,
  );
  assert.equal(
    validate({
      ...start,
      params: { ...start.params, env: { VALUE: environmentValue.overLimit } },
    }),
    false,
  );
  assert.equal(
    validate({
      jsonrpc: "2.0",
      id: "fixture.health.1",
      result: { state: "running", ready: true, child_pid: 123 },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate({
      jsonrpc: "2.0",
      result: { state: "running", ready: true, child_pid: 123 },
    }),
    false,
  );
  assert.equal(
    validate({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_700,
        message: "parse error",
        data: { state: "created" },
      },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_603,
        message: errorText.atLimit,
        data: { state: "failed", detail: errorText.atLimit },
      },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_603,
        message: errorText.overLimit,
        data: { state: "failed" },
      },
    }),
    false,
  );
  assert.equal(
    validate({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_603,
        message: "internal error",
        data: { state: "failed", detail: errorText.overLimit },
      },
    }),
    false,
  );
});

test("Node response validator matches the generated supervisor schema projection", () => {
  const requestId = unicodeBoundary("界", RUST_SUPERVISOR_LIMITS.requestIdMax);
  const errorText = unicodeBoundary(
    "界",
    RUST_SUPERVISOR_LIMITS.errorMessageMax,
  );
  const signalResponse = validateSupervisorResponse({
    jsonrpc: "2.0",
    id: "fixture.signal.1",
    result: { state: "stopped", signal: 15 },
  });
  assert.ok("result" in signalResponse);
  assert.equal(signalResponse.result.signal, 15);
  for (const id of [
    requestId.atLimit,
    RUST_SUPERVISOR_LIMITS.safeIntegerMax,
    -RUST_SUPERVISOR_LIMITS.safeIntegerMax,
  ]) {
    assert.equal(
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id,
        result: { state: "stopped" },
      }).id,
      id,
    );
  }
  for (const id of [
    requestId.overLimit,
    RUST_SUPERVISOR_LIMITS.safeIntegerMax + 1,
    -RUST_SUPERVISOR_LIMITS.safeIntegerMax - 1,
  ]) {
    assert.throws(
      () =>
        validateSupervisorResponse({
          jsonrpc: "2.0",
          id,
          result: { state: "stopped" },
        }),
      /response id is invalid/,
    );
  }
  assert.equal(
    validateSupervisorResponse({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_603,
        message: errorText.atLimit,
        data: { state: "failed", detail: errorText.atLimit },
      },
    }).id,
    null,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_603,
          message: errorText.overLimit,
          data: { state: "failed" },
        },
      }),
    /error response is invalid/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_603,
          message: "internal error",
          data: { state: "failed", detail: errorText.overLimit },
        },
      }),
    /error data is invalid/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id: "fixture.signal.2",
        result: { state: "stopped", signal: "SIGTERM" },
      }),
    /signal is invalid/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id: "fixture.error.1",
        error: { code: -32_000, message: "", data: { state: "failed" } },
      }),
    /error response is invalid/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        result: { state: "running", ready: true, child_pid: 123 },
      }),
    /response id is invalid/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id: "fixture.result.unknown",
        result: { state: "running", ready: true, child_pid: 123, extra: true },
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse({
        jsonrpc: "2.0",
        id: "fixture.error.data",
        error: {
          code: -32_603,
          message: "internal error",
          data: { state: "failed", unknown: true },
        },
      }),
    /error data is invalid/,
  );
  assert.throws(
    () =>
      validateSupervisorResponse(
        {
          jsonrpc: "2.0",
          id: "fixture.start.missing-pid",
          result: { state: "running", ready: true },
        },
        "start",
      ),
    /start result is invalid/,
  );
  assert.deepEqual(
    validateSupervisorResponse({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32_700,
        message: "parse error",
        data: { state: "created" },
      },
    }).id,
    null,
  );
});

test("Node launch bounds count Unicode code points for args and environment", async () => {
  const argument = unicodeBoundary("界", RUST_SUPERVISOR_LIMITS.argumentMax);
  const environmentValue = unicodeBoundary(
    "界",
    RUST_SUPERVISOR_LIMITS.environmentValueMax,
  );
  const { spawnImpl, supervisors } = fakeSpawn(lifecycleResponse);
  const makeLaunch = (args: string[], value: string) =>
    createRustProcessExtensionLauncher({
      binaryPath: process.execPath,
      resolveEntrypoint: () => ({
        program: process.execPath,
        args,
        env: { UNICODE: value },
      }),
      allowedEnvironmentKeys: ["UNICODE"],
      spawnImpl,
      killProcessGroupImpl: () => {},
    });

  const exact = makeLaunch(
    [argument.atLimit],
    environmentValue.atLimit,
  )({
    manifest: manifest("fixture.unicode-exact"),
    ports: {},
  });
  await exact.start();
  await exact.terminate();

  const overArgument = makeLaunch(
    [argument.overLimit],
    environmentValue.atLimit,
  )({
    manifest: manifest("fixture.unicode-argument"),
    ports: {},
  });
  await assert.rejects(overArgument.start(), /bounded string/);
  const overEnvironment = makeLaunch(
    [],
    environmentValue.overLimit,
  )({
    manifest: manifest("fixture.unicode-environment"),
    ports: {},
  });
  await assert.rejects(overEnvironment.start(), /bounded string/);
  assert.equal(supervisors.length, 1);
});

test("start is linearizable and stop prevents a deferred resolver from spawning", async () => {
  let resolveEntrypoint!: (value: {
    program: string;
    args: string[];
    env: Record<string, string>;
  }) => void;
  const entrypoint = new Promise<{
    program: string;
    args: string[];
    env: Record<string, string>;
  }>((resolveEntrypointPromise) => {
    resolveEntrypoint = resolveEntrypointPromise;
  });
  const { spawnImpl, supervisors } = fakeSpawn(lifecycleResponse);
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => entrypoint,
    spawnImpl,
    killProcessGroupImpl: () => {},
  });
  const instance = launch({
    manifest: manifest("fixture.linearizable"),
    ports: {},
  });

  const starting = instance.start();
  assert.equal(instance.state, "starting");
  await assert.rejects(instance.start(), /cannot start from starting/);
  assert.deepEqual(await instance.stop(), { forced: true });
  assert.equal(instance.state, "stopped");
  resolveEntrypoint({ program: process.execPath, args: [], env: {} });
  await assert.rejects(starting, /startup ended in stopped/);
  assert.equal(supervisors.length, 0);
});

test("abort during entrypoint resolution prevents a late spawn", async () => {
  let resolveEntrypoint!: (value: {
    program: string;
    args: string[];
    env: Record<string, string>;
  }) => void;
  const entrypoint = new Promise<{
    program: string;
    args: string[];
    env: Record<string, string>;
  }>((resolveEntrypointPromise) => {
    resolveEntrypoint = resolveEntrypointPromise;
  });
  const { spawnImpl, supervisors } = fakeSpawn(lifecycleResponse);
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => entrypoint,
    spawnImpl,
    killProcessGroupImpl: () => {},
  });
  const instance = launch({ manifest: manifest("fixture.abort"), ports: {} });
  const controller = new AbortController();
  const reason = new Error("startup cancelled");

  const starting = instance.start({ signal: controller.signal });
  controller.abort(reason);
  resolveEntrypoint({ program: process.execPath, args: [], env: {} });
  await assert.rejects(starting, (error) => error === reason);
  assert.equal(instance.state, "stopped");
  assert.equal(supervisors.length, 0);
});

test("spawn error followed by close settles startup and cleanup", async () => {
  const failure = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  const { spawnImpl } = fakeSpawn(
    () => {},
    (supervisor) => {
      queueMicrotask(() => {
        supervisor.emit("error", failure);
        supervisor.close();
      });
    },
  );
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [],
      env: {},
    }),
    spawnImpl,
    killProcessGroupImpl: () => {},
  });
  const instance = launch({
    manifest: manifest("fixture.spawn-error"),
    ports: {},
  });

  await assert.rejects(instance.start(), (error) => error === failure);
  await instance.terminate();
  assert.equal(instance.state, "stopped");
});

test("valid response followed by an oversized partial frame fails closed", async () => {
  const killedGroups: number[] = [];
  const { spawnImpl } = fakeSpawn((request, supervisor) => {
    if (request.method !== "runtime.start") return;
    supervisor.respond(
      {
        jsonrpc: "2.0",
        id: request.id,
        result: { state: "running", ready: true, child_pid: 42_424 },
      },
      "x".repeat(65_537),
    );
  });
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [],
      env: {},
    }),
    spawnImpl,
    killProcessGroupImpl: (pid) => killedGroups.push(pid),
  });
  const instance = launch({ manifest: manifest("fixture.frame"), ports: {} });

  await assert.rejects(instance.start(), /startup ended in stopped/);
  assert.deepEqual(killedGroups, [42_424]);
  assert.equal(instance.state, "stopped");
});

test("the 64 KiB frame limit counts JSON content without the LF delimiter", async () => {
  const extensionManifest = manifest("fixture.exact-frame");
  const fixedArgs = Array.from({ length: 15 }, () => "x".repeat(4_096));
  const params = {
    extension_id: extensionManifest.id,
    program: process.execPath,
    args: [...fixedArgs, ""],
    env: {},
    startup_timeout_ms: 2_000,
    shutdown_grace_ms: 2_000,
  };
  const request = {
    jsonrpc: "2.0",
    id: `${extensionManifest.id}.1`,
    method: "runtime.start",
    params,
  };
  const remainingBytes =
    RUST_SUPERVISOR_LIMITS.maxFrameBytes -
    Buffer.byteLength(JSON.stringify(request));
  assert.ok(remainingBytes >= 0 && remainingBytes <= 4_096);
  params.args[params.args.length - 1] = "x".repeat(remainingBytes);
  assert.equal(
    Buffer.byteLength(JSON.stringify(request)),
    RUST_SUPERVISOR_LIMITS.maxFrameBytes,
  );

  const { spawnImpl } = fakeSpawn((received, supervisor) => {
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: received.id,
      result: { state: "running", ready: true, child_pid: 42_424 },
    });
    const padding =
      RUST_SUPERVISOR_LIMITS.maxFrameBytes - Buffer.byteLength(response);
    supervisor.stdout.write(`${response}${" ".repeat(padding)}\n`);
  });
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => ({
      program: params.program,
      args: params.args,
      env: {},
    }),
    spawnImpl,
    killProcessGroupImpl: () => {},
  });
  const instance = launch({ manifest: extensionManifest, ports: {} });

  await instance.start();
  assert.equal(instance.state, "running");
  await instance.terminate();
});

test("unexpected supervisor close kills the last owned process group", async () => {
  const killedGroups: number[] = [];
  const { spawnImpl, supervisors } = fakeSpawn(lifecycleResponse);
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [],
      env: {},
    }),
    spawnImpl,
    killProcessGroupImpl: (pid) => killedGroups.push(pid),
  });
  const instance = launch({ manifest: manifest("fixture.crash"), ports: {} });

  await instance.start();
  supervisors[0].close();
  assert.deepEqual(killedGroups, [42_424]);
  assert.equal(instance.state, "stopped");
});

test("concurrent stop calls share one JSON-RPC stop operation", async () => {
  let stopRequests = 0;
  const { spawnImpl } = fakeSpawn((request, supervisor) => {
    if (request.method === "runtime.stop") stopRequests += 1;
    lifecycleResponse(request, supervisor);
  });
  const launch = createRustProcessExtensionLauncher({
    binaryPath: process.execPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [],
      env: {},
    }),
    spawnImpl,
    killProcessGroupImpl: () => {},
  });
  const instance = launch({
    manifest: manifest("fixture.concurrent-stop"),
    ports: {},
  });

  await instance.start();
  const [first, second] = await Promise.all([instance.stop(), instance.stop()]);
  assert.deepEqual(first, { forced: false });
  assert.deepEqual(second, first);
  assert.equal(stopRequests, 1);
  assert.equal(instance.state, "stopped");
});

test("extension registry starts, probes and cooperatively stops a Rust-owned process", async () => {
  const { root, script } = await fixture(`
    import { appendFileSync } from "node:fs";
    const marker = process.argv[2];
    process.on("SIGTERM", () => { appendFileSync(marker, "term\\n"); process.exit(0); });
    process.stdout.write("sumi.runtime.extension.ready.v1\\n");
    setInterval(() => {}, 1000);
  `);
  const marker = join(root, "stopped.txt");
  const registry = createExtensionRegistry();
  registry.register({
    manifest: manifest(),
    launch: createRustProcessExtensionLauncher({
      binaryPath,
      resolveEntrypoint: () => ({
        program: process.execPath,
        args: [script, marker],
        env: {},
      }),
      shutdownGraceMs: 200,
    }),
  });

  await registry.startAll();
  assert.deepEqual(await registry.health(), {
    "fixture.health": { ready: true, reason: undefined },
  });
  await registry.stopAll();
  assert.equal(await readFile(marker, "utf8"), "term\n");
});

test("composition root starts and stops the Rust-owned process through ControlEngine", async () => {
  const { root, script } = await fixture(`
    import { appendFileSync } from "node:fs";
    const marker = process.argv[2];
    process.on("SIGTERM", () => { appendFileSync(marker, "closed\\n"); process.exit(0); });
    process.stdout.write("sumi.runtime.extension.ready.v1\\n");
    setInterval(() => {}, 1000);
  `);
  const marker = join(root, "control-engine.txt");
  const runtime = createRuntime({
    env: {
      APP_ENV: "test",
      STORE_PROVIDER: "memory",
      OBJECT_STORAGE_PROVIDER: "memory",
    },
    overrides: {
      extensionRegistrations: [
        {
          manifest: manifest("fixture.control-engine"),
          launch: createRustProcessExtensionLauncher({
            binaryPath,
            resolveEntrypoint: () => ({
              program: process.execPath,
              args: [script, marker],
              env: {},
            }),
            shutdownGraceMs: 200,
          }),
        },
      ],
      authenticate: async () => ({
        tenant_id: "tenant_demo",
        actor_id: "test-actor",
      }),
    },
  });

  await runtime.start();
  assert.deepEqual(await runtime.extensions.health(), {
    "fixture.control-engine": { ready: true, reason: undefined },
  });
  await runtime.close();
  assert.equal(await readFile(marker, "utf8"), "closed\n");
});

test("stubborn child reaches bounded process-group kill", async () => {
  const { script } = await fixture(`
    process.on("SIGTERM", () => {});
    process.stdout.write("sumi.runtime.extension.ready.v1\\n");
    setInterval(() => {}, 1000);
  `);
  const launch = createRustProcessExtensionLauncher({
    binaryPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [script],
      env: {},
    }),
    shutdownGraceMs: 30,
  });
  const instance = launch({
    manifest: manifest("fixture.stubborn"),
    ports: {},
  });
  await instance.start();
  const pid = instance.snapshot().child_pid;
  assert.ok(pid !== undefined);
  const result = await instance.stop();
  assert.equal(result.forced, true);
  await waitForExit(pid);
});

test("startup fails closed when the extension omits its readiness frame", async () => {
  const { script } = await fixture(`
    setInterval(() => {}, 1000);
  `);
  const launch = createRustProcessExtensionLauncher({
    binaryPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [script],
      env: {},
    }),
    startupTimeoutMs: 30,
    shutdownGraceMs: 30,
  });
  const instance = launch({
    manifest: manifest("fixture.not-ready"),
    ports: {},
  });
  await assert.rejects(instance.start(), /-32000/);
  assert.equal(instance.state, "stopped");
});

test("stop kills a TERM-ignoring descendant after its leader exits", async () => {
  const { root, script } = await fixture(`
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolveReady, rejectReady) => {
      descendant.stdout.once("data", resolveReady);
      descendant.once("error", rejectReady);
    });
    writeFileSync(process.argv[2], String(descendant.pid));
    process.on("SIGTERM", () => process.exit(0));
    process.stdout.write("sumi.runtime.extension.ready.v1\\n");
    setInterval(() => {}, 1000);
  `);
  const marker = join(root, "descendant.pid");
  const launch = createRustProcessExtensionLauncher({
    binaryPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [script, marker],
      env: {},
    }),
    shutdownGraceMs: 50,
  });
  const instance = launch({
    manifest: manifest("fixture.descendant"),
    ports: {},
  });

  await instance.start();
  const descendantPid = Number(await readFile(marker, "utf8"));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
  const result = await instance.stop();
  assert.equal(result.forced, true);
  await waitForExit(descendantPid);
});

test("hard termination kills the owned process and parent env is not inherited", async () => {
  const { root, script } = await fixture(`
    import { writeFileSync } from "node:fs";
    writeFileSync(process.argv[2], JSON.stringify({ inherited: process.env.SUMI_PARENT_SENTINEL ?? null }));
    process.on("SIGTERM", () => {});
    process.stdout.write("sumi.runtime.extension.ready.v1\\n");
    setInterval(() => {}, 1000);
  `);
  const marker = join(root, "environment.json");
  const previous = process.env.SUMI_PARENT_SENTINEL;
  process.env.SUMI_PARENT_SENTINEL = "must-not-cross";
  try {
    const launch = createRustProcessExtensionLauncher({
      binaryPath,
      resolveEntrypoint: () => ({
        program: process.execPath,
        args: [script, marker],
        env: {},
      }),
    });
    const instance = launch({
      manifest: manifest("fixture.terminate"),
      ports: {},
    });
    await instance.start();
    const pid = instance.snapshot().child_pid;
    assert.ok(pid !== undefined);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      inherited: null,
    });
    await instance.terminate();
    await waitForExit(pid);
  } finally {
    if (previous === undefined) delete process.env.SUMI_PARENT_SENTINEL;
    else process.env.SUMI_PARENT_SENTINEL = previous;
  }
});

test("launcher rejects business capabilities and environment outside its allowlist", async () => {
  const launch = createRustProcessExtensionLauncher({
    binaryPath,
    resolveEntrypoint: () => ({
      program: process.execPath,
      args: [],
      env: { SECRET: "x" },
    }),
  });
  assert.throws(
    () =>
      launch({
        manifest: manifest("fixture.business"),
        ports: { "crm.read": {} },
      }),
    /capability RPC is not enabled/,
  );
  const instance = launch({ manifest: manifest("fixture.env"), ports: {} });
  await assert.rejects(instance.start(), /not allowlisted/);
});
