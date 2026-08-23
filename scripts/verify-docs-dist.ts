import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { jsonObject, stringValue } from "./docs-verify-helpers.ts";

type DocsManifest = Readonly<{
  version: number;
  documents: string[];
  openapi: string;
}>;
type DocsRouteMap = Readonly<{
  version: number;
  routes: Record<string, string>;
}>;
type DocumentVariant = Readonly<{
  document: string;
  docId: string;
  locale: string;
  audience: string;
  contentVersion: string;
}>;

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${label} must be a string array`);
  }
  return value;
}

function parseManifest(value: unknown): DocsManifest {
  const input = jsonObject(value, "docs manifest");
  return {
    version: typeof input.version === "number" ? input.version : Number.NaN,
    documents: stringArray(input.documents, "docs manifest documents"),
    openapi: stringValue(input.openapi, "docs manifest openapi"),
  };
}

function parseRouteMap(value: unknown): DocsRouteMap {
  const input = jsonObject(value, "docs route map");
  const routes = jsonObject(input.routes, "docs route map routes");
  const normalizedRoutes: Record<string, string> = {};
  for (const [document, route] of Object.entries(routes)) {
    normalizedRoutes[document] = stringValue(route, `route for ${document}`);
  }
  return {
    version: typeof input.version === "number" ? input.version : Number.NaN,
    routes: normalizedRoutes,
  };
}

function parseFrontmatter(value: unknown, document: string): DocumentVariant {
  const input = jsonObject(value, `${document} frontmatter`);
  return {
    document,
    docId: stringValue(input.docId, `${document} docId`),
    locale: stringValue(input.locale, `${document} locale`),
    audience: stringValue(input.audience, `${document} audience`),
    contentVersion: stringValue(
      input.contentVersion,
      `${document} contentVersion`,
    ),
  };
}

const outputRoot = resolve("artifacts", "docs-site");
const machineRoot = resolve(outputRoot, "_mcp");
const manifest = parseManifest(
  JSON.parse(
    await readFile(resolve(machineRoot, "sumi-docs-manifest.json"), "utf8"),
  ),
);
const routeMap = parseRouteMap(
  JSON.parse(
    await readFile(resolve(machineRoot, "sumi-docs-routes.json"), "utf8"),
  ),
);

assert.deepEqual(Object.keys(manifest).sort(), [
  "documents",
  "openapi",
  "version",
]);
assert.equal(manifest.version, 1);
assert.equal(manifest.documents.length, 33);
assert.equal(new Set(manifest.documents).size, manifest.documents.length);
assert.equal(routeMap.version, 1);
assert.deepEqual(
  Object.keys(routeMap.routes).sort(),
  [...manifest.documents].sort(),
);

const pageFile = (page: string) =>
  page === "/" ? "index.html" : `${page.slice(1)}index.html`;
const variantsById = new Map<string, DocumentVariant[]>();

for (const document of manifest.documents) {
  assert.match(document, /^[a-z0-9_/-]+\.md$/);
  const raw = await readFile(
    resolve(machineRoot, ...document.split("/")),
    "utf8",
  );
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  assert.ok(frontmatterMatch, `${document} is missing YAML frontmatter`);
  const frontmatter = parseFrontmatter(
    parseYaml(frontmatterMatch?.[1] ?? ""),
    document,
  );
  assert.match(frontmatter.docId, /^crm\.[a-z0-9.-]+$/);
  assert.ok(["en", "zh-CN"].includes(frontmatter.locale));
  assert.ok(["human", "agent", "both"].includes(frontmatter.audience));
  assert.equal(frontmatter.contentVersion, "0.1.0");
  assert.equal(
    frontmatter.locale,
    document.startsWith("zh-cn/") ? "zh-CN" : "en",
  );

  const variants = variantsById.get(frontmatter.docId) ?? [];
  variants.push(frontmatter);
  variantsById.set(frontmatter.docId, variants);

  const page = routeMap.routes[document];
  assert.match(page, /^(?:\/$|\/[a-z0-9_/-]+\/$)/);
  await access(resolve(outputRoot, ...pageFile(page).split("/")));
}

const chineseDocuments = manifest.documents.filter((document) =>
  document.startsWith("zh-cn/"),
);
assert.equal(chineseDocuments.length, 14);
for (const document of chineseDocuments) {
  const raw = await readFile(
    resolve(machineRoot, ...document.split("/")),
    "utf8",
  );
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  assert.ok(match, `${document} is missing YAML frontmatter`);
  const frontmatter = parseFrontmatter(parseYaml(match?.[1] ?? ""), document);
  const variants = variantsById.get(frontmatter.docId);
  assert.ok(variants, `${frontmatter.docId} has no English variant`);
  assert.equal(
    variants.length,
    2,
    `${frontmatter.docId} must have two locales`,
  );
  assert.deepEqual(
    new Set(variants.map(({ locale }) => locale)),
    new Set(["en", "zh-CN"]),
  );
  assert.equal(
    new Set(variants.map(({ contentVersion }) => contentVersion)).size,
    1,
  );
}

const openapi = jsonObject(
  JSON.parse(await readFile(resolve(machineRoot, manifest.openapi), "utf8")),
  "OpenAPI document",
);
assert.equal(openapi.openapi, "3.1.0");
const openapiPaths = jsonObject(openapi.paths, "OpenAPI paths");
assert.ok(jsonObject(openapiPaths["/v1/ask"], "OpenAPI /v1/ask").post);
assert.ok(
  jsonObject(openapiPaths["/v1/tts/synthesize"], "OpenAPI /v1/tts/synthesize")
    .post,
);

const englishHome = await readFile(resolve(outputRoot, "index.html"), "utf8");
const chineseHome = await readFile(
  resolve(outputRoot, "zh-cn", "index.html"),
  "utf8",
);
assert.match(englishHome, /<html[^>]+lang="en"/);
assert.match(englishHome, />Sumi Agentic Voice CRM<\/h1>/);
assert.match(chineseHome, /<html[^>]+lang="zh-CN"/);
assert.match(chineseHome, />Sumi 智能语音 CRM<\/h1>/);
assert.match(chineseHome, /href="\/zh-cn\/quickstart\/"/);

console.log(
  `Verified ${manifest.documents.length} machine documents, ${chineseDocuments.length} Chinese variants, rendered routes, and OpenAPI.`,
);
