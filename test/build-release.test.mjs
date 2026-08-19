import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRuntime, verifyBuildManifest } from "../scripts/build.mjs";
import { cargoBuildEnvironment } from "../scripts/run-cargo.mjs";

async function createBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "sumi-runtime-build-"));
  await mkdir(join(root, "contracts"), { recursive: true });
  await mkdir(join(root, "db", "migrations"), { recursive: true });
  await mkdir(join(root, "protocol", "schema", "json"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "target", "release"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "sumi-build-fixture",
      version: "1.0.0",
      description: "fixture",
      type: "module",
      engines: { node: ">=24.19.0" },
      license: "Apache-2.0",
      dependencies: {},
    })}\n`,
  );
  await writeFile(join(root, "LICENSE"), "fixture license\n");
  await writeFile(join(root, "contracts", "openapi.yaml"), "openapi: 3.1.0\n");
  await writeFile(
    join(root, "db", "migrations", "001_fixture.sql"),
    "select 1;\n",
  );
  await writeFile(
    join(root, "protocol", "schema", "json", "openapi.bundle.json"),
    "{}\n",
  );
  await writeFile(join(root, "protocol", "protocol.manifest.json"), "{}\n");
  await writeFile(
    join(root, "src", "server.ts"),
    "export const ready = true;\n",
  );
  const supervisor = join(root, "target", "release", "sumi-runtime-supervisor");
  await writeFile(supervisor, "fixture binary\n");
  await chmod(supervisor, 0o755);
  return root;
}

test("runtime build manifest binds every relative path to its content digest", async () => {
  const root = await createBuildFixture();
  const manifest = await buildRuntime({
    root,
    runtimeSources: ["src/server.ts"],
    runtimeBinaries: [
      {
        source: "target/release/sumi-runtime-supervisor",
        target: "bin/sumi-runtime-supervisor",
      },
    ],
  });

  assert.equal(manifest.schema_version, "sumi.runtime-build-manifest.v1");
  assert.equal(
    manifest.files.some((entry) => entry.path.startsWith("dist/")),
    false,
  );
  assert.equal(
    manifest.files.some(
      (entry) => entry.path === "db/migrations/001_fixture.sql",
    ),
    true,
  );
  assert.equal(
    manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)),
    true,
  );
  assert.equal(
    manifest.files.find((entry) => entry.path === "bin/sumi-runtime-supervisor")
      ?.executable,
    true,
  );
  assert.deepEqual(await verifyBuildManifest(join(root, "dist")), manifest);

  await chmod(join(root, "dist", "bin", "sumi-runtime-supervisor"), 0o644);
  await assert.rejects(
    verifyBuildManifest(join(root, "dist")),
    /manifest digest mismatch/,
  );
  await chmod(join(root, "dist", "bin", "sumi-runtime-supervisor"), 0o755);
  await writeFile(join(root, "dist", "src", "server.ts"), "tampered\n");
  await assert.rejects(
    verifyBuildManifest(join(root, "dist")),
    /manifest digest mismatch/,
  );
});

test("failed staging leaves the previous dist untouched", async () => {
  const root = await createBuildFixture();
  await buildRuntime({
    root,
    runtimeSources: ["src/server.ts"],
    runtimeBinaries: [],
  });
  const previousManifest = await readFile(
    join(root, "dist", "BUILD-MANIFEST.json"),
    "utf8",
  );

  await assert.rejects(
    buildRuntime({
      root,
      runtimeSources: ["src/missing.mjs"],
      runtimeBinaries: [],
    }),
    /ENOENT/,
  );
  assert.equal(
    await readFile(join(root, "dist", "BUILD-MANIFEST.json"), "utf8"),
    previousManifest,
  );
  await verifyBuildManifest(join(root, "dist"));
});

test("Cargo builds remap host paths and disable incremental output", () => {
  const environment = cargoBuildEnvironment({
    CARGO_HOME: "/tmp/sumi-cargo-home",
    RUSTFLAGS: "-C debuginfo=2",
    CARGO_ENCODED_RUSTFLAGS: "untrusted",
  });
  assert.equal(environment.CARGO_INCREMENTAL, "0");
  assert.equal("RUSTFLAGS" in environment, false);
  const flags = environment.CARGO_ENCODED_RUSTFLAGS.split("\u001f");
  assert.ok(flags.some((flag) => flag.endsWith("=/workspace")));
  assert.ok(flags.includes("--remap-path-prefix=/tmp/sumi-cargo-home=/cargo"));
  assert.equal(flags.includes("untrusted"), false);
});

test("runtime build rejects a binary containing its host build path", async () => {
  const root = await createBuildFixture();
  const supervisor = join(root, "target", "release", "sumi-runtime-supervisor");
  await writeFile(supervisor, `fixture binary ${root}\n`);
  await chmod(supervisor, 0o755);
  await assert.rejects(
    buildRuntime({ root, runtimeSources: ["src/server.ts"] }),
    /runtime binary contains non-reproducible build path/,
  );
});
