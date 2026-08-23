import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONTEXT_PREFIX = "SBOM-GENERATION-CONTEXT ";
const CHECKSUM_LENGTHS = new Map([
  ["SHA1", 40],
  ["SHA256", 64],
  ["SHA384", 96],
  ["SHA512", 128],
]);
type JsonObject = Record<string, unknown>;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SPDX verification failed: ${message}`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown, message: string): JsonObject {
  invariant(isJsonObject(value), message);
  return value;
}

function objectArray(value: unknown, message: string): JsonObject[] {
  invariant(Array.isArray(value), message);
  return value.map((entry) => jsonObject(entry, message));
}

function stringArray(value: unknown, message: string): string[] {
  invariant(
    Array.isArray(value) && value.every((entry) => typeof entry === "string"),
    message,
  );
  return value;
}

function parseGenerationContext(comment: unknown): JsonObject {
  invariant(
    typeof comment === "string" && comment.startsWith(CONTEXT_PREFIX),
    "generation context is missing",
  );
  try {
    return jsonObject(
      JSON.parse(comment.slice(CONTEXT_PREFIX.length)),
      "generation context is not a JSON object",
    );
  } catch (error) {
    throw new Error(
      "SPDX verification failed: generation context is not valid JSON",
      { cause: error },
    );
  }
}

export function verifySbomDocument(sbom: unknown, buildManifest: unknown) {
  const document = jsonObject(sbom, "document must be a JSON object");
  const manifest = jsonObject(
    buildManifest,
    "build manifest must be a JSON object",
  );
  invariant(document.spdxVersion === "SPDX-2.3", "SPDX 2.3 is required");
  invariant(
    document.dataLicense === "CC0-1.0",
    "SPDX data license must be CC0-1.0",
  );
  invariant(
    Array.isArray(document.packages) && document.packages.length > 1,
    "runtime packages are missing",
  );
  invariant(
    Array.isArray(document.relationships) && document.relationships.length > 0,
    "dependency relationships are missing",
  );
  invariant(
    Array.isArray(document.documentDescribes) &&
      document.documentDescribes.length === 1 &&
      typeof document.documentDescribes[0] === "string",
    "one root package is required",
  );
  invariant(
    isJsonObject(document.creationInfo) &&
      typeof document.creationInfo.created === "string" &&
      !Number.isNaN(Date.parse(document.creationInfo.created)),
    "creation timestamp is invalid",
  );

  const creationInfo = jsonObject(
    document.creationInfo,
    "creation information is missing",
  );
  const creators = stringArray(
    creationInfo.creators,
    "creator list is invalid",
  );
  invariant(
    creators.includes("Organization: starSumi"),
    "SBOM author is missing",
  );
  invariant(
    creators.some((entry: string) => entry.startsWith("Tool: pnpm-")),
    "pnpm tool name is missing",
  );
  invariant(
    creators.some((entry: string) => entry.startsWith("Tool: cargo ")),
    "Cargo tool name is missing",
  );
  invariant(
    creators.includes("Tool: scripts/generate-sbom.ts"),
    "generator tool name is missing",
  );

  const context = parseGenerationContext(creationInfo.comment);
  invariant(
    context.lifecycle_phase === "after-build",
    "generation context must be after-build",
  );
  invariant(
    context.artifact_scope === "runtime" && context.subject === "dist",
    "runtime build subject is not bound",
  );
  invariant(
    typeof context.source_commit === "string" &&
      /^[a-f0-9]{40}$/.test(context.source_commit),
    "source commit is not immutable",
  );
  invariant(context.source_tree_state === "clean", "source tree is not clean");
  invariant(
    context.build_manifest === "dist/BUILD-MANIFEST.json",
    "build manifest path drifted",
  );
  invariant(
    typeof context.dependency_lock_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(context.dependency_lock_sha256),
    "dependency lock digest is invalid",
  );
  invariant(
    context.subject_sha256 === manifest.content_set_sha256,
    "generation context does not match the runtime manifest",
  );
  invariant(
    typeof document.documentNamespace === "string" &&
      typeof context.source_commit === "string" &&
      document.documentNamespace.includes(context.source_commit),
    "document namespace does not bind the commit",
  );
  invariant(
    typeof document.documentNamespace === "string" &&
      typeof context.subject_sha256 === "string" &&
      document.documentNamespace.includes(context.subject_sha256),
    "document namespace does not bind the subject",
  );

  const packages = objectArray(
    document.packages,
    "runtime package entry is invalid",
  );
  const documentDescribes = stringArray(
    document.documentDescribes,
    "described package identifier is invalid",
  );
  const root = packages.find((entry) => entry.SPDXID === documentDescribes[0]);
  invariant(root, "described root package is missing");
  invariant(
    root.primaryPackagePurpose === "APPLICATION",
    "root purpose is not APPLICATION",
  );
  invariant(
    root.supplier === "Organization: starSumi",
    "software producer is missing",
  );
  invariant(
    objectArray(root.externalRefs, "root package references are invalid").some(
      (entry) =>
        entry.referenceType === "purl" &&
        entry.referenceLocator ===
          `pkg:github/starSumi/sumi-agentic-voice-crm@${context.source_commit}`,
    ),
    "root purl does not bind the source commit",
  );

  const purls: string[] = [];
  for (const component of packages) {
    invariant(
      typeof component.name === "string" && component.name.length > 0,
      "component name is missing",
    );
    invariant(
      typeof component.versionInfo === "string" &&
        component.versionInfo.length > 0,
      `${component.name} version is missing`,
    );
    invariant(
      Array.isArray(component.checksums) && component.checksums.length > 0,
      `${component.name} checksum is missing`,
    );
    for (const checksum of objectArray(
      component.checksums,
      `${component.name} checksum is malformed`,
    )) {
      invariant(
        typeof checksum.algorithm === "string",
        `${component.name} checksum algorithm is unsupported`,
      );
      const length = CHECKSUM_LENGTHS.get(checksum.algorithm);
      invariant(length, `${component.name} checksum algorithm is unsupported`);
      invariant(
        typeof checksum.checksumValue === "string" &&
          new RegExp(`^[a-f0-9]{${length}}$`).test(checksum.checksumValue),
        `${component.name} checksum is malformed`,
      );
    }
    for (const reference of objectArray(
      component.externalRefs ?? [],
      `${component.name} references are invalid`,
    )) {
      if (reference.referenceType === "purl") {
        invariant(
          typeof reference.referenceLocator === "string",
          `${component.name} purl is malformed`,
        );
        purls.push(reference.referenceLocator);
      }
    }
  }

  invariant(
    objectArray(root.checksums, "root checksum is malformed").some(
      (entry) =>
        entry.algorithm === "SHA256" &&
        entry.checksumValue === context.subject_sha256,
    ),
    "root checksum does not match the runtime manifest",
  );
  invariant(
    purls.some((entry) => entry.startsWith("pkg:npm/")),
    "npm purls are missing",
  );
  invariant(
    purls.some((entry) => entry.startsWith("pkg:cargo/")),
    "Cargo purls are missing",
  );
  invariant(
    new Set(purls).size === purls.length,
    "duplicate component purls are not allowed",
  );

  const supervisor = packages.find(
    (entry) => entry.name === "sumi-runtime-supervisor",
  );
  const supervisorManifest = objectArray(
    manifest.files,
    "build manifest files are invalid",
  ).find((entry) => entry.path === "bin/sumi-runtime-supervisor");
  invariant(
    supervisor && supervisorManifest,
    "runtime supervisor evidence is missing",
  );
  invariant(
    objectArray(
      supervisor.checksums,
      "runtime supervisor checksums are invalid",
    ).some(
      (entry) =>
        entry.algorithm === "SHA256" &&
        entry.checksumValue === supervisorManifest.sha256,
    ),
    "runtime supervisor checksum does not match the build manifest",
  );

  return {
    context,
    component_count: packages.length,
    purl_count: purls.length,
  };
}

export async function verifySbomFiles({
  sbomPath = "artifacts/release/sbom.spdx.json",
  manifestPath = "dist/BUILD-MANIFEST.json",
} = {}) {
  const [sbom, buildManifest] = await Promise.all([
    readFile(sbomPath, "utf8").then(JSON.parse),
    readFile(manifestPath, "utf8").then(JSON.parse),
  ]);
  return verifySbomDocument(sbom, buildManifest);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await verifySbomFiles();
  console.log(
    `SPDX verification passed: ${result.component_count} components, ${result.purl_count} purls, ${result.context.lifecycle_phase}`,
  );
}
