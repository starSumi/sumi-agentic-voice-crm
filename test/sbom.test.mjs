import assert from "node:assert/strict";
import test from "node:test";
import { verifySbomDocument } from "../scripts/verify-sbom.mjs";

const commit = "a".repeat(40);
const subjectDigest = "b".repeat(64);
const supervisorDigest = "c".repeat(64);
const lockDigest = "d".repeat(64);
const rootId = "SPDXRef-Package-root";

function fixture() {
  const context = {
    lifecycle_phase: "after-build",
    artifact_scope: "runtime",
    subject: "dist",
    source_commit: commit,
    source_tree_state: "clean",
    build_manifest: "dist/BUILD-MANIFEST.json",
    subject_sha256: subjectDigest,
    dependency_lock_sha256: lockDigest,
  };
  return {
    buildManifest: {
      content_set_sha256: subjectDigest,
      files: [
        { path: "bin/sumi-runtime-supervisor", sha256: supervisorDigest },
      ],
    },
    sbom: {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      documentNamespace: `https://github.com/starSumi/sumi-agentic-voice-crm/sbom/${commit}/${subjectDigest}`,
      creationInfo: {
        created: "2026-08-19T00:00:00.000Z",
        creators: [
          "Organization: starSumi",
          "Tool: pnpm-10.33.4",
          "Tool: cargo 1.96.0",
          "Tool: scripts/generate-sbom.mjs",
        ],
        comment: `SBOM-GENERATION-CONTEXT ${JSON.stringify(context)}`,
      },
      documentDescribes: [rootId],
      packages: [
        {
          SPDXID: rootId,
          name: "sumi-agentic-voice-crm",
          versionInfo: "0.1.0",
          supplier: "Organization: starSumi",
          primaryPackagePurpose: "APPLICATION",
          checksums: [{ algorithm: "SHA256", checksumValue: subjectDigest }],
          externalRefs: [
            {
              referenceType: "purl",
              referenceLocator: `pkg:github/starSumi/sumi-agentic-voice-crm@${commit}`,
            },
          ],
        },
        {
          SPDXID: "SPDXRef-Package-npm",
          name: "ajv",
          versionInfo: "8.20.0",
          checksums: [{ algorithm: "SHA512", checksumValue: "e".repeat(128) }],
          externalRefs: [
            { referenceType: "purl", referenceLocator: "pkg:npm/ajv@8.20.0" },
          ],
        },
        {
          SPDXID: "SPDXRef-Package-supervisor",
          name: "sumi-runtime-supervisor",
          versionInfo: "0.1.0",
          checksums: [{ algorithm: "SHA256", checksumValue: supervisorDigest }],
          externalRefs: [
            {
              referenceType: "purl",
              referenceLocator: "pkg:cargo/sumi-runtime-supervisor@0.1.0",
            },
          ],
        },
      ],
      relationships: [
        {
          spdxElementId: "SPDXRef-DOCUMENT",
          relationshipType: "DESCRIBES",
          relatedSpdxElement: rootId,
        },
      ],
    },
  };
}

test("SPDX verifier binds generation context, component hashes and immutable purls", () => {
  const { sbom, buildManifest } = fixture();
  assert.deepEqual(verifySbomDocument(sbom, buildManifest), {
    context: JSON.parse(
      sbom.creationInfo.comment.slice("SBOM-GENERATION-CONTEXT ".length),
    ),
    component_count: 3,
    purl_count: 3,
  });
});

test("SPDX verifier fails closed on a missing component hash", () => {
  const { sbom, buildManifest } = fixture();
  delete sbom.packages[1].checksums;
  assert.throws(
    () => verifySbomDocument(sbom, buildManifest),
    /ajv checksum is missing/,
  );
});

test("SPDX verifier rejects a dirty source-tree claim", () => {
  const { sbom, buildManifest } = fixture();
  const context = JSON.parse(
    sbom.creationInfo.comment.slice("SBOM-GENERATION-CONTEXT ".length),
  );
  context.source_tree_state = "dirty";
  sbom.creationInfo.comment = `SBOM-GENERATION-CONTEXT ${JSON.stringify(context)}`;
  assert.throws(
    () => verifySbomDocument(sbom, buildManifest),
    /source tree is not clean/,
  );
});

test("SPDX verifier rejects evidence that is not bound to the build", () => {
  const { sbom, buildManifest } = fixture();
  const mismatchedContext = structuredClone(sbom);
  const context = JSON.parse(
    mismatchedContext.creationInfo.comment.slice(
      "SBOM-GENERATION-CONTEXT ".length,
    ),
  );
  context.subject_sha256 = "f".repeat(64);
  mismatchedContext.creationInfo.comment = `SBOM-GENERATION-CONTEXT ${JSON.stringify(context)}`;
  assert.throws(
    () => verifySbomDocument(mismatchedContext, buildManifest),
    /generation context does not match the runtime manifest/,
  );

  const mismatchedSupervisor = structuredClone(sbom);
  mismatchedSupervisor.packages[2].checksums[0].checksumValue = "f".repeat(64);
  assert.throws(
    () => verifySbomDocument(mismatchedSupervisor, buildManifest),
    /runtime supervisor checksum does not match/,
  );
});
