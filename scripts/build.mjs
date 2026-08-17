import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  cp,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const DEFAULT_RUNTIME_SOURCES = [
  "src/application/commands.mjs",
  "src/application/attachments.mjs",
  "src/application/conversation-state.mjs",
  "src/application/index.mjs",
  "src/application/mutation-policy.mjs",
  "src/application/services.mjs",
  "src/auth.mjs",
  "src/composition-root.mjs",
  "src/control/cas-circuit-breaker.mjs",
  "src/control/engine.mjs",
  "src/control/guardian-denial-governor.mjs",
  "src/control/guardian-review.mjs",
  "src/control/index.mjs",
  "src/contracts.mjs",
  "src/data-cipher.mjs",
  "src/extensions/index.mjs",
  "src/extensions/manifest.mjs",
  "src/extensions/registry.mjs",
  "src/extensions/rust-process-supervisor.mjs",
  "src/lifecycle/staged-timeout.mjs",
  "src/lifecycle/managed-task-registry.mjs",
  "src/mutation-policy.mjs",
  "src/object-storage.mjs",
  "src/observability.mjs",
  "src/outbox-relay.mjs",
  "src/outbox-worker.mjs",
  "src/provider-common.mjs",
  "src/protocol-policy.mjs",
  "src/provider-dashscope.mjs",
  "src/provider-mock.mjs",
  "src/provider-openai.mjs",
  "src/providers.mjs",
  "src/production-config.mjs",
  "src/protocol-validation.mjs",
  "src/postgres-store.mjs",
  "src/server.mjs",
  "src/sse-adapter.mjs",
  "src/store.mjs",
];

const DEFAULT_RUNTIME_BINARIES = [
  {
    source: "target/release/sumi-runtime-supervisor",
    target: "bin/sumi-runtime-supervisor",
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function walkFiles(root, directory = root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, absolutePath));
    else if (entry.isFile()) files.push(relative(root, absolutePath).replaceAll("\\", "/"));
    else throw new Error(`release input must be a regular file: ${absolutePath}`);
  }
  return files;
}

async function createManifest(stageRoot, packageMetadata) {
  const paths = await walkFiles(stageRoot);
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(join(stageRoot, path));
    const metadata = await stat(join(stageRoot, path));
    files.push({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      executable: (metadata.mode & 0o111) !== 0,
    });
  }
  const contentSet = files
    .map(({ path, bytes, sha256: digest, executable }) => `${path}\0${bytes}\0${digest}\0${executable}`)
    .join("\n");
  return {
    schema_version: "sumi.runtime-build-manifest.v1",
    artifact: packageMetadata.name,
    version: packageMetadata.version,
    hash_algorithm: "sha256",
    content_set_sha256: sha256(contentSet),
    files,
    manifest_is_payload_metadata: true,
    reproducibility: {
      timestamps: "excluded",
      paths: "artifact-relative-posix",
      ordering: "lexicographic",
    },
  };
}

export async function verifyBuildManifest(root) {
  const resolvedRoot = resolve(root);
  const manifest = JSON.parse(
    await readFile(join(resolvedRoot, "BUILD-MANIFEST.json"), "utf8"),
  );
  if (manifest.schema_version !== "sumi.runtime-build-manifest.v1") {
    throw new Error("runtime build manifest schema mismatch");
  }
  const actualPaths = (await walkFiles(resolvedRoot)).filter(
    (path) => path !== "BUILD-MANIFEST.json",
  );
  const expectedPaths = manifest.files.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("runtime build manifest file set mismatch");
  }
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      entry.path.startsWith("/") ||
      entry.path.includes("..") ||
      entry.path.includes("\\")
    ) {
      throw new Error(`unsafe runtime manifest path: ${entry.path}`);
    }
    const absolutePath = join(resolvedRoot, entry.path);
    const bytes = await readFile(absolutePath);
    const metadata = await stat(absolutePath);
    if (
      bytes.length !== entry.bytes
      || sha256(bytes) !== entry.sha256
      || ((metadata.mode & 0o111) !== 0) !== entry.executable
    ) {
      throw new Error(`runtime build manifest digest mismatch: ${entry.path}`);
    }
  }
  const contentSet = manifest.files
    .map(({ path, bytes, sha256: digest, executable }) => `${path}\0${bytes}\0${digest}\0${executable}`)
    .join("\n");
  if (sha256(contentSet) !== manifest.content_set_sha256) {
    throw new Error("runtime build aggregate digest mismatch");
  }
  return manifest;
}

async function promoteDirectory(stageRoot, outputRoot) {
  const backupRoot = `${outputRoot}.backup-${process.pid}-${Date.now()}`;
  let movedExistingOutput = false;
  try {
    try {
      await stat(outputRoot);
      await rename(outputRoot, backupRoot);
      movedExistingOutput = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await rename(stageRoot, outputRoot);
    } catch (error) {
      if (movedExistingOutput) await rename(backupRoot, outputRoot);
      throw error;
    }
    if (movedExistingOutput) await rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function buildRuntime({
  root = process.cwd(),
  output = "dist",
  runtimeSources = DEFAULT_RUNTIME_SOURCES,
  runtimeBinaries = DEFAULT_RUNTIME_BINARIES,
} = {}) {
  const resolvedRoot = resolve(root);
  const outputRoot = resolve(resolvedRoot, output);
  if (dirname(outputRoot) !== resolvedRoot || basename(outputRoot) !== output) {
    throw new Error("build output must be one direct child of the repository root");
  }
  const stageRoot = resolve(
    resolvedRoot,
    `.${output}.staging-${process.pid}-${Date.now()}`,
  );
  const packageMetadata = JSON.parse(
    await readFile(join(resolvedRoot, "package.json"), "utf8"),
  );
  const runtimePackage = {
    name: packageMetadata.name,
    version: packageMetadata.version,
    private: true,
    description: packageMetadata.description,
    type: "module",
    engines: packageMetadata.engines,
    license: packageMetadata.license,
    dependencies: packageMetadata.dependencies,
    scripts: { start: "node src/server.mjs", "start:outbox": "node src/outbox-worker.mjs" },
  };

  await rm(stageRoot, { recursive: true, force: true });
  try {
    await mkdir(join(stageRoot, "src"), { recursive: true });
    await cp(join(resolvedRoot, "contracts"), join(stageRoot, "contracts"), {
      recursive: true,
    });
    await cp(
      join(resolvedRoot, "db", "migrations"),
      join(stageRoot, "db", "migrations"),
      { recursive: true },
    );
    await cp(
      join(resolvedRoot, "protocol", "schema", "json"),
      join(stageRoot, "protocol", "schema", "json"),
      { recursive: true },
    );
    await cp(
      join(resolvedRoot, "protocol", "protocol.manifest.json"),
      join(stageRoot, "protocol", "protocol.manifest.json"),
    );
    await cp(join(resolvedRoot, "LICENSE"), join(stageRoot, "LICENSE"));
    for (const source of runtimeSources) {
      await mkdir(dirname(join(stageRoot, source)), { recursive: true });
      await cp(join(resolvedRoot, source), join(stageRoot, source));
    }
    for (const binary of runtimeBinaries) {
      if (
        !binary
        || typeof binary.source !== "string"
        || typeof binary.target !== "string"
        || binary.target.startsWith("/")
        || binary.target.includes("..")
      ) {
        throw new Error("runtime binary mapping is invalid");
      }
      const target = join(stageRoot, binary.target);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(resolvedRoot, binary.source), target);
      await chmod(target, 0o755);
    }
    await writeFile(
      join(stageRoot, "package.json"),
      `${JSON.stringify(runtimePackage, null, 2)}\n`,
    );

    const manifest = await createManifest(stageRoot, packageMetadata);
    await writeFile(
      join(stageRoot, "BUILD-MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await verifyBuildManifest(stageRoot);
    await promoteDirectory(stageRoot, outputRoot);
    return manifest;
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const manifest = await buildRuntime();
    console.log(
      `build passed: ${manifest.files.length} payload files, content set ${manifest.content_set_sha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
