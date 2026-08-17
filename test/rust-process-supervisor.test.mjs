import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createRuntime } from "../src/composition-root.mjs";
import {
  createExtensionRegistry,
  createRustProcessExtensionLauncher,
  RUST_SUPERVISOR_PROTOCOL_VERSION,
} from "../src/extensions/index.mjs";

const binaryPath = resolve("target/release/sumi-runtime-supervisor");

function manifest(id = "fixture.health") {
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

async function fixture(source) {
  const root = await mkdtemp(join(tmpdir(), "sumi-rust-supervisor-"));
  const script = join(root, "extension.mjs");
  await writeFile(script, source);
  return { root, script };
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`process ${pid} remained alive`);
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
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const start = {
    protocol: RUST_SUPERVISOR_PROTOCOL_VERSION,
    request_id: "fixture.start.1",
    op: "start",
    extension_id: "fixture.health",
    program: process.execPath,
    args: [],
    env: {},
    startup_timeout_ms: 2_000,
    shutdown_grace_ms: 2_000,
  };
  assert.equal(validate(start), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...start, unknown: true }), false);
  assert.equal(validate({ ...start, program: "node" }), false);
  assert.equal(
    validate({
      protocol: RUST_SUPERVISOR_PROTOCOL_VERSION,
      request_id: "fixture.health.1",
      ok: true,
      state: "running",
      ready: true,
      child_pid: 123,
    }),
    true,
    JSON.stringify(validate.errors),
  );
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
      objectStorage: {},
      observability: { begin: () => ({}), finish: () => {} },
      providers: {},
      store: {},
      tracer: {},
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
  await assert.rejects(instance.start(), /START_FAILED/);
  assert.equal(instance.state, "stopped");
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
