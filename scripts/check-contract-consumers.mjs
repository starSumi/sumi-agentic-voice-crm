import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The protocol manifest is the source of truth when it declares consumer roots.
 * Older manifests do not have that optional field yet, so the current frontend
 * workbench remains the safe default.
 */
export const DEFAULT_CONSUMER_ROOTS = ["src/scripts", "packages/api-client/src/contract-fixture.ts"];
export const API_OPERATIONS = new Set(["ask", "synthesize", "decideReview"]);
export const TRANSPORT_DTOS = new Set([
  "AskRequest",
  "AskResponse",
  "TtsRequest",
  "ReviewResponse",
  "ErrorEnvelope",
]);

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

function slash(path) {
  return path.replaceAll("\\", "/");
}

function relativePath(root, path) {
  return slash(relative(root, path)) || ".";
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}

/**
 * Mask comments and string literals while preserving offsets and newlines.
 * This keeps the checker intentionally lexical: comments and prose cannot
 * trigger a transport rule, while URL strings are inspected separately.
 */
function lexicalScan(source) {
  const code = [...source];
  const commentText = [...source];
  const strings = [];
  let mode = "code";
  let quote = "";
  let stringStart = -1;
  let value = "";

  const blank = (target, index) => {
    if (target[index] !== "\n" && target[index] !== "\r") target[index] = " ";
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (mode === "line-comment") {
      blank(code, index);
      blank(commentText, index);
      if (current === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      blank(code, index);
      blank(commentText, index);
      if (current === "*" && next === "/") {
        blank(code, index + 1);
        blank(commentText, index + 1);
        index += 1;
        mode = "code";
      }
      continue;
    }
    if (mode === "string") {
      blank(code, index);
      if (current === "\\") {
        value += current;
        if (index + 1 < source.length) {
          value += source[index + 1];
          blank(code, index + 1);
          index += 1;
        }
        continue;
      }
      if (current === quote) {
        strings.push({ start: stringStart, end: index + 1, value });
        mode = "code";
        quote = "";
        stringStart = -1;
        value = "";
        continue;
      }
      value += current;
      continue;
    }

    if (current === "/" && next === "/") {
      blank(code, index);
      blank(code, index + 1);
      blank(commentText, index);
      blank(commentText, index + 1);
      index += 1;
      mode = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      blank(code, index);
      blank(code, index + 1);
      blank(commentText, index);
      blank(commentText, index + 1);
      index += 1;
      mode = "block-comment";
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      blank(code, index);
      mode = "string";
      quote = current;
      stringStart = index;
      value = "";
      continue;
    }
  }

  return { code: code.join(""), commentsMasked: commentText.join(""), strings };
}

function asRootPath(root, consumerRoot) {
  return isAbsolute(consumerRoot) ? resolve(consumerRoot) : resolve(root, consumerRoot);
}

function flattenRootCandidate(candidate) {
  if (typeof candidate === "string") return [candidate];
  if (Array.isArray(candidate)) return candidate.flatMap(flattenRootCandidate);
  if (!candidate || typeof candidate !== "object") return [];
  return [candidate.root, candidate.path, candidate.directory, candidate.dir]
    .flatMap(flattenRootCandidate);
}

function manifestConsumerRoots(manifest) {
  if (!manifest || typeof manifest !== "object") return [];
  const candidates = [
    manifest.consumer_roots,
    manifest.consumerRoots,
    manifest.consumers?.roots,
    manifest.consumers?.frontend_roots,
    manifest.consumers?.frontend,
    manifest.consumer_inventory?.roots,
    manifest.generated?.consumer_roots,
  ];
  return [...new Set(candidates.flatMap(flattenRootCandidate).filter(Boolean))];
}

async function configuredConsumerRoots(root, consumerRoots) {
  if (consumerRoots !== undefined) {
    const explicit = Array.isArray(consumerRoots) ? consumerRoots : [consumerRoots];
    return [...new Set(explicit.filter(Boolean).map(String))];
  }
  const manifestPath = join(root, "protocol", "protocol.manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const fromManifest = manifestConsumerRoots(manifest);
    if (fromManifest.length) return fromManifest;
  } catch {
    // A fixture or a source checkout may intentionally omit the manifest.
  }
  return [...DEFAULT_CONSUMER_ROOTS];
}

async function sourceFiles(rootPath) {
  const details = await stat(rootPath).catch(() => undefined);
  if (!details) return [];
  if (details.isFile()) return SOURCE_EXTENSIONS.has(rootPath.slice(rootPath.lastIndexOf(".")).toLowerCase()) ? [rootPath] : [];
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) found.push(path);
    }
  }
  await walk(rootPath);
  return found.sort();
}

function canonicalApiModule({ root, file, specifier }) {
  const normalizedSpecifier = slash(specifier).replace(/\.tsx?$/, "").replace(/\.m?js$/, "");
  const packageMatch = /^(?:packages\/api-client\/src|@sumi\/voice-crm-api-client)(?:\/(api|protocol))?$/.exec(normalizedSpecifier);
  if (packageMatch) return packageMatch[1] ?? "index";
  if (!specifier.startsWith(".")) return undefined;
  const resolved = resolve(dirname(file), specifier);
  const rel = relativePath(root, resolved).replace(/\.(tsx?|m?js)$/, "");
  const localMatch = /^packages\/api-client\/src\/(index|api|protocol)$/.exec(rel);
  return localMatch?.[1];
}

function parseImports(source, commentsMasked, code) {
  const imports = [];
  const pattern = /\bimport\s+([\s\S]*?)\s+from\s+(["'])([^"']+)\2/g;
  let match;
  while ((match = pattern.exec(commentsMasked))) {
    if (code.slice(match.index, match.index + 6) !== "import") continue;
    const clause = match[1];
    const names = new Map();
    const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
    if (named) {
      for (const item of named.split(",")) {
        const tokens = item.trim().split(/\s+as\s+/);
        const imported = tokens[0]?.replace(/^type\s+/, "").trim();
        const local = tokens[1]?.trim() || imported;
        if (imported) names.set(local, imported);
      }
    }
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)?.[1];
    imports.push({ specifier: match[3], names, namespace, start: match.index, end: pattern.lastIndex });
  }
  return imports;
}

function checkSource({ root, file, source }) {
  const { code, commentsMasked, strings } = lexicalScan(source);
  const path = relativePath(root, file);
  const violations = [];
  const add = (index, rule, message) => violations.push({ path, line: lineAt(source, index), rule, message });

  for (const match of code.matchAll(/\bfetch\s*\(/g)) add(match.index, "raw-fetch", "use an operation from packages/api-client/src/api");
  for (const match of code.matchAll(/\b(?:axios|ky|ofetch|XMLHttpRequest)\b/g)) add(match.index, "transport-library", "raw transport clients are not allowed in consumer roots");
  for (const token of strings) if (token.value.includes("/v1/")) add(token.start, "literal-v1-url", "use the generated SDK instead of a literal /v1/ URL");

  const imports = parseImports(source, commentsMasked, code);
  const dtoPattern = /\b(?:type|interface|class|enum|function|const|let|var)\s+(AskRequest|AskResponse|TtsRequest|ReviewResponse|ErrorEnvelope)\b/g;
  for (const match of code.matchAll(dtoPattern)) {
    const inImport = imports.some((entry) => match.index >= entry.start && match.index < entry.end);
    if (!inImport) add(match.index, "transport-dto-declaration", `do not redeclare generated transport DTO ${match[1]}`);
  }

  const operationAliases = new Set();
  const operationNamespaces = new Set();
  let canonicalSdkOperation = false;
  for (const entry of imports) {
    const canonical = canonicalApiModule({ root, file, specifier: entry.specifier });
    for (const [local, imported] of entry.names) if (API_OPERATIONS.has(imported)) operationAliases.add(local);
    if (entry.namespace) operationNamespaces.add(entry.namespace);
    if (canonical === "api" || canonical === "index") {
      for (const [, imported] of entry.names) if (API_OPERATIONS.has(imported)) {
        canonicalSdkOperation = true;
      }
    }
  }

  let operationCall = false;
  for (const alias of operationAliases) if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\(`).test(code)) operationCall = true;
  for (const namespace of operationNamespaces) {
    if (new RegExp(`\\b${namespace.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\.\\s*(?:ask|synthesize|decideReview)\\s*\\(`).test(code)) operationCall = true;
  }

  const apiCall = /\bfetch\s*\(|\b(?:axios|ky|ofetch)\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*\(|\bnew\s+XMLHttpRequest\s*\(|\b(?:client|apiClient|http)\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/.test(code) || operationCall || strings.some((token) => token.value.includes("/v1/"));
  if (apiCall && !canonicalSdkOperation) add(0, "missing-sdk-operation", "API calls must import an operation from packages/api-client/src/api");
  return violations;
}

/**
 * Check only the configured consumer roots. The function performs no network
 * or service work and returns structured findings for CI and fixture tests.
 */
export async function checkContractConsumers({ root = process.cwd(), consumerRoots } = {}) {
  const absoluteRoot = resolve(root);
  const configured = await configuredConsumerRoots(absoluteRoot, consumerRoots);
  const files = [];
  const violations = [];
  for (const configuredRoot of configured) {
    const rootPath = asRootPath(absoluteRoot, configuredRoot);
    if (!existsSync(rootPath)) {
      violations.push({ path: relativePath(absoluteRoot, rootPath), line: 1, rule: "consumer-root", message: "configured consumer root does not exist" });
      continue;
    }
    for (const file of await sourceFiles(rootPath)) {
      files.push(relativePath(absoluteRoot, file));
      const source = await readFile(file, "utf8");
      if (source.trim()) violations.push(...checkSource({ root: absoluteRoot, file, source }));
    }
  }
  return { root: absoluteRoot, consumerRoots: configured, files: [...new Set(files)].sort(), violations, ok: violations.length === 0 };
}

export function formatViolations(result) {
  return result.violations.map((finding) => `${finding.path}:${finding.line}: ${finding.rule}: ${finding.message}`).join("\n");
}

async function main() {
  const result = await checkContractConsumers({ root: process.cwd() });
  if (!result.ok) {
    console.error(formatViolations(result));
    process.exitCode = 1;
    return;
  }
  console.log(`contract consumer check passed: ${result.files.length} file(s) in ${result.consumerRoots.join(", ") || "no roots"}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
