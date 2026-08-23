import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { loadAgentCrmContract } from "./generate-agent-crm-contract.ts";

type JsonRecord = Record<string, any>;
type DatasetDefinition = { required_entity_paths: string[] };
type DatasetExample = {
  example_id: string;
  group_id: string;
  split: string;
  locale: string;
  input: { text: string };
  expected: { intent: string; entities: JsonRecord; missing: string[] };
};

function valueAtPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce(
      (current: unknown, segment: string) =>
        current && typeof current === "object"
          ? (current as JsonRecord)[segment]
          : undefined,
      value,
    );
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export async function validateAgentCrmDataset(
  contents: string,
  { requireAllIntents = true }: { requireAllIntents?: boolean } = {},
) {
  if (typeof contents !== "string")
    throw new TypeError("dataset contents must be a string");
  const { registry, trainingExampleSchema } = await loadAgentCrmContract();
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
  }).compile<DatasetExample>(trainingExampleSchema);
  const definitions = new Map<string, DatasetDefinition>(
    registry.intents.map((entry) => [entry.id, entry]),
  );
  const exampleIds = new Set();
  const groupSplits = new Map();
  const inputs = new Map();
  const observedIntents = new Set();
  const errors: string[] = [];
  let examples = 0;

  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineNumber = index + 1;
    let example: DatasetExample;
    try {
      example = JSON.parse(line);
    } catch (error) {
      errors.push(
        `line ${lineNumber}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    examples += 1;
    if (!validate(example)) {
      errors.push(
        `line ${lineNumber}: schema ${JSON.stringify(validate.errors)}`,
      );
      continue;
    }
    if (exampleIds.has(example.example_id))
      errors.push(
        `line ${lineNumber}: duplicate example_id ${example.example_id}`,
      );
    exampleIds.add(example.example_id);

    const previousSplit = groupSplits.get(example.group_id);
    if (previousSplit && previousSplit !== example.split) {
      errors.push(
        `line ${lineNumber}: group_id ${example.group_id} crosses dataset splits`,
      );
    }
    groupSplits.set(example.group_id, example.split);

    const inputKey = `${example.locale}\u0000${example.input.text.trim()}`;
    const expectedKey = JSON.stringify(example.expected);
    const previousExpected = inputs.get(inputKey);
    if (previousExpected && previousExpected !== expectedKey) {
      errors.push(
        `line ${lineNumber}: identical input has conflicting expected output`,
      );
    } else if (previousExpected) {
      errors.push(`line ${lineNumber}: duplicate normalized input`);
    }
    inputs.set(inputKey, expectedKey);

    const definition = definitions.get(example.expected.intent);
    if (!definition) continue;
    observedIntents.add(example.expected.intent);
    for (const path of definition.required_entity_paths) {
      const hasValue = present(valueAtPath(example.expected.entities, path));
      const declaredMissing = example.expected.missing.includes(path);
      if (!hasValue && !declaredMissing)
        errors.push(
          `line ${lineNumber}: absent ${path} must be declared in missing`,
        );
      if (hasValue && declaredMissing)
        errors.push(
          `line ${lineNumber}: present ${path} cannot also be declared missing`,
        );
    }
  }

  if (examples === 0) errors.push("dataset contains no examples");
  if (requireAllIntents) {
    for (const { id } of registry.intents) {
      if (!observedIntents.has(id))
        errors.push(`dataset does not cover implemented intent ${id}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `agent CRM dataset validation failed:\n${errors.join("\n")}`,
    );
  }
  return Object.freeze({ examples, intents: [...observedIntents].sort() });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  const datasetPath = process.argv[2];
  if (!datasetPath) {
    throw new Error("usage: pnpm run dataset:validate -- <dataset.jsonl>");
  }
  const result = await validateAgentCrmDataset(
    await readFile(datasetPath, "utf8"),
  );
  console.log(
    `agent CRM dataset passed: ${result.examples} examples, ${result.intents.join(", ")}`,
  );
}
