import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkContractConsumers, formatViolations } from "../scripts/check-contract-consumers.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sumi-contract-consumers-"));
  await mkdir(join(root, "src", "scripts"), { recursive: true });
  return root;
}

test("the current workbench is a clean generated-client consumer", async () => {
  const result = await checkContractConsumers({ root: new URL("..", import.meta.url).pathname });
  assert.equal(result.ok, true, formatViolations(result));
  assert.deepEqual(result.consumerRoots, ["src/scripts", "packages/api-client/src/contract-fixture.ts"]);
  assert.ok(result.files.includes("src/scripts/workbench.ts"));
  assert.ok(result.files.includes("packages/api-client/src/contract-fixture.ts"));
});

test("a consumer may use generated operations and local view-model names", async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, "src", "scripts", "good.ts"),
      [
        'import { ask, type AskResponse } from "../../packages/api-client/src/index";',
        "type AskViewModel = { status: string };",
        "export const run = (body: unknown): Promise<AskResponse> => ask({ body });",
      ].join("\n"),
    );
    const result = await checkContractConsumers({ root, consumerRoots: ["src/scripts"] });
    assert.equal(result.ok, true, formatViolations(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transport primitives, literal routes and DTO redeclarations are reported with path, line and rule", async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, "src", "scripts", "bad.ts"),
      [
        'export async function run() {',
        '  const response = await fetch("/v1/ask");',
        "  const request = new XMLHttpRequest();",
        "  const result = await axios.post('/v1/tts/synthesize', request);",
        "  type AskRequest = { input: string };",
        "  return response ?? result;",
        "}",
      ].join("\n"),
    );
    const result = await checkContractConsumers({ root, consumerRoots: ["src/scripts"] });
    assert.equal(result.ok, false);
    for (const rule of ["raw-fetch", "transport-library", "literal-v1-url", "transport-dto-declaration", "missing-sdk-operation"]) {
      assert.ok(result.violations.some((finding) => finding.rule === rule), `${rule}: ${formatViolations(result)}`);
    }
    assert.ok(result.violations.every((finding) => finding.path === "src/scripts/bad.ts"));
    assert.ok(result.violations.every((finding) => Number.isInteger(finding.line) && finding.line > 0));
    assert.match(formatViolations(result), /src\/scripts\/bad\.ts:2: raw-fetch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("API calls without an operation imported through the canonical index fail the boundary", async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, "src", "scripts", "missing.ts"), "export const run = () => client.post('/safe');\n");
    const result = await checkContractConsumers({ root, consumerRoots: ["src/scripts"] });
    assert.equal(result.violations.filter((finding) => finding.rule === "missing-sdk-operation").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calling a generated operation through a non-canonical module also fails the boundary", async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, "src", "scripts", "direct-generated.ts"),
      'import { ask } from "../../packages/api-client/src/generated/sdk.gen";\nexport const run = () => ask({ body: {} });\n',
    );
    const result = await checkContractConsumers({ root, consumerRoots: ["src/scripts"] });
    assert.equal(result.violations.filter((finding) => finding.rule === "missing-sdk-operation").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only configured consumer roots are scanned; backend and test fixtures stay out of scope", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "test"), { recursive: true });
    await writeFile(join(root, "test", "backend.test.mjs"), "fetch('/v1/ask');\n");
    await writeFile(join(root, "src", "scripts", "clean.ts"), "export const viewModel = { status: 'ok' };\n");
    const result = await checkContractConsumers({ root, consumerRoots: ["src/scripts"] });
    assert.equal(result.ok, true, formatViolations(result));
    assert.equal(result.files.some((file) => file.startsWith("test/")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("consumer roots can be supplied by the protocol manifest", async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, "protocol"), { recursive: true });
    await mkdir(join(root, "ui"), { recursive: true });
    await writeFile(join(root, "protocol", "protocol.manifest.json"), JSON.stringify({ consumer_roots: ["ui"] }));
    await writeFile(join(root, "ui", "clean.ts"), "export const viewModel = { label: 'ok' };\n");
    const result = await checkContractConsumers({ root });
    assert.deepEqual(result.consumerRoots, ["ui"]);
    assert.equal(result.ok, true, formatViolations(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
