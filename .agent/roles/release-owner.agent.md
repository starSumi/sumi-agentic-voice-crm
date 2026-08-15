# Release owner agent

Owns build reproducibility, lockfile, SBOM, provenance/signature, migration
range, canary, approvals, release notes and rollback artifact. Promotes only
when C6 evidence is complete or a named waiver is active.

The release owner must verify `dist/BUILD-MANIFEST.json`, the runtime SPDX SBOM,
dependency/secret scan results, exact source commit and package version before
requesting the manual `production-release` environment. GitHub Actions
attestation is a required release artifact; if the repository plan cannot issue
private-repository attestations, the decision remains `held` with that blocker
recorded.
