import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  jsonObject,
  stringValue,
  type JsonObject,
} from "./docs-verify-helpers.ts";

type JsonRpcResponse = Readonly<{
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: unknown;
}>;
type DocsResult = Readonly<{ path: string; url?: string; content?: string }>;

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry) => jsonObject(entry, label));
}

function jsonRpcResponse(value: unknown): JsonRpcResponse {
  const message = jsonObject(value, "JSON-RPC response");
  if (message.jsonrpc !== "2.0" || typeof message.id !== "number") {
    throw new TypeError("invalid JSON-RPC response envelope");
  }
  return {
    jsonrpc: "2.0",
    id: message.id,
    result: message.result,
    error: message.error,
  };
}

function docsResult(value: unknown, label: string): DocsResult {
  const entry = jsonObject(value, label);
  if (typeof entry.path !== "string")
    throw new TypeError(`${label} path must be a string`);
  if (entry.url !== undefined && typeof entry.url !== "string")
    throw new TypeError(`${label} url must be a string`);
  if (entry.content !== undefined && typeof entry.content !== "string")
    throw new TypeError(`${label} content must be a string`);
  return { path: entry.path, url: entry.url, content: entry.content };
}

const outputRoot = resolve("artifacts", "docs-site");
const mcpEntry = process.env.SUMI_DOCS_MCP_ENTRY
  ? resolve(process.env.SUMI_DOCS_MCP_ENTRY)
  : resolve("..", "Sumi-Docs-MCP", "dist", "index.js");
await access(mcpEntry);
await access(resolve(outputRoot, "_mcp", "sumi-docs-manifest.json"));

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
]);

const staticServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (relativePath === "" || relativePath.endsWith("/")) {
      relativePath += "index.html";
    }
    const candidate = resolve(outputRoot, ...relativePath.split("/"));
    const rootPrefix = outputRoot.endsWith(sep)
      ? outputRoot
      : `${outputRoot}${sep}`;
    if (candidate !== outputRoot && !candidate.startsWith(rootPrefix)) {
      response.writeHead(404).end();
      return;
    }
    const file = await stat(candidate);
    if (!file.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type":
        contentTypes.get(extname(candidate)) ?? "application/octet-stream",
      "content-length": file.size,
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  staticServer.once("error", rejectListen);
  staticServer.listen(0, "127.0.0.1", () => resolveListen());
});
const address = staticServer.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/`;

const child = spawn(
  process.execPath,
  [mcpEntry, "serve", `${baseUrl}_mcp/`, "--base-url", baseUrl],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
const stderr: string[] = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
const responses = new Map<number, JsonRpcResponse>();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = jsonRpcResponse(JSON.parse(line));
    responses.set(message.id, message);
  } catch {
    // Timeout and response assertions report protocol corruption below.
  }
});

const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "sumi-agentic-voice-crm-docs-e2e",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const calls: Array<readonly [number, string, JsonObject]> = [
  [1, "tools/list", {}],
  [2, "tools/call", { name: "list_docs", arguments: {} }],
  [
    3,
    "tools/call",
    { name: "search_docs", arguments: { query: "idempotency" } },
  ],
  [
    4,
    "tools/call",
    { name: "fetch_doc", arguments: { path: "architecture.md" } },
  ],
  [
    5,
    "tools/call",
    { name: "get_openapi_spec", arguments: { endpoint: "/v1/ask" } },
  ],
  [6, "tools/call", { name: "search_docs", arguments: { query: "低置信度" } }],
  [
    7,
    "tools/call",
    { name: "fetch_doc", arguments: { path: "zh-cn/architecture.md" } },
  ],
  [
    8,
    "tools/call",
    { name: "search_docs", arguments: { query: "ASR_TIMEOUT" } },
  ],
  [9, "tools/call", { name: "search_docs", arguments: { query: "outbox" } }],
  [
    10,
    "tools/call",
    { name: "fetch_doc", arguments: { path: "operations.md" } },
  ],
  [
    11,
    "tools/call",
    { name: "fetch_doc", arguments: { path: "zh-cn/operations.md" } },
  ],
];

try {
  for (const [id, method, params] of calls) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } })}\n`,
    );
  }
  const deadline = Date.now() + 15_000;
  while (responses.size < calls.length && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(
    responses.size,
    calls.length,
    `MCP responses timed out. stderr: ${stderr.join("")}`,
  );

  const toolsResult = jsonObject(responses.get(1)?.result, "tools/list result");
  const toolNames = objectArray(toolsResult.tools, "tools/list tools").map(
    (tool) => {
      if (typeof tool.name !== "string")
        throw new TypeError("tool name must be a string");
      return tool.name;
    },
  );
  assert.deepEqual(
    new Set(toolNames),
    new Set(["list_docs", "search_docs", "fetch_doc", "get_openapi_spec"]),
  );
  const parseToolResult = (id: number): unknown => {
    const result = jsonObject(
      responses.get(id)?.result,
      `tools/call ${id} result`,
    );
    const [content] = objectArray(result.content, `tools/call ${id} content`);
    if (!content || typeof content.text !== "string") {
      throw new TypeError(`tools/call ${id} text content is missing`);
    }
    return JSON.parse(content.text);
  };
  const resultDocuments = (id: number): DocsResult[] => {
    const value = parseToolResult(id);
    if (!Array.isArray(value))
      throw new TypeError(`tools/call ${id} result must be an array`);
    return value.map((entry, index) =>
      docsResult(entry, `tools/call ${id} result[${index}]`),
    );
  };
  const listed = resultDocuments(2);
  assert.equal(listed.length, 33);
  assert.equal(
    listed.find(({ path }) => path === "architecture.md")?.url,
    `${baseUrl}architecture`,
  );
  assert.ok(
    resultDocuments(3).some(({ path }) =>
      ["api.md", "architecture.md", "lifecycle.md"].includes(path),
    ),
    "idempotency search should reach a product contract",
  );
  assert.match(
    stringValue(
      jsonObject(parseToolResult(4), "fetch_doc result").content,
      "fetch_doc content",
    ),
    /Ownership rules/,
  );
  assert.deepEqual(
    Object.keys(
      jsonObject(
        jsonObject(parseToolResult(5), "OpenAPI tool result").paths,
        "OpenAPI tool paths",
      ),
    ),
    ["/v1/ask"],
  );
  const chineseResults = resultDocuments(6);
  assert.ok(chineseResults.length > 0);
  assert.ok(chineseResults.every(({ path }) => path.startsWith("zh-cn/")));
  assert.match(
    stringValue(
      jsonObject(parseToolResult(7), "Chinese fetch_doc result").content,
      "Chinese document content",
    ),
    /系统分为四个平面/,
  );
  assert.ok(
    resultDocuments(8).some(({ path }) =>
      ["operations.md", "troubleshooting.md", "zh-cn/operations.md"].includes(
        path,
      ),
    ),
  );
  assert.ok(
    resultDocuments(9).some(({ path }) =>
      ["architecture.md", "events-audit.md", "operations.md"].includes(path),
    ),
    "outbox search should reach a product operations contract",
  );
  assert.match(
    stringValue(
      jsonObject(parseToolResult(10), "English operations result").content,
      "English operations content",
    ),
    /Common incidents/,
  );
  assert.match(
    stringValue(
      jsonObject(parseToolResult(11), "Chinese operations result").content,
      "Chinese operations content",
    ),
    /outbox 状态/,
  );

  const routeMap = jsonObject(
    JSON.parse(
      await readFile(
        resolve(outputRoot, "_mcp", "sumi-docs-routes.json"),
        "utf8",
      ),
    ),
    "docs route map",
  );
  const routes = jsonObject(routeMap.routes, "docs routes");
  for (const document of listed) {
    const route = routes[document.path];
    if (typeof route !== "string")
      throw new TypeError(`missing route for ${document.path}`);
    if (typeof document.url !== "string")
      throw new TypeError(`missing URL for ${document.path}`);
    const expectedPage = new URL(route, baseUrl).href;
    const normalizedActual = document.url.endsWith("/")
      ? document.url
      : `${document.url}/`;
    assert.equal(normalizedActual, expectedPage);
    const pageResponse = await fetch(expectedPage);
    assert.equal(pageResponse.status, 200, `${expectedPage} did not resolve`);
    assert.match(pageResponse.headers.get("content-type") ?? "", /^text\/html/);
  }

  console.log(
    `Verified all four MCP tools, bilingual product queries, and ${listed.length} human page URLs.`,
  );
} finally {
  lines.close();
  child.kill();
  await new Promise((resolveClose) => staticServer.close(resolveClose));
}
