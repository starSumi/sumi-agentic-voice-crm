import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ISSUE_TITLE = "[CI Operations] main requires attention";
const TERMINAL_SUCCESS = new Set(["success"]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function clean(value, maximum = 500) {
  return String(value ?? "unknown").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

async function githubRequest(fetchImpl, token, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? "GET"} ${url} failed: ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function reconcileCiIncident({
  fetchImpl = fetch,
  token,
  repository,
  conclusion,
  runUrl,
  headSha,
  reason,
  eventName,
  now = new Date(),
} = {}) {
  requireValue(typeof token === "string" && token.length > 0, "GITHUB_TOKEN is required");
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "GITHUB_REPOSITORY is invalid");
  requireValue(/^[a-z_]+$/.test(conclusion), "operations conclusion is invalid");
  requireValue(/^[0-9a-f]{40}$/.test(headSha), "operations head SHA is invalid");
  const expectedPrefix = `https://github.com/${repository}/actions/runs/`;
  requireValue(typeof runUrl === "string" && runUrl.startsWith(expectedPrefix), "operations run URL is invalid");

  const apiRoot = `https://api.github.com/repos/${repository}`;
  const issues = await githubRequest(
    fetchImpl,
    token,
    `${apiRoot}/issues?state=open&per_page=100`,
  );
  const matching = issues.filter((issue) => !issue.pull_request && issue.title === ISSUE_TITLE);
  const timestamp = now.toISOString();
  const details = [
    `- Result: \`${clean(conclusion, 32)}\``,
    `- Reason: ${clean(reason)}`,
    `- Event: \`${clean(eventName, 64)}\``,
    `- Commit: \`${headSha}\``,
    `- Run: ${runUrl}`,
    `- Observed: \`${timestamp}\``,
  ].join("\n");

  if (TERMINAL_SUCCESS.has(conclusion)) {
    for (const issue of matching) {
      await githubRequest(fetchImpl, token, `${apiRoot}/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `Main health recovered.\n\n${details}` }),
      });
      await githubRequest(fetchImpl, token, `${apiRoot}/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
    }
    return { action: matching.length > 0 ? "closed" : "none", count: matching.length };
  }

  const body = [
    "The trusted main-branch operations workflow requires human attention.",
    "",
    details,
    "",
    "The CI Operations Agent does not edit source, advance checkpoints, or publish a release. Review the run, assign an owner, and preserve rollback evidence.",
  ].join("\n");
  if (matching.length > 0) {
    await githubRequest(fetchImpl, token, `${apiRoot}/issues/${matching[0].number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    return { action: "commented", count: 1 };
  }
  const created = await githubRequest(fetchImpl, token, `${apiRoot}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: ISSUE_TITLE, body }),
  });
  return { action: "created", count: 1, issueNumber: created.number };
}

async function runCli(environment = process.env) {
  const result = await reconcileCiIncident({
    token: environment.GITHUB_TOKEN,
    repository: environment.GITHUB_REPOSITORY,
    conclusion: environment.SUMI_OPS_CONCLUSION,
    runUrl: environment.SUMI_OPS_RUN_URL,
    headSha: environment.SUMI_OPS_HEAD_SHA,
    reason: environment.SUMI_OPS_REASON,
    eventName: environment.GITHUB_EVENT_NAME,
  });
  console.log(`CI incident reconciliation: ${result.action}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
