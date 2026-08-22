import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const image = `sumi-agentic-voice-crm-smoke:${process.pid}-${randomUUID().slice(0, 8)}`;
const container = `sumi-agentic-voice-crm-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`docker ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

async function waitForReadiness(port) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) {
        const readiness = await response.json();
        assert.equal(readiness.status, "ready");
        assert.equal(readiness.dependencies.database.provider, "memory");
        assert.equal(readiness.dependencies.objects.provider, "memory");
        return readiness;
      }
      lastError = new Error(`readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container readiness failed: ${lastError?.message ?? "unknown error"}`);
}

try {
  // Fail explicitly rather than silently degrading to the dist-only smoke: a
  // released image is accepted only after its own command and dependency tree run.
  docker(["version", "--format", "{{.Server.Version}}"]);
  docker(["build", "--tag", image, "."]);

  const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
  const rootDevDependencyChecks = Object.keys(packageMetadata.devDependencies ?? {})
    .map((name) => `if (existsSync('node_modules/${name}/package.json')) throw new Error('root devDependency leaked into runtime: ${name}');`)
    .join(" ");

  docker([
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    `import { accessSync, constants, existsSync } from 'node:fs'; ${rootDevDependencyChecks} if (!existsSync('dist/db/migrations/003_conversation_revision_cas.sql')) throw new Error('ordered database migrations missing from runtime'); accessSync('dist/bin/sumi-runtime-supervisor', constants.X_OK); await import('ajv'); await import('ajv-formats'); await import('pg'); await import('jose'); await import('@aws-sdk/client-s3'); await import('@aws-sdk/s3-request-presigner'); await import('./dist/src/outbox-relay.ts'); console.log('production dependencies, migrations and Rust supervisor present; root devDependencies absent');`,
  ]);
  const supervisorProtocol = docker([
    "run",
    "--rm",
    "--entrypoint",
    "/app/dist/bin/sumi-runtime-supervisor",
    image,
    "--protocol-version",
  ]).stdout.trim();
  assert.equal(supervisorProtocol, "sumi.runtime.supervisor.v1");
  const runtimeUser = docker(["run", "--rm", "--entrypoint", "id", image, "-un"]).stdout.trim();
  assert.equal(runtimeUser, "node", "the runtime image must run as the unprivileged node user");

  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--publish",
    "127.0.0.1::8080",
    image,
  ]);
  const portOutput = docker(["port", container, "8080/tcp"]).stdout.trim();
  const port = Number(/:(\d+)\s*$/.exec(portOutput)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`cannot resolve published container port from: ${portOutput || "<empty>"}`);
  }
  const readiness = await waitForReadiness(port);
  console.log(
    `docker smoke passed: ${image} started as its default command and reported ${readiness.status}`,
  );
} finally {
  docker(["rm", "--force", container], { allowFailure: true });
  docker(["image", "rm", "--force", image], { allowFailure: true });
}
