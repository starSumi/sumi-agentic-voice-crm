import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONTEXT_PREFIX = "SBOM-GENERATION-CONTEXT ";
const CHECKSUM_LENGTHS = new Map([
  ["SHA1", 40],
  ["SHA256", 64],
  ["SHA384", 96],
  ["SHA512", 128],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`SPDX verification failed: ${message}`);
}

function parseGenerationContext(comment) {
  invariant(
    typeof comment === "string" && comment.startsWith(CONTEXT_PREFIX),
    "generation context is missing",
  );
  try {
    return JSON.parse(comment.slice(CONTEXT_PREFIX.length));
  } catch (error) {
    throw new Error(
      "SPDX verification failed: generation context is not valid JSON",
      { cause: error },
    );
  }
}

export function verifySbomDocument(sbom, buildManifest) {
  invariant(sbom?.spdxVersion === "SPDX-2.3", "SPDX 2.3 is required");
  invariant(
    sbom.dataLicense === "CC0-1.0",
    "SPDX data license must be CC0-1.0",
  );
  invariant(
    Array.isArray(sbom.packages) && sbom.packages.length > 1,
    "runtime packages are missing",
  );
  invariant(
    Array.isArray(sbom.relationships) && sbom.relationships.length > 0,
    "dependency relationships are missing",
  );
  invariant(
    Array.isArray(sbom.documentDescribes) &&
      sbom.documentDescribes.length === 1,
    "one root package is required",
  );
  invariant(
    !Number.isNaN(Date.parse(sbom.creationInfo?.created)),
    "creation timestamp is invalid",
  );

  const creators = sbom.creationInfo?.creators ?? [];
  invariant(
    creators.includes("Organization: starSumi"),
    "SBOM author is missing",
  );
  invariant(
    creators.some((entry) => entry.startsWith("Tool: pnpm-")),
    "pnpm tool name is missing",
  );
  invariant(
    creators.some((entry) => entry.startsWith("Tool: cargo ")),
    "Cargo tool name is missing",
  );
  invariant(
    creators.includes("Tool: scripts/generate-sbom.mjs"),
    "generator tool name is missing",
  );

  const context = parseGenerationContext(sbom.creationInfo?.comment);
  invariant(
    context.lifecycle_phase === "after-build",
    "generation context must be after-build",
  );
  invariant(
    context.artifact_scope === "runtime" && context.subject === "dist",
    "runtime build subject is not bound",
  );
  invariant(
    /^[a-f0-9]{40}$/.test(context.source_commit),
    "source commit is not immutable",
  );
  invariant(context.source_tree_state === "clean", "source tree is not clean");
  invariant(
    context.build_manifest === "dist/BUILD-MANIFEST.json",
    "build manifest path drifted",
  );
  invariant(
    /^[a-f0-9]{64}$/.test(context.dependency_lock_sha256),
    "dependency lock digest is invalid",
  );
  invariant(
    context.subject_sha256 === buildManifest?.content_set_sha256,
    "generation context does not match the runtime manifest",
  );
  invariant(
    sbom.documentNamespace.includes(context.source_commit),
    "document namespace does not bind the commit",
  );
  invariant(
    sbom.documentNamespace.includes(context.subject_sha256),
    "document namespace does not bind the subject",
  );

  const root = sbom.packages.find(
    (entry) => entry.SPDXID === sbom.documentDescribes[0],
  );
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
    root.externalRefs?.some(
      (entry) =>
        entry.referenceType === "purl" &&
        entry.referenceLocator ===
          `pkg:github/starSumi/sumi-agentic-voice-crm@${context.source_commit}`,
    ),
    "root purl does not bind the source commit",
  );

  const purls = [];
  for (const component of sbom.packages) {
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
    for (const checksum of component.checksums) {
      const length = CHECKSUM_LENGTHS.get(checksum.algorithm);
      invariant(length, `${component.name} checksum algorithm is unsupported`);
      invariant(
        new RegExp(`^[a-f0-9]{${length}}$`).test(checksum.checksumValue),
        `${component.name} checksum is malformed`,
      );
    }
    for (const reference of component.externalRefs ?? []) {
      if (reference.referenceType === "purl")
        purls.push(reference.referenceLocator);
    }
  }

  invariant(
    root.checksums.some(
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

  const supervisor = sbom.packages.find(
    (entry) => entry.name === "sumi-runtime-supervisor",
  );
  const supervisorManifest = buildManifest.files?.find(
    (entry) => entry.path === "bin/sumi-runtime-supervisor",
  );
  invariant(
    supervisor && supervisorManifest,
    "runtime supervisor evidence is missing",
  );
  invariant(
    supervisor.checksums.some(
      (entry) =>
        entry.algorithm === "SHA256" &&
        entry.checksumValue === supervisorManifest.sha256,
    ),
    "runtime supervisor checksum does not match the build manifest",
  );

  return {
    context,
    component_count: sbom.packages.length,
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
