---
title: Contributing
description: Issue, branch, commit, pull request, review, validation, and documentation requirements for the CRM reference platform.
docId: crm.contributing
locale: en
audience: both
contentVersion: 0.1.0
---

Start with the root `AGENTS.md`, the relevant architecture decision, and the checkpoint that owns the change. The root `CONTRIBUTING.md` is the concise repository contract; this page explains the working flow.

## Before implementation

- Search existing issues and pull requests before opening a duplicate.
- State current behavior, desired behavior, evidence, risk, and rollback.
- Use an ADR for a new provider class, public schema break, lifecycle change, trust-boundary change, or new agent capability.
- Do not copy upstream source, prompts, fixtures, customer material, or credentials.
- Use the structured issue forms. Security vulnerabilities belong in a private GitHub security advisory, not a public issue.

## Pull request shape

Keep a pull request cohesive. Include the problem and user impact, contract or architecture effect, test evidence, security and data impact, documentation updates, and rollback. Draft pull requests are appropriate for early design review; passing CI is not a substitute for required owner review.

The repository pull request template captures these fields and the required Web/MCP validation. CODEOWNERS review is required for contracts, database, agent governance, security, and release policy.

## Commit quality

Use an imperative, scoped subject such as `docs: add MCP partner guide` or `fix(api): preserve idempotency conflict`. Do not include agent names, tool signatures, generated approval claims, or fictional co-authors. The commit should describe the product change.

## Required validation

```powershell
pnpm run verify
pnpm run verify:mcp
```

If a gate cannot run, say exactly which one and why. Do not replace missing evidence with a status report or a confidence claim.

## Content changes

`docs/` is the single source for both the Web site and MCP projection. Published files require validated frontmatter. Keep `docId` stable across translations, use a valid locale, update `contentVersion` only with the project version, and preserve factual differences between the reference runtime and production targets.
