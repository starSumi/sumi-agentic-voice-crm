import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRegistry, validateExtensionManifest } from "../src/extensions/index.mjs";

function manifest(id, overrides = {}) {
  return {
    schema_version: "sumi.extension-manifest.v1",
    id,
    version: "1.0.0",
    protocol_version: "sumi.runtime.extension.v1",
    owner: "Sumi platform",
    isolation: "in-process",
    entrypoint: `builtin:${id}`,
    capabilities: ["tool.crm.read"],
    permissions: ["crm.read"],
    dependencies: [],
    ...overrides,
  };
}

test("extension manifests are closed, exact-versioned capability declarations", () => {
  const valid = validateExtensionManifest(manifest("builtin.crm-search"));
  assert.equal(Object.isFrozen(valid), true);
  assert.throws(() => validateExtensionManifest({ ...manifest("bad"), extra: true }), /unknown field/);
  assert.throws(() => validateExtensionManifest(manifest("bad", { version: "latest" })), /exact semver/);
  assert.throws(() => validateExtensionManifest(manifest("bad", { permissions: ["shell.root"] })), /unsupported value/);
});

test("registry enforces trust, permissions, dependency order and reverse shutdown", async () => {
  const lifecycle = [];
  const registry = createExtensionRegistry({
    allowedPermissions: ["crm.read"],
    trustedInProcessIds: ["builtin.base", "builtin.consumer"],
  });
  registry.register({
    manifest: manifest("builtin.base"),
    create: () => ({
      start: () => { lifecycle.push("start:base"); },
      stop: () => { lifecycle.push("stop:base"); },
      health: () => ({ ready: true }),
    }),
  });
  registry.register({
    manifest: manifest("builtin.consumer", { dependencies: ["builtin.base"] }),
    create: () => ({
      start: () => { lifecycle.push("start:consumer"); },
      stop: () => { lifecycle.push("stop:consumer"); },
    }),
  });
  await registry.startAll();
  assert.deepEqual(lifecycle, ["start:base", "start:consumer"]);
  assert.equal(registry.capability("tool.crm.read").length, 2);
  assert.equal((await registry.health())["builtin.base"].ready, true);
  await registry.stopAll();
  assert.deepEqual(lifecycle, ["start:base", "start:consumer", "stop:consumer", "stop:base"]);
});

test("untrusted in-process code and process extensions without termination are rejected", async () => {
  const registry = createExtensionRegistry({ allowedPermissions: ["crm.read"] });
  assert.throws(() => registry.register({ manifest: manifest("third-party.inline"), create: () => ({}) }), /not trusted/);
  registry.register({
    manifest: manifest("third-party.process", { isolation: "process" }),
    launch: () => ({ start() {} }),
  });
  await assert.rejects(registry.startAll(), /must expose terminate/);
});

test("process extensions require a supervisor and receive only permission-scoped ports", async () => {
  const readPort = Object.freeze({ query: async () => [] });
  const registry = createExtensionRegistry({
    allowedPermissions: ["crm.read"],
    permissionPorts: { "crm.read": readPort, "crm.write": { mutate() {} } },
  });
  assert.throws(() => registry.register({
    manifest: manifest("third-party.bad-process", { isolation: "process" }),
    create: () => ({}),
  }), /trusted launch supervisor/);
  let received;
  registry.register({
    manifest: manifest("third-party.reader", { isolation: "process" }),
    launch: (context) => {
      received = context;
      return { start() {}, stop() {}, terminate() {} };
    },
  });
  await registry.startAll();
  assert.deepEqual(Object.keys(received.ports), ["crm.read"]);
  assert.equal(received.ports["crm.read"], readPort);
  assert.equal(Object.hasOwn(received, "env"), false);
  await registry.stopAll();
});

test("close during startup aborts and rolls back the partially started process", async () => {
  const lifecycle = [];
  const registry = createExtensionRegistry({
    allowedPermissions: ["crm.read"],
    softTimeoutMs: 1_000,
    hardGraceMs: 100,
  });
  registry.register({
    manifest: manifest("third-party.slow", { isolation: "process" }),
    launch: () => ({
      start: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      stop: () => { lifecycle.push("stop"); },
      terminate: () => { lifecycle.push("terminate"); },
    }),
  });
  const start = registry.startAll();
  const rejectedStart = assert.rejects(start);
  await new Promise((resolve) => setImmediate(resolve));
  await registry.stopAll();
  await rejectedStart;
  assert.equal(registry.state, "stopped");
  assert.deepEqual(lifecycle, ["stop"]);
});

test("a process extension that ignores cooperative abort reaches the hard terminate hook", async () => {
  let terminateCalls = 0;
  const registry = createExtensionRegistry({
    allowedPermissions: ["crm.read"],
    softTimeoutMs: 5,
    hardGraceMs: 5,
  });
  registry.register({
    manifest: manifest("third-party.stuck", { isolation: "process" }),
    launch: () => ({
      start: () => new Promise(() => {}),
      terminate: () => { terminateCalls += 1; },
    }),
  });

  await assert.rejects(registry.startAll(), (error) => error.phase === "hard");
  assert.equal(registry.state, "failed");
  assert.ok(terminateCalls >= 1);
});
