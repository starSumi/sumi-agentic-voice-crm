import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const roots = [
  "protocol/schema/json",
  "packages/api-client/src/generated",
  "src/extensions/generated",
  "src/generated",
];
const exactFiles = ["contracts/runtime-supervisor.schema.json"];

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return found.sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const generated = await mkdtemp(join(tmpdir(), "sumi-protocol-"));
try {
  const result = spawnSync(process.execPath, ["scripts/generate-protocol.ts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PROTOCOL_OUTPUT_ROOT: generated },
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const differences = [];
  for (const root of roots) {
    const committedRoot = join(repositoryRoot, root);
    const generatedRoot = join(generated, root);
    const committedExists = await exists(committedRoot);
    const generatedExists = await exists(generatedRoot);
    if (!committedExists)
      differences.push(`${root}: committed projection is missing`);
    if (!generatedExists)
      differences.push(`${root}: temporary projection was not generated`);
    if (!committedExists || !generatedExists) continue;
    const expected = await files(committedRoot);
    const actual = await files(generatedRoot);
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      differences.push(`${root}: file list changed`);
    for (const path of new Set([...expected, ...actual])) {
      try {
        const [left, right] = await Promise.all([
          readFile(join(committedRoot, path)),
          readFile(join(generatedRoot, path)),
        ]);
        if (!left.equals(right))
          differences.push(`${root}/${path}: content changed`);
      } catch {
        differences.push(`${root}/${path}: added or removed`);
      }
    }
  }
  for (const path of exactFiles) {
    const committedPath = join(repositoryRoot, path);
    const generatedPath = join(generated, path);
    const committedExists = await exists(committedPath);
    const generatedExists = await exists(generatedPath);
    if (!committedExists)
      differences.push(`${path}: committed projection is missing`);
    if (!generatedExists)
      differences.push(`${path}: temporary projection was not generated`);
    if (!committedExists || !generatedExists) continue;
    const [committed, actual] = await Promise.all([
      readFile(committedPath),
      readFile(generatedPath),
    ]);
    if (!committed.equals(actual)) differences.push(`${path}: content changed`);
  }
  if (differences.length) {
    throw new Error(
      `generated protocol drift:\n${[...new Set(differences)].join("\n")}\nRun pnpm run protocol:generate and review the projections.`,
    );
  }
  console.log("protocol drift check passed");
} finally {
  await rm(generated, { recursive: true, force: true });
}
