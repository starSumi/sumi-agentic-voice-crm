import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { spawnCargoSync } from "./run-cargo.ts";

type JsonObject = Record<string, unknown>;
type BuildManifestFile = Readonly<{ path: string; sha256: string }>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function parseObject(source: string, label: string): JsonObject {
  return objectValue(JSON.parse(source), label);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalObject(value: unknown, label: string): JsonObject | undefined {
  return value === undefined ? undefined : objectValue(value, label);
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => objectValue(entry, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => stringValue(entry, `${label}[${index}]`));
}

const packageJson = parseObject(
  await readFile("package.json", "utf8"),
  "package.json",
);
const packageName = stringValue(packageJson.name, "package.json name");
const packageVersion = stringValue(packageJson.version, "package.json version");
const packageManager = stringValue(
  packageJson.packageManager,
  "package.json packageManager",
);
const packageEngines = objectValue(packageJson.engines, "package.json engines");
const packageLicense =
  typeof packageJson.license === "string" ? packageJson.license : undefined;
const lockfile = await readFile("pnpm-lock.yaml");
const cargoLockfile = await readFile("Cargo.lock");
const buildManifest = parseObject(
  await readFile("dist/BUILD-MANIFEST.json", "utf8"),
  "dist/BUILD-MANIFEST.json",
);
const expectedPnpm = packageManager.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];

if (!expectedPnpm || packageEngines.pnpm !== expectedPnpm) {
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
  typeof buildManifest.content_set_sha256 !== "string" ||
  !/^[a-f0-9]{64}$/.test(buildManifest.content_set_sha256)
) {
  throw new Error(
    "dist/BUILD-MANIFEST.json is not a verified runtime manifest",
  );
}
const buildContentSetSha256 = buildManifest.content_set_sha256;
const buildManifestFiles: BuildManifestFile[] = objectArray(
  buildManifest.files,
  "build manifest files",
).map((entry, index) => ({
  path: stringValue(entry.path, `build manifest files[${index}].path`),
  sha256: stringValue(entry.sha256, `build manifest files[${index}].sha256`),
}));

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

const projectList: unknown = JSON.parse(
  runPnpm(["list", "--prod", "--json", "--depth", "Infinity"]),
);
if (!Array.isArray(projectList) || projectList.length !== 1) {
  throw new Error("pnpm list must return one project");
}
const project = objectValue(projectList[0], "pnpm project");
const parsedPnpmLock = objectValue(
  parseYaml(lockfile.toString("utf8")),
  "pnpm lockfile",
);
const npmIntegrityByKey = new Map<string, string>();
const lockPackages =
  optionalObject(parsedPnpmLock.packages, "pnpm lockfile packages") ?? {};
for (const [locator, rawEntry] of Object.entries(lockPackages)) {
  const entry = objectValue(rawEntry, `pnpm lockfile package ${locator}`);
  const resolution = optionalObject(
    entry.resolution,
    `pnpm lockfile package ${locator} resolution`,
  );
  const integrity =
    typeof resolution?.integrity === "string"
      ? resolution.integrity
      : undefined;
  if (!integrity) continue;
  const key = locator.replace(/\(.+$/, "");
  const previous = npmIntegrityByKey.get(key);
  if (previous && previous !== integrity) {
    throw new Error(`conflicting pnpm integrity values for ${key}`);
  }
  npmIntegrityByKey.set(key, integrity);
}
const licenses = parseObject(
  runPnpm(["licenses", "list", "--prod", "--json"]),
  "pnpm licenses",
);
const licenseByPackage = new Map<string, JsonObject>();
for (const [license, rawEntries] of Object.entries(licenses)) {
  const entries = objectArray(rawEntries, `pnpm license ${license}`);
  for (const [index, entry] of entries.entries()) {
    const name = stringValue(
      entry.name,
      `pnpm license ${license}[${index}].name`,
    );
    for (const version of stringArray(
      entry.versions,
      `pnpm license ${license}[${index}].versions`,
    )) {
      licenseByPackage.set(`${name}@${version}`, entry);
    }
  }
}

const packageByKey = new Map<string, JsonObject>();
const relationships = new Set<string>();
const rootKey = `${packageName}@${packageVersion}`;

function spdxId(key: string) {
  return `SPDXRef-Package-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

function purlName(name: string) {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const [scope, unscopedName] = name.split("/");
  return `${encodeURIComponent(scope)}/${encodeURIComponent(unscopedName)}`;
}

function visit(parentKey: string, dependencies: unknown): void {
  if (dependencies === undefined) return;
  const entries = objectValue(dependencies, `dependencies of ${parentKey}`);
  for (const [name, rawDependency] of Object.entries(entries)) {
    const dependency = objectValue(rawDependency, `dependency ${name}`);
    const version = stringValue(
      dependency.version,
      `dependency ${name} version`,
    );
    const key = `${name}@${version}`;
    packageByKey.set(key, { name, ...dependency });
    relationships.add(`${spdxId(parentKey)} DEPENDS_ON ${spdxId(key)}`);
    visit(key, dependency.dependencies);
    visit(key, dependency.optionalDependencies);
  }
}

visit(rootKey, project.dependencies);
visit(rootKey, project.optionalDependencies);

const cargoMetadata: unknown = JSON.parse(
  runCargo(["metadata", "--locked", "--format-version", "1"]),
);
const cargoMetadataObject = objectValue(cargoMetadata, "cargo metadata");
const cargoVersion = runCargo(["--version"]);
const cargoChecksums = readCargoChecksums(cargoLockfile.toString("utf8"));
const cargoPackageById = new Map<string, JsonObject>();
for (const [index, entry] of objectArray(
  cargoMetadataObject.packages,
  "cargo packages",
).entries()) {
  cargoPackageById.set(
    stringValue(entry.id, `cargo packages[${index}].id`),
    entry,
  );
}
const cargoResolve = objectValue(cargoMetadataObject.resolve, "cargo resolve");
const cargoNodeById = new Map<string, JsonObject>();
for (const [index, entry] of objectArray(
  cargoResolve.nodes,
  "cargo resolve nodes",
).entries()) {
  cargoNodeById.set(
    stringValue(entry.id, `cargo resolve nodes[${index}].id`),
    entry,
  );
}
const cargoReachable = new Set<string>();

function cargoKey(id: string) {
  return `cargo:${id}`;
}

function visitCargo(id: string): void {
  if (cargoReachable.has(id)) return;
  cargoReachable.add(id);
  const node = cargoNodeById.get(id);
  for (const dependencyId of stringArray(
    node?.dependencies ?? [],
    `cargo dependencies of ${id}`,
  )) {
    relationships.add(
      `${spdxId(cargoKey(id))} DEPENDS_ON ${spdxId(cargoKey(dependencyId))}`,
    );
    visitCargo(dependencyId);
  }
}

for (const memberId of stringArray(
  cargoMetadataObject.workspace_members,
  "cargo workspace members",
)) {
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
    const name = stringValue(dependency.name, `${key} name`);
    const version = stringValue(dependency.version, `${key} version`);
    const integrity = npmIntegrityByKey.get(key);
    if (!integrity)
      throw new Error(`pnpm lock omitted package integrity for ${key}`);
    return {
      SPDXID: spdxId(key),
      name,
      versionInfo: version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared:
        typeof metadata.license === "string" ? metadata.license : "NOASSERTION",
      copyrightText: "NOASSERTION",
      primaryPackagePurpose: "LIBRARY",
      checksums: [checksumFromIntegrity(integrity)],
      ...(typeof metadata.homepage === "string"
        ? { homepage: metadata.homepage }
        : {}),
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/${purlName(name)}@${encodeURIComponent(version)}`,
        },
      ],
    };
  });

const cargoPackages = [...cargoReachable].sort().map((id) => {
  const dependency = cargoPackageById.get(id);
  if (!dependency) throw new Error(`cargo metadata omitted package ${id}`);
  const name = stringValue(dependency.name, `cargo package ${id} name`);
  const version = stringValue(
    dependency.version,
    `cargo package ${id} version`,
  );
  const license =
    typeof dependency.license === "string" ? dependency.license : undefined;
  if (!license)
    throw new Error(
      `cargo package omitted license metadata: ${name}@${version}`,
    );
  const packageKey = `${name}@${version}`;
  const registryChecksum = cargoChecksums.get(packageKey);
  const runtimeBinary = buildManifestFiles.find(
    (entry) => entry.path === "bin/sumi-runtime-supervisor",
  );
  const checksum =
    registryChecksum ??
    (name === "sumi-runtime-supervisor" ? runtimeBinary?.sha256 : undefined);
  if (!checksum)
    throw new Error(
      `cargo lock/runtime manifest omitted component checksum for ${packageKey}`,
    );
  return {
    SPDXID: spdxId(cargoKey(id)),
    name,
    versionInfo: version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: license,
    copyrightText: "NOASSERTION",
    primaryPackagePurpose:
      name === "sumi-runtime-supervisor" ? "APPLICATION" : "LIBRARY",
    checksums: [{ algorithm: "SHA256", checksumValue: checksum }],
    ...(typeof dependency.homepage === "string"
      ? { homepage: dependency.homepage }
      : {}),
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
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
  subject_sha256: buildContentSetSha256,
  dependency_lock_sha256: lockDigest,
};
const rootId = spdxId(rootKey);
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageName}-${packageVersion}-runtime`,
  documentNamespace: `https://github.com/starSumi/sumi-agentic-voice-crm/sbom/${sourceCommit}/${buildContentSetSha256}`,
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
      name: packageName,
      versionInfo: packageVersion,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: packageLicense || "NOASSERTION",
      licenseDeclared: packageLicense || "NOASSERTION",
      copyrightText: "NOASSERTION",
      supplier: "Organization: starSumi",
      primaryPackagePurpose: "APPLICATION",
      checksums: [
        {
          algorithm: "SHA256",
          checksumValue: buildContentSetSha256,
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
