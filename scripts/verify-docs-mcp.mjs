import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

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

await new Promise((resolveListen, rejectListen) => {
  staticServer.once("error", rejectListen);
  staticServer.listen(0, "127.0.0.1", resolveListen);
});
const address = staticServer.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/`;

const child = spawn(
  process.execPath,
  [mcpEntry, "serve", `${baseUrl}_mcp/`, "--base-url", baseUrl],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
const responses = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (typeof message.id === "number") responses.set(message.id, message);
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
const calls = [
  [1, "tools/list", {}],
  [2, "tools/call", { name: "list_docs", arguments: {} }],
  [3, "tools/call", { name: "search_docs", arguments: { query: "idempotency" } }],
  [4, "tools/call", { name: "fetch_doc", arguments: { path: "agent-guide.md" } }],
  [5, "tools/call", { name: "get_openapi_spec", arguments: { endpoint: "/v1/ask" } }],
  [6, "tools/call", { name: "search_docs", arguments: { query: "低置信度" } }],
  [7, "tools/call", { name: "fetch_doc", arguments: { path: "zh-cn/agent-guide.md" } }],
  [8, "tools/call", { name: "search_docs", arguments: { query: "ASR_TIMEOUT" } }],
  [9, "tools/call", { name: "search_docs", arguments: { query: "continuity-supervisor" } }],
  [10, "tools/call", { name: "fetch_doc", arguments: { path: "maintenance.md" } }],
  [11, "tools/call", { name: "fetch_doc", arguments: { path: "zh-cn/maintenance.md" } }],
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

  const toolNames = responses.get(1)?.result?.tools?.map(({ name }) => name);
  assert.deepEqual(
    new Set(toolNames),
    new Set(["list_docs", "search_docs", "fetch_doc", "get_openapi_spec"]),
  );
  const parseToolResult = (id) =>
    JSON.parse(responses.get(id)?.result?.content?.[0]?.text ?? "null");
  const listed = parseToolResult(2);
  assert.equal(listed.length, 40);
  assert.equal(
    listed.find(({ path }) => path === "agent-guide.md")?.url,
    `${baseUrl}agent-guide`,
  );
  assert.ok(
    parseToolResult(3).some(({ path }) => path === "agent-guide.md"),
    "idempotency search should reach the agent onboarding contract",
  );
  assert.match(parseToolResult(4)?.content ?? "", /Discovery sequence/);
  assert.deepEqual(Object.keys(parseToolResult(5)?.paths ?? {}), ["/v1/ask"]);
  const chineseResults = parseToolResult(6);
  assert.ok(chineseResults.length > 0);
  assert.ok(chineseResults.every(({ path }) => path.startsWith("zh-cn/")));
  assert.match(parseToolResult(7)?.content ?? "", /推荐发现顺序/);
  assert.ok(
    parseToolResult(8).some(({ path }) =>
      ["operations.md", "troubleshooting.md", "zh-cn/operations.md"].includes(
        path,
      ),
    ),
  );
  assert.ok(
    parseToolResult(9).some(({ path }) => path === "maintenance.md"),
    "continuity search should reach the maintenance contract",
  );
  assert.match(parseToolResult(10)?.content ?? "", /State ownership/);
  assert.match(parseToolResult(11)?.content ?? "", /状态归属/);

  const routeMap = JSON.parse(
    await readFile(
      resolve(outputRoot, "_mcp", "sumi-docs-routes.json"),
      "utf8",
    ),
  );
  for (const document of listed) {
    const expectedPage = new URL(routeMap.routes[document.path], baseUrl).href;
    const normalizedActual = document.url.endsWith("/")
      ? document.url
      : `${document.url}/`;
    assert.equal(normalizedActual, expectedPage);
    const pageResponse = await fetch(expectedPage);
    assert.equal(pageResponse.status, 200, `${expectedPage} did not resolve`);
    assert.match(pageResponse.headers.get("content-type") ?? "", /^text\/html/);
  }

  console.log(
    `Verified all four MCP tools, bilingual development-partner queries, and ${listed.length} human page URLs.`,
  );
} finally {
  lines.close();
  child.kill();
  await new Promise((resolveClose) => staticServer.close(resolveClose));
}
