import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const toolchain = readFileSync(
  resolve(root, "rust-toolchain.toml"),
  "utf8",
).match(/^channel\s*=\s*"([^"]+)"/m)?.[1];

if (!/^\d+\.\d+\.\d+$/.test(toolchain ?? "")) {
  throw new Error("rust-toolchain.toml must pin an exact stable release");
}

function localStableMatches() {
  const result = spawnSync("rustc", ["+stable", "--version"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.startsWith(`rustc ${toolchain} `);
}

export function cargoBuildEnvironment(environment = process.env) {
  const cargoHome = resolve(
    environment.CARGO_HOME || resolve(homedir(), ".cargo"),
  );
  const result = { ...environment };
  delete result.RUSTFLAGS;
  result.CARGO_INCREMENTAL = "0";
  result.CARGO_ENCODED_RUSTFLAGS = [
    `--remap-path-prefix=${root}=/workspace`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
  ].join("\u001f");
  return result;
}

export function spawnCargoSync(args, options = {}) {
  const useLocalStable = localStableMatches();
  const command = useLocalStable ? "rustup" : "cargo";
  const commandArgs = useLocalStable
    ? ["run", "stable", "cargo", ...args]
    : args;
  const { env = process.env, ...spawnOptions } = options;
  return spawnSync(command, commandArgs, {
    cwd: root,
    windowsHide: true,
    ...spawnOptions,
    env: cargoBuildEnvironment(env),
  });
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = spawnCargoSync(process.argv.slice(2), { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
