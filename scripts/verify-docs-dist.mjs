import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const outputRoot = resolve("artifacts", "docs-site");
const machineRoot = resolve(outputRoot, "_mcp");
const manifest = JSON.parse(
  await readFile(resolve(machineRoot, "sumi-docs-manifest.json"), "utf8"),
);
const routeMap = JSON.parse(
  await readFile(resolve(machineRoot, "sumi-docs-routes.json"), "utf8"),
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

const pageFile = (page) =>
  page === "/" ? "index.html" : `${page.slice(1)}index.html`;
const variantsById = new Map();

for (const document of manifest.documents) {
  assert.match(document, /^[a-z0-9_/-]+\.md$/);
  const raw = await readFile(
    resolve(machineRoot, ...document.split("/")),
    "utf8",
  );
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  assert.ok(frontmatterMatch, `${document} is missing YAML frontmatter`);
  const frontmatter = parseYaml(frontmatterMatch[1]);
  assert.match(frontmatter.docId, /^crm\.[a-z0-9.-]+$/);
  assert.ok(["en", "zh-CN"].includes(frontmatter.locale));
  assert.ok(["human", "agent", "both"].includes(frontmatter.audience));
  assert.equal(frontmatter.contentVersion, "0.1.0");
  assert.equal(
    frontmatter.locale,
    document.startsWith("zh-cn/") ? "zh-CN" : "en",
  );

  const variants = variantsById.get(frontmatter.docId) ?? [];
  variants.push({ document, ...frontmatter });
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
  const frontmatter = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)[1]);
  const variants = variantsById.get(frontmatter.docId);
  assert.equal(variants.length, 2, `${frontmatter.docId} must have two locales`);
  assert.deepEqual(
    new Set(variants.map(({ locale }) => locale)),
    new Set(["en", "zh-CN"]),
  );
  assert.equal(new Set(variants.map(({ contentVersion }) => contentVersion)).size, 1);
}

const openapi = JSON.parse(
  await readFile(resolve(machineRoot, manifest.openapi), "utf8"),
);
assert.equal(openapi.openapi, "3.1.0");
assert.ok(openapi.paths["/v1/ask"]?.post);
assert.ok(openapi.paths["/v1/tts/synthesize"]?.post);

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
