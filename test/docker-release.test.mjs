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
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "dist\/src\/server\.mjs"\]/);
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
    "await import('./dist/src/outbox-relay.mjs')",
    '"--publish",',
    "health/ready",
    'assert.equal(runtimeUser, "node"',
    'docker(["rm", "--force", container]',
    'docker(["image", "rm", "--force", image]',
  ]) {
    assert.ok(smoke.includes(marker), `missing Docker smoke marker: ${marker}`);
  }
});
