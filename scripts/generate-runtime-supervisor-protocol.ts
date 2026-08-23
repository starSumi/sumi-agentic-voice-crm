import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnCargoSync } from "./run-cargo.ts";

/** Generate supervisor schema and TypeScript bindings from the Rust source types. */
export function generateRuntimeSupervisorProtocol({
  outputRoot = ".",
}: { outputRoot?: string } = {}): void {
  const result = spawnCargoSync(
    [
      "run",
      "--locked",
      "--package",
      "sumi-runtime-supervisor",
      "--bin",
      "sumi-runtime-supervisor",
      "--",
      "--generate-protocol",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, PROTOCOL_OUTPUT_ROOT: resolve(outputRoot) },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Rust supervisor protocol generator exited with ${result.status ?? 1}`,
    );
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  generateRuntimeSupervisorProtocol({
    outputRoot: process.env.PROTOCOL_OUTPUT_ROOT ?? ".",
  });
}
