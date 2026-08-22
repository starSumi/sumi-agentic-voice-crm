import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  orchestrationProjectionFiles,
  selectRunnableTasks,
  validateOrchestrationSpec,
  validateTaskPlan,
} from "./src/index.ts";
import type { OrchestrationSpec, RuntimeState, TaskPlan } from "./src/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPaths = {
  orchestration: "orchestration/orchestration.schema.json",
  plan: "orchestration/plan.schema.json",
  runtime: "orchestration/runtime-state.schema.json",
  task: "orchestration/task-packet.schema.json",
} as const;

type SchemaName = keyof typeof schemaPaths;

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
}

async function validators(): Promise<Record<SchemaName, ValidateFunction>> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);
  const schemas = await Promise.all(
    Object.entries(schemaPaths).map(
      async ([name, path]) =>
        [name, await readJson<Record<string, unknown>>(path)] as const,
    ),
  );
  for (const [, schema] of schemas) ajv.addSchema(schema);
  return Object.fromEntries(
    schemas.map(([name, schema]) => [name, ajv.getSchema(String(schema.$id))!]),
  ) as Record<SchemaName, ValidateFunction>;
}

function assertSchema(
  validate: ValidateFunction,
  value: unknown,
  label: string,
): void {
  if (!validate(value))
    throw new Error(
      `${label} failed schema validation: ${formatErrors(validate.errors)}`,
    );
}

export async function loadOrchestrationSpec(): Promise<OrchestrationSpec> {
  const source = parseYaml(
    await readFile(resolve(root, "orchestration/orchestration.yaml"), "utf8"),
  ) as OrchestrationSpec;
  const checks = await validators();
  assertSchema(checks.orchestration, source, "orchestration spec");
  validateOrchestrationSpec(source);
  return source;
}

async function expectedCustomAgentPaths(
  spec: OrchestrationSpec,
): Promise<string[]> {
  return spec.roles
    .filter((role) => role.projection === "custom")
    .map((role) => `${spec.projections.codex.agents_directory}/${role.id}.toml`)
    .sort();
}

export async function generateProjections(): Promise<string[]> {
  const spec = await loadOrchestrationSpec();
  const files = orchestrationProjectionFiles(spec);
  for (const [path, content] of files) {
    const destination = resolve(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return [...files.keys()].sort();
}

export async function checkProjections(): Promise<string[]> {
  const spec = await loadOrchestrationSpec();
  const files = orchestrationProjectionFiles(spec);
  for (const [path, expected] of files) {
    const actual = await readFile(resolve(root, path), "utf8").catch(() => "");
    if (actual !== expected)
      throw new Error(`${path} drifted; run pnpm run orchestration:generate`);
    if (path.endsWith(".toml")) parseToml(actual.replace(/^#.*\n/, ""));
    if (path.endsWith(".yaml")) parseYaml(actual);
  }
  const agentsDirectory = resolve(
    root,
    spec.projections.codex.agents_directory,
  );
  const actualAgents = (await readdir(agentsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .map((entry) => `${spec.projections.codex.agents_directory}/${entry.name}`)
    .sort();
  const expectedAgents = await expectedCustomAgentPaths(spec);
  if (JSON.stringify(actualAgents) !== JSON.stringify(expectedAgents)) {
    throw new Error(
      `unexpected Codex role projection set: ${actualAgents.join(", ")}`,
    );
  }
  return [...files.keys()].sort();
}

export async function selectNext(
  planPath: string,
  statePath: string,
): Promise<string[]> {
  const spec = await loadOrchestrationSpec();
  const checks = await validators();
  const plan = await readJson<TaskPlan>(
    relative(root, resolve(root, planPath)),
  );
  const state = await readJson<RuntimeState>(
    relative(root, resolve(root, statePath)),
  );
  assertSchema(checks.plan, plan, "task plan");
  assertSchema(checks.runtime, state, "runtime state");
  validateTaskPlan(plan, spec);
  return selectRunnableTasks(plan, state, spec).map(({ task_id }) => task_id);
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "generate") {
    const files = await generateProjections();
    console.log(`generated ${files.length} orchestration projection(s)`);
    return;
  }
  if (command === "check") {
    const files = await checkProjections();
    console.log(`orchestration check passed: ${files.length} projection(s)`);
    return;
  }
  if (command === "next") {
    const planIndex = rest.indexOf("--plan");
    const stateIndex = rest.indexOf("--state");
    if (
      planIndex < 0 ||
      stateIndex < 0 ||
      !rest[planIndex + 1] ||
      !rest[stateIndex + 1]
    ) {
      throw new Error(
        "usage: orchestration/cli.ts next --plan <path> --state <path>",
      );
    }
    console.log(
      JSON.stringify(
        {
          runnable_tasks: await selectNext(
            rest[planIndex + 1],
            rest[stateIndex + 1],
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("usage: orchestration/cli.ts <generate|check|next>");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
