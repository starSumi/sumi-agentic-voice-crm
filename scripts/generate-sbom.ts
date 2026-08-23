import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { spawnCargoSync } from "./run-cargo.ts";

type Json = Record<string, any>;

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as Json;
const lockfile = await readFile("pnpm-lock.yaml");
const cargoLockfile = await readFile("Cargo.lock");
const buildManifest = JSON.parse(
  await readFile("dist/BUILD-MANIFEST.json", "utf8"),
) as Json;
const expectedPnpm = packageJson.packageManager?.match(
  /^pnpm@(\d+\.\d+\.\d+)$/,
)?.[1];

if (!expectedPnpm || packageJson.engines?.pnpm !== expectedPnpm) {
  throw new Error(
    "package.json must pin one exact pnpm version in packageManager and engines.pnpm",
  );
}

function runPnpm(args: string[]): string {
  const result = spawnSync("pnpm", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function runCargo(args: string[]): string {
  const result = spawnCargoSync(args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `cargo ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return String(result.stdout ?? "").trim();
}

function checksumFromIntegrity(integrity: string): {
  algorithm: string;
  checksumValue: string;
} {
  const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/]+={0,2})$/.exec(
    integrity ?? "",
  );
  if (!match) throw new Error(`unsupported package integrity: ${integrity}`);
  return {
    algorithm: match[1].toUpperCase(),
    checksumValue: Buffer.from(match[2], "base64").toString("hex"),
  };
}

function readCargoChecksums(source: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const block of source.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(block)?.[1];
    const version = /^version\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(block)?.[1];
    const checksum = /^checksum\s*=\s*"([a-f0-9]{64})"\s*$/m.exec(block)?.[1];
    if (name && version && checksum)
      checksums.set(`${JSON.parse(name)}@${JSON.parse(version)}`, checksum);
  }
  return checksums;
}

if (
  buildManifest.schema_version !== "sumi.runtime-build-manifest.v1" ||
  buildManifest.hash_algorithm !== "sha256" ||
  !/^[a-f0-9]{64}$/.test(buildManifest.content_set_sha256)
) {
  throw new Error(
    "dist/BUILD-MANIFEST.json is not a verified runtime manifest",
  );
}

const sourceCommit = runGit(["rev-parse", "HEAD"]);
const worktreeStatus = runGit([
  "status",
  "--porcelain=v1",
  "--untracked-files=normal",
]);
if (worktreeStatus) {
  throw new Error("refusing to generate attestable SBOM from a dirty worktree");
}
const sourceCommitDate = new Date(
  runGit(["show", "-s", "--format=%cI", "HEAD"]),
).toISOString();

const actualPnpm = runPnpm(["--version"]);
if (actualPnpm !== expectedPnpm) {
  throw new Error(
    `pnpm version mismatch: expected ${expectedPnpm}, received ${actualPnpm}`,
  );
}

const [project] = JSON.parse(
  runPnpm(["list", "--prod", "--json", "--depth", "Infinity"]),
) as [Json];
const parsedPnpmLock = parseYaml(lockfile.toString("utf8")) as Json;
const npmIntegrityByKey = new Map<string, string>();
for (const [locator, entry] of Object.entries(parsedPnpmLock.packages ?? {})) {
  const integrity = (entry as Json)?.resolution?.integrity as
    string | undefined;
  if (!integrity) continue;
  const key = locator.replace(/\(.+$/, "");
  const previous = npmIntegrityByKey.get(key);
  if (previous && previous !== integrity) {
    throw new Error(`conflicting pnpm integrity values for ${key}`);
  }
  npmIntegrityByKey.set(key, integrity);
}
const licenses = JSON.parse(
  runPnpm(["licenses", "list", "--prod", "--json"]),
) as Record<string, any>;
const licenseByPackage = new Map<string, Json>();
for (const entries of Object.values(licenses) as Json[][]) {
  for (const entry of entries as Json[]) {
    for (const version of entry.versions) {
      licenseByPackage.set(`${entry.name}@${version}`, entry);
    }
  }
}

const packageByKey = new Map<string, Json>();
const relationships = new Set<string>();
const rootKey = `${packageJson.name}@${packageJson.version}`;

function spdxId(key: string) {
  return `SPDXRef-Package-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

function purlName(name: string) {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const [scope, packageName] = name.split("/");
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`;
}

function visit(parentKey: string, dependencies: Json = {}) {
  for (const [name, dependency] of Object.entries(dependencies) as Array<
    [string, Json]
  >) {
    const key = `${name}@${dependency.version}`;
    packageByKey.set(key, { name, ...dependency });
    relationships.add(`${spdxId(parentKey)} DEPENDS_ON ${spdxId(key)}`);
    visit(key, dependency.dependencies);
    visit(key, dependency.optionalDependencies);
  }
}

visit(rootKey, project.dependencies);
visit(rootKey, project.optionalDependencies);

const cargoMetadata = JSON.parse(
  runCargo(["metadata", "--locked", "--format-version", "1"]),
) as Json;
const cargoVersion = runCargo(["--version"]);
const cargoChecksums = readCargoChecksums(cargoLockfile.toString("utf8"));
const cargoPackageById = new Map<string, Json>(
  (cargoMetadata.packages as Json[]).map((entry: Json) => [entry.id, entry]),
);
const cargoNodeById = new Map<string, Json>(
  ((cargoMetadata.resolve?.nodes ?? []) as Json[]).map((entry: Json) => [
    entry.id,
    entry,
  ]),
);
const cargoReachable = new Set();

function cargoKey(id: string) {
  return `cargo:${id}`;
}

function visitCargo(id: string): void {
  if (cargoReachable.has(id)) return;
  cargoReachable.add(id);
  const node = cargoNodeById.get(id);
  for (const dependencyId of node?.dependencies ?? []) {
    relationships.add(
      `${spdxId(cargoKey(id))} DEPENDS_ON ${spdxId(cargoKey(dependencyId))}`,
    );
    visitCargo(dependencyId);
  }
}

for (const memberId of cargoMetadata.workspace_members) {
  relationships.add(
    `${spdxId(rootKey)} DEPENDS_ON ${spdxId(cargoKey(memberId))}`,
  );
  visitCargo(memberId);
}

const missingLicenseMetadata = [...packageByKey.keys()].filter(
  (key) => !licenseByPackage.has(key),
);
if (missingLicenseMetadata.length) {
  throw new Error(
    `pnpm omitted production license metadata for: ${missingLicenseMetadata.join(", ")}`,
  );
}

const dependencyPackages = [...packageByKey.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, dependency]) => {
    const metadata = licenseByPackage.get(key) ?? {};
    const integrity = npmIntegrityByKey.get(key);
    if (!integrity)
      throw new Error(`pnpm lock omitted package integrity for ${key}`);
    return {
      SPDXID: spdxId(key),
      name: dependency.name,
      versionInfo: dependency.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: metadata.license || "NOASSERTION",
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: "LIBRARY",
      checksums: [checksumFromIntegrity(integrity)],
      ...(metadata.homepage ? { homepage: metadata.homepage } : {}),
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/${purlName(dependency.name)}@${encodeURIComponent(dependency.version)}`,
        },
      ],
    };
  });

const cargoPackages = [...cargoReachable].sort().map((id) => {
  const dependency = cargoPackageById.get(String(id));
  if (!dependency) throw new Error(`cargo metadata omitted package ${id}`);
  if (!dependency.license)
    throw new Error(
      `cargo package omitted license metadata: ${dependency.name}@${dependency.version}`,
    );
  const packageKey = `${dependency.name}@${dependency.version}`;
  const registryChecksum = cargoChecksums.get(packageKey);
  const runtimeBinary = (buildManifest.files as Json[]).find(
    (entry: Json) => entry.path === "bin/sumi-runtime-supervisor",
  );
  const checksum =
    registryChecksum ??
    (dependency.name === "sumi-runtime-supervisor"
      ? runtimeBinary?.sha256
      : undefined);
  if (!checksum)
    throw new Error(
      `cargo lock/runtime manifest omitted component checksum for ${packageKey}`,
    );
  return {
    SPDXID: spdxId(cargoKey(String(id))),
    name: dependency.name,
    versionInfo: dependency.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: dependency.license,
    copyrightText: "NOASSERTION",
    primaryPackagePurpose:
      dependency.name === "sumi-runtime-supervisor" ? "APPLICATION" : "LIBRARY",
    checksums: [{ algorithm: "SHA256", checksumValue: checksum }],
    ...(dependency.homepage ? { homepage: dependency.homepage } : {}),
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:cargo/${encodeURIComponent(dependency.name)}@${encodeURIComponent(dependency.version)}`,
      },
    ],
  };
});

const lockDigest = createHash("sha256")
  .update(lockfile)
  .update("\0")
  .update(cargoLockfile)
  .digest("hex");
const generationContext = {
  lifecycle_phase: "after-build",
  artifact_scope: "runtime",
  subject: "dist",
  source_commit: sourceCommit,
  source_tree_state: "clean",
  build_manifest: "dist/BUILD-MANIFEST.json",
  subject_sha256: buildManifest.content_set_sha256,
  dependency_lock_sha256: lockDigest,
};
const rootId = spdxId(rootKey);
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageJson.name}-${packageJson.version}-runtime`,
  documentNamespace: `https://github.com/starSumi/sumi-agentic-voice-crm/sbom/${sourceCommit}/${buildManifest.content_set_sha256}`,
  creationInfo: {
    created: sourceCommitDate,
    creators: [
      "Organization: starSumi",
      `Tool: pnpm-${actualPnpm}`,
      `Tool: ${cargoVersion}`,
      "Tool: scripts/generate-sbom.ts",
    ],
    comment: `SBOM-GENERATION-CONTEXT ${JSON.stringify(generationContext)}`,
  },
  documentDescribes: [rootId],
  packages: [
    {
      SPDXID: rootId,
      name: packageJson.name,
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: packageJson.license || "NOASSERTION",
      licenseDeclared: packageJson.license || "NOASSERTION",
      copyrightText: "NOASSERTION",
      supplier: "Organization: starSumi",
      primaryPackagePurpose: "APPLICATION",
      checksums: [
        {
          algorithm: "SHA256",
          checksumValue: buildManifest.content_set_sha256,
        },
      ],
      comment:
        "The SHA256 checksum is the canonical content-set digest defined by dist/BUILD-MANIFEST.json.",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:github/starSumi/sumi-agentic-voice-crm@${sourceCommit}`,
        },
      ],
    },
    ...dependencyPackages,
    ...cargoPackages,
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootId,
    },
    ...[...relationships].sort().map((relationship: string) => {
      const [spdxElementId, relationshipType, relatedSpdxElement] =
        relationship.split(" ");
      return { spdxElementId, relationshipType, relatedSpdxElement };
    }),
  ],
};

await mkdir("artifacts/release", { recursive: true });
await writeFile(
  "artifacts/release/sbom.spdx.json",
  `${JSON.stringify(sbom, null, 2)}\n`,
);
console.log(`SPDX SBOM written with ${sbom.packages.length} runtime packages`);
