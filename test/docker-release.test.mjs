import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("production image installs only the lockfile production closure and runs dist", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /corepack enable pnpm && corepack install/);
  assert.match(
    dockerfile,
    /pnpm install --prod --frozen-lockfile --ignore-scripts/,
  );
  assert.doesNotMatch(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(
    dockerfile,
    /COPY --from=build --chown=node:node \/workspace\/dist \.\/dist/,
  );
  assert.match(
    dockerfile,
    /COPY --from=build --chown=node:node \/workspace\/node_modules \.\/node_modules/,
  );
  assert.match(dockerfile, /COPY src \.\/src/);
  assert.match(dockerfile, /COPY db\/migrations \.\/db\/migrations/);
  assert.match(dockerfile, /FROM rust:1\.96\.0-bookworm AS rust-build/);
  assert.match(dockerfile, /cargo build --release --locked --package sumi-runtime-supervisor/);
  assert.match(dockerfile, /target\/release\/sumi-runtime-supervisor/);
  assert.doesNotMatch(dockerfile, /COPY src\/\*\.mjs \.\/src/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/server\.ts"\]/);
});

test("container smoke verifies the image command, production dependencies and readiness", async () => {
  const smoke = await readFile("scripts/smoke-docker.mjs", "utf8");

  for (const marker of [
    'docker(["build", "--tag", image, "."])',
    "root devDependency leaked into runtime",
    "await import('ajv')",
    "await import('ajv-formats')",
    "await import('pg')",
    "await import('jose')",
    "await import('@aws-sdk/client-s3')",
    "await import('./dist/src/outbox-relay.ts')",
    "003_conversation_revision_cas.sql",
    "dist/bin/sumi-runtime-supervisor",
    "sumi.runtime.supervisor.v1",
    '"--publish",',
    "health/ready",
    'assert.equal(runtimeUser, "node"',
    'docker(["rm", "--force", container]',
    'docker(["image", "rm", "--force", image]',
  ]) {
    assert.ok(smoke.includes(marker), `missing Docker smoke marker: ${marker}`);
  }
});
