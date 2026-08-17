## Problem and user impact

<!-- What changed, why it matters, and what remains out of scope. -->

## Contract and architecture

<!-- API, event, data, lifecycle, provider, Web, MCP, or ADR impact. -->

## Verification

<!-- Commands, exit codes, test names, and relevant runtime evidence. -->

- [ ] `pnpm run verify`
- [ ] Contract consumers use only the generated API client; `pnpm run contract:consumer-check` is clean
- [ ] Contract changes regenerated the SDK and passed `pnpm run protocol:check` plus `pnpm run protocol:typecheck`
- [ ] Authorization changes passed `pnpm run authorization:check` and retain application plus transaction enforcement
- [ ] `pnpm run verify:mcp` when docs, API, routing, or agent onboarding changed
- [ ] `pnpm run sbom` and `pnpm run audit:deps` when dependencies or release inputs changed
- [ ] `dist/BUILD-MANIFEST.json` verifies after any build-chain change
- [ ] New or changed behavior has regression coverage

## Security and data

<!-- Tenant, authorization, idempotency, privacy, secrets, media, and migration impact. -->

## Documentation and localization

- [ ] Human and agent documentation matches the implementation
- [ ] English and Chinese core variants remain paired when applicable
- [ ] Local control-plane state was not added to the product diff; release evidence is attached through CI and GitHub review

## Rollback

<!-- Exact reversible action and any state that must not be deleted or rolled back. -->

## Release acceptance

<!-- Name the candidate commit/version, CI evidence, SBOM/provenance status,
approvers, and explicit approved/held/rejected decision. Ordinary PR approval
is not release approval. -->
