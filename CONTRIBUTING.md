# Contributing

1. Read `AGENTS.md`, the relevant ADR and checkpoint before changing a boundary.
2. Keep PRs small and cohesive; add/modify tests with code.
3. Contract, database, security and release changes require the CODEOWNERS review.
4. Run `npm run verify` locally. Run `npm run verify:mcp` when documentation, API, routing, or agent onboarding changes.
5. Never commit credentials, PII, raw customer audio, generated `dist/`, or copied upstream material.
6. Use an ADR for new providers, schema-breaking changes, lifecycle changes, or new agent capabilities.
7. Use the repository issue forms and pull request template; report vulnerabilities through a private security advisory, never a public issue.

The reference mock is intentionally deterministic. Real providers must implement the adapter contract and add quality,
timeout, fallback, privacy and cost evidence before being enabled in a release.

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for issue, commit, pull request, review, documentation, and rollback requirements.
