import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const lockfile = await readFile("pnpm-lock.yaml");
const expectedPnpm = packageJson.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];

if (!expectedPnpm || packageJson.engines?.pnpm !== expectedPnpm) {
  throw new Error("package.json must pin one exact pnpm version in packageManager and engines.pnpm");
}

function runPnpm(args) {
  const result = spawnSync("pnpm", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const actualPnpm = runPnpm(["--version"]);
if (actualPnpm !== expectedPnpm) {
  throw new Error(`pnpm version mismatch: expected ${expectedPnpm}, received ${actualPnpm}`);
}

const [project] = JSON.parse(runPnpm(["list", "--prod", "--json", "--depth", "Infinity"]));
const licenses = JSON.parse(runPnpm(["licenses", "list", "--prod", "--json"]));
const licenseByPackage = new Map();
for (const entries of Object.values(licenses)) {
  for (const entry of entries) {
    for (const version of entry.versions) {
      licenseByPackage.set(`${entry.name}@${version}`, entry);
    }
  }
}

const packageByKey = new Map();
const relationships = new Set();
const rootKey = `${packageJson.name}@${packageJson.version}`;

function spdxId(key) {
  return `SPDXRef-Package-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

function purlName(name) {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const [scope, packageName] = name.split("/");
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`;
}

function visit(parentKey, dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    const key = `${name}@${dependency.version}`;
    packageByKey.set(key, { name, ...dependency });
    relationships.add(`${spdxId(parentKey)} DEPENDS_ON ${spdxId(key)}`);
    visit(key, dependency.dependencies);
    visit(key, dependency.optionalDependencies);
  }
}

visit(rootKey, project.dependencies);
visit(rootKey, project.optionalDependencies);

const missingLicenseMetadata = [...packageByKey.keys()].filter(
  (key) => !licenseByPackage.has(key),
);
if (missingLicenseMetadata.length) {
  throw new Error(`pnpm omitted production license metadata for: ${missingLicenseMetadata.join(", ")}`);
}

const dependencyPackages = [...packageByKey.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, dependency]) => {
    const metadata = licenseByPackage.get(key);
    return {
      SPDXID: spdxId(key),
      name: dependency.name,
      versionInfo: dependency.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: metadata.license || "NOASSERTION",
      copyrightText: "NOASSERTION",
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

const lockDigest = createHash("sha256").update(lockfile).digest("hex");
const rootId = spdxId(rootKey);
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageJson.name}-${packageJson.version}-runtime`,
  documentNamespace: `https://github.com/starSumi/sumi-agentic-voice-crm/sbom/${packageJson.version}/${lockDigest}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: [`Tool: pnpm-${actualPnpm}`, "Tool: scripts/generate-sbom.mjs"],
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
    },
    ...dependencyPackages,
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootId,
    },
    ...[...relationships].sort().map((relationship) => {
      const [spdxElementId, relationshipType, relatedSpdxElement] = relationship.split(" ");
      return { spdxElementId, relationshipType, relatedSpdxElement };
    }),
  ],
};

await mkdir("artifacts/release", { recursive: true });
await writeFile("artifacts/release/sbom.spdx.json", `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`SPDX SBOM written with ${sbom.packages.length} runtime packages`);
