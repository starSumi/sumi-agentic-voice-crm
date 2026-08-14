import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const DOCUMENT_PATH = /^[a-zA-Z0-9_/-]+\.md$/;
const OPENAPI_SOURCE_PATH = /^[a-zA-Z0-9_/-]+\.(?:json|ya?ml)$/;
const OPENAPI_OUTPUT_PATH = /^[a-zA-Z0-9_/-]+\.json$/;

function assertRelativePath(value, pattern, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    !pattern.test(value) ||
    value.startsWith("/") ||
    value.includes("//") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a restricted relative path.`);
  }
}

function assertContained(root, candidate) {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(normalizedRoot)) {
    throw new Error("Publishing path escapes its configured root.");
  }
}

export function normalizePublisherOptions(options = {}) {
  const sourceRoot = options.sourceRoot ?? "docs";
  assertRelativePath(sourceRoot, /^[a-zA-Z0-9_/-]+$/, "Document source root");
  if (!Array.isArray(options.documents) || options.documents.length === 0) {
    throw new Error("Publisher requires at least one document mapping.");
  }
  if (options.documents.length > 1000) {
    throw new Error("Publisher supports at most 1000 documents.");
  }

  const seenSources = new Set();
  const seenMachinePaths = new Set();
  const seenPages = new Set();
  const documents = options.documents.map((document) => {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("Every document mapping must be an object.");
    }
    if (
      Object.keys(document).some(
        (key) => !["source", "machine", "page"].includes(key),
      )
    ) {
      throw new Error("Document mapping contains an unknown field.");
    }
    assertRelativePath(document.source, DOCUMENT_PATH, "Document source");
    assertRelativePath(document.machine, DOCUMENT_PATH, "Machine document");
    if (
      typeof document.page !== "string" ||
      !document.page.startsWith("/") ||
      document.page.includes("..") ||
      document.page.includes("?") ||
      document.page.includes("#")
    ) {
      throw new Error("Document page must be an absolute site path.");
    }
    const page = document.page.endsWith("/")
      ? document.page
      : `${document.page}/`;
    if (
      seenSources.has(document.source) ||
      seenMachinePaths.has(document.machine) ||
      seenPages.has(page)
    ) {
      throw new Error("Document source, machine paths, and routes must be unique.");
    }
    seenSources.add(document.source);
    seenMachinePaths.add(document.machine);
    seenPages.add(page);
    return { source: document.source, machine: document.machine, page };
  });

  let openapi;
  if (options.openapi !== undefined) {
    if (
      !options.openapi ||
      typeof options.openapi !== "object" ||
      Array.isArray(options.openapi) ||
      Object.keys(options.openapi).some(
        (key) => !["source", "output"].includes(key),
      )
    ) {
      throw new Error("OpenAPI mapping must contain source and output paths.");
    }
    assertRelativePath(
      options.openapi.source,
      OPENAPI_SOURCE_PATH,
      "OpenAPI source",
    );
    assertRelativePath(
      options.openapi.output,
      OPENAPI_OUTPUT_PATH,
      "OpenAPI output",
    );
    openapi = { ...options.openapi };
  }

  return { sourceRoot, documents, ...(openapi && { openapi }) };
}

export default function sumiDocsPublisher(rawOptions) {
  const options = normalizePublisherOptions(rawOptions);
  let projectRoot;

  return {
    name: "sumi-docs-publisher",
    hooks: {
      "astro:config:done": ({ config }) => {
        projectRoot = fileURLToPath(config.root);
      },
      "astro:build:done": async ({ dir, logger }) => {
        const outputRoot = fileURLToPath(dir);
        const machineRoot = resolve(outputRoot, "_mcp");
        const contentRoot = resolve(
          projectRoot,
          ...options.sourceRoot.split("/"),
        );
        await mkdir(machineRoot, { recursive: true });

        for (const document of options.documents) {
          const source = resolve(contentRoot, ...document.source.split("/"));
          const destination = resolve(
            machineRoot,
            ...document.machine.split("/"),
          );
          assertContained(contentRoot, source);
          assertContained(machineRoot, destination);
          const markdown = await readFile(source, "utf8");
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, markdown);
        }

        if (options.openapi) {
          const source = resolve(
            projectRoot,
            ...options.openapi.source.split("/"),
          );
          const destination = resolve(
            machineRoot,
            ...options.openapi.output.split("/"),
          );
          assertContained(projectRoot, source);
          assertContained(machineRoot, destination);
          const raw = await readFile(source, "utf8");
          const specification = [".yaml", ".yml"].includes(
            extname(source).toLowerCase(),
          )
            ? parseYaml(raw)
            : JSON.parse(raw);
          if (
            !specification ||
            typeof specification !== "object" ||
            !String(specification.openapi ?? "").startsWith("3.")
          ) {
            throw new Error("OpenAPI source must contain an OpenAPI 3.x object.");
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, `${JSON.stringify(specification, null, 2)}\n`);
        }

        const manifest = {
          version: 1,
          documents: options.documents.map(({ machine }) => machine),
          ...(options.openapi && { openapi: options.openapi.output }),
        };
        const routes = Object.fromEntries(
          options.documents.map(({ machine, page }) => [machine, page]),
        );
        await Promise.all([
          writeFile(
            resolve(machineRoot, "sumi-docs-manifest.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
          ),
          writeFile(
            resolve(machineRoot, "sumi-docs-routes.json"),
            `${JSON.stringify({ version: 1, routes }, null, 2)}\n`,
          ),
        ]);
        logger.info(
          `Published ${options.documents.length} documents to ${posix.join("_mcp", "sumi-docs-manifest.json")}.`,
        );
      },
    },
  };
}
