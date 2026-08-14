---
title: Agent development partner guide
description: Connect Sumi Docs MCP, discover the project, answer evidence-backed questions, and make changes within the CRM safety boundary.
docId: crm.agent-guide
locale: en
audience: agent
contentVersion: 0.1.0
---

This corpus is designed for an AI development partner that starts without repository history. Use the MCP tools for product and architecture context, then use the checked-out source and tests as implementation evidence.

## Connect locally

Build and serve the documentation projection:

```powershell
npm run docs:build
npm run docs:preview -- --host 127.0.0.1 --port 4321
```

Start Sumi Docs MCP with the machine projection as its corpus and the human site as its URL base:

```powershell
node E:\Zero_Base\playground\.sumi\Sumi-Docs-MCP\dist\index.js serve `
  http://127.0.0.1:4321/_mcp/ `
  --base-url http://127.0.0.1:4321/
```

Loopback HTTP is for development only. A deployed corpus must use HTTPS.

## Discovery sequence

1. Call `list_docs` to learn the corpus and obtain human-readable page URLs.
2. Call `search_docs` with a specific domain term such as `idempotency`, `low confidence`, `tenant`, `outbox`, or `ASR timeout`.
3. Call `fetch_doc` for the strongest match. Read its frontmatter: `docId`, `locale`, `audience`, and `contentVersion` identify the document contract.
4. Call `get_openapi_spec` before changing request or response behavior.
5. Confirm mutable implementation facts in `src/`, `contracts/`, migrations, and tests before editing.

When a checkout is available, also run `npm run agent:health` and `npm run agent:resume`, then read `.agent/.agent.cursor.json` and the active checkpoint card. The cursor is a reviewed handoff, so verify its commit and CI facts before relying on them. Search for `continuity-supervisor` or fetch `maintenance.md` for the full current/next-session procedure.

## Evidence rules

- `contracts/openapi.yaml` and `contracts/events.yaml` are normative for their protocols.
- `docs/RELEASE-READINESS.md` is authoritative for what has and has not passed.
- `docs/SOURCE-EVIDENCE.md` separates source-confirmed, runtime-observed, inferred, and unknown claims.
- `.agent/` routes lifecycle and ownership; it does not replace source or runtime evidence.
- A generated Web page, `_mcp` copy, build report, or old chat is derivative evidence. Trace it back to `docs/`, contracts, source, and current commands.

## Safety boundary for changes

Never let natural-language output mutate CRM state directly. A mutation requires authorized tenant and actor identity, strict input and command schema, risk and confirmation policy, idempotency, a transaction, audit, and an outbox event. Low confidence produces a review task, not a guessed write.

## Acceptance scenarios

An effective project MCP should let a new agent answer these without broad repository scraping:

- Which code path owns a low-confidence request, and may it mutate CRM state?
- Which headers are required for `/v1/ask`, and what does idempotency conflict mean?
- What remains unverified for production?
- How should an operator respond to `ASR_TIMEOUT` without duplicating a command?
- Where is the difference between current mock behavior and target provider configuration documented?
- Which role owns the next-session handoff, where is live session state stored, and may CI approve a release?

The repository script `npm run verify:mcp` turns these expectations into a real stdio protocol check rather than a documentation claim.
