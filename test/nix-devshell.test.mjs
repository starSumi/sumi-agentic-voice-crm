import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");
const lock = JSON.parse(readFileSync(new URL("../flake.lock", import.meta.url), "utf8"));

function meetsMinimumNodeVersion(version, minimum = [24, 19, 0]) {
  const actual = version.split(".").map(Number);
  return actual[0] > minimum[0]
    || (actual[0] === minimum[0] && (actual[1] > minimum[1]
      || (actual[1] === minimum[1] && actual[2] >= minimum[2])));
}

test("Nix remains an optional shell around the canonical pnpm and Docker workflow", () => {
  assert.equal(packageJson.packageManager, "pnpm@10.33.4");
  assert.equal(packageJson.volta.node, "24.19.0");
  assert.match(flake, /nodejs_24/);
  assert.match(flake, /version = "10\.33\.4"/);
  assert.match(flake, /sha256-9ocTLpPeTn5BjSB01\+EO2\+UlpKpdYPG2AWq14RJ8Myg=/);
  assert.match(flake, /docker-client/);
  assert.match(flake, /docker-compose/);
  for (const rustTool of ["pkgs.rustc", "pkgs.cargo", "pkgs.clippy", "pkgs.rustfmt"]) {
    assert.ok(flake.includes(rustTool), `Nix shell is missing ${rustTool}`);
  }
  assert.match(flake, /src\/Cargo\.lock/);
  assert.match(flake, /rust-toolchain\.toml/);
  assert.match(flake, /services remain stopped/);
  assert.doesNotMatch(flake, /pnpm install/);
  assert.doesNotMatch(flake, /docker compose up/);
  assert.match(flake, /actual\[0\] > minimum\[0\]/);
});

test("Nix Node minimum uses lexicographic major-minor-patch ordering", () => {
  assert.equal(meetsMinimumNodeVersion("23.99.99"), false);
  assert.equal(meetsMinimumNodeVersion("24.18.99"), false);
  assert.equal(meetsMinimumNodeVersion("24.19.0"), true);
  assert.equal(meetsMinimumNodeVersion("24.19.1"), true);
  assert.equal(meetsMinimumNodeVersion("25.0.0"), true);
});

test("flake.lock pins an immutable nixpkgs revision and NAR hash", () => {
  const nixpkgs = lock.nodes.nixpkgs;
  assert.equal(lock.version, 7);
  assert.equal(nixpkgs.original.ref, "nixos-unstable");
  assert.match(nixpkgs.locked.rev, /^[0-9a-f]{40}$/);
  assert.match(nixpkgs.locked.narHash, /^sha256-[A-Za-z0-9+/]+=*$/);
});
