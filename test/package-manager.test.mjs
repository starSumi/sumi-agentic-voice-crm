import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const pnpmLock = parse(await readFile("pnpm-lock.yaml", "utf8"));
const pnpmAction = "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86";

test("the repository has one exact pnpm toolchain and lockfile", async () => {
  assert.equal(packageJson.packageManager, "pnpm@10.33.4");
  assert.equal(packageJson.engines.node, ">=24.18.0");
  assert.equal(packageJson.engines.pnpm, "10.33.4");
  assert.deepEqual(packageJson.volta, { node: "24.18.0" });
  assert.equal(packageJson.pnpm.overrides["js-yaml"], "4.3.1");
  assert.equal("overrides" in packageJson, false);

  const rootFiles = await readdir(".");
  const recognizedLocks = rootFiles.filter((file) =>
    ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].includes(file),
  );
  assert.deepEqual(recognizedLocks, ["pnpm-lock.yaml"]);
  assert.equal(existsSync("package-lock.json"), false);
  assert.equal(String(pnpmLock.lockfileVersion), "9.0");
  assert.equal(pnpmLock.overrides["js-yaml"], "4.3.1");
  assert.equal(Object.hasOwn(pnpmLock.packages, "js-yaml@4.2.0"), false);

  const importer = pnpmLock.importers["."];
  for (const dependencyType of ["dependencies", "devDependencies"]) {
    const expected = packageJson[dependencyType] || {};
    const locked = importer[dependencyType] || {};
    assert.deepEqual(Object.keys(locked).sort(), Object.keys(expected).sort());
    for (const [name, specifier] of Object.entries(expected)) {
      assert.equal(locked[name].specifier, specifier, `${dependencyType}.${name} lock specifier drifted`);
    }
  }
});

test("Docker and CI install the frozen pnpm closure without lifecycle scripts", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY pnpm-lock\.yaml/);
  assert.match(dockerfile, /corepack enable pnpm && corepack install/);
  assert.match(dockerfile, /test "\$\(pnpm --version\)" = "10\.33\.4"/);
  assert.match(dockerfile, /pnpm install --prod --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /USER node/);

  for (const workflow of ["ci.yml", "operations-agent.yml", "release-candidate.yml"]) {
    const source = await readFile(`.github/workflows/${workflow}`, "utf8");
    assert.ok(source.includes(pnpmAction), `${workflow} must pin pnpm/action-setup`);
    assert.match(source, /cache: pnpm/);
    assert.match(source, /cache-dependency-path: pnpm-lock\.yaml/);
    assert.match(source, /pnpm install --frozen-lockfile --ignore-scripts/);
  }
});

test("package-manager execution surfaces contain no npm command fallback", async () => {
  const workflowNames = (await readdir(".github/workflows")).filter((name) => /\.ya?ml$/.test(name));
  const executionSurfaces = [
    "package.json",
    "Dockerfile",
    "scripts/check-agent.mjs",
    "scripts/check-protocol-drift.mjs",
    "scripts/generate-sbom.mjs",
    "scripts/test-postgres.mjs",
    "test/docker-release.test.mjs",
    ...workflowNames.map((name) => `.github/workflows/${name}`),
  ];
  const forbidden = /\bnpm\s+(?:ci|install|run|test|audit|sbom)\b|\bnpx\b|package-lock\.json/;
  const drift = [];
  for (const path of executionSurfaces) {
    const source = await readFile(path, "utf8");
    if (forbidden.test(source)) drift.push(path);
  }
  assert.deepEqual(drift, []);
  assert.equal(packageJson.scripts.sbom, "node scripts/generate-sbom.mjs");
  assert.match(packageJson.scripts["audit:deps"], /^pnpm audit --audit-level=high /);
});

test("verification wires the generated-client consumer boundary", async () => {
  assert.match(packageJson.scripts.verify, /pnpm run contract:consumer-check/);
  const manifest = JSON.parse(await readFile("protocol/protocol.manifest.json", "utf8"));
  assert.deepEqual(manifest.consumer_roots, ["src/scripts", "packages/api-client/src/contract-fixture.ts"]);
  assert.equal(manifest.commands.consumer_check, "pnpm run contract:consumer-check");
});

test("verification enforces the mixed-language duplication gate", async () => {
  assert.equal(packageJson.devDependencies.jscpd, "5.0.12");
  assert.equal(packageJson.scripts.duplication, "jscpd");
  assert.match(packageJson.scripts.verify, /pnpm run duplication/);

  const config = JSON.parse(await readFile(".jscpd.json", "utf8"));
  assert.equal(config.exitCode, 1);
  assert.deepEqual(config.format, ["javascript", "typescript", "tsx", "rust"]);
  assert.ok(config.ignore.includes("**/packages/api-client/src/generated/**"));
});

async function listInstructionFiles(directory = ".") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if ([".git", "node_modules", "artifacts", "dist"].includes(entry.name)) continue;
      files.push(...(await listInstructionFiles(path)));
      continue;
    }
    if (/\.(?:md|json|ya?ml)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("maintainer, contributor, protocol, and agent instructions use pnpm exclusively", async () => {
  const instructionFiles = await listInstructionFiles();
  const forbiddenCommand = /\bnpm\s+(?:ci|install|run|test|audit|pack|start)\b|\bnpx\b/;
  const drift = [];
  for (const path of instructionFiles) {
    if (path === "pnpm-lock.yaml") continue;
    const source = await readFile(path, "utf8");
    if (forbiddenCommand.test(source)) drift.push(path);
  }
  assert.deepEqual(drift, []);

  const codeowners = await readFile(".github/CODEOWNERS", "utf8");
  assert.match(codeowners, /^\/pnpm-lock\.yaml @starSumi$/m);
  assert.doesNotMatch(codeowners, /package-lock\.json/);
});
