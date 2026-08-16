---
title: Maintainer and session continuity
description: Ownership, reviewed handoff state, external runtime state, CI operations, and recovery procedures for continued project maintenance.
docId: crm.maintenance
locale: en
audience: both
contentVersion: 0.1.0
---

This project separates durable project truth from transient agent runtime state. The boundary keeps handoffs reviewable without committing session transcripts, locks, retries, credentials, or machine-specific paths.

## State ownership

| State | Location | Lifecycle |
| --- | --- | --- |
| Roles, phase/checkpoint policy, maintainers, reviewed handoff cursor | `.agent/` | Versioned, reviewed, and changed with the project contract. |
| Current session identity, agent edges, retries, locks, and temporary evidence | `CODEX_HOME`, then `XDG_STATE_HOME`, then the platform local application-data directory | Machine-local and ignored. `pnpm run agent:resume` prints the selected path; use `.agent-runtime/` only as an explicit fallback. |
| CI observation snapshot | `agent-operations-<run-id>` Actions artifact | Generated per run and retained for 30 days. |
| CI degradation requiring attention | One GitHub Issue titled `[CI Operations] main requires attention` | Opened or updated on failure and closed after a successful main observation. |

`.agent/.agent.cursor.json` is a reviewed handoff checkpoint, not a live session database. It may contain a commit, phase, checkpoint, open work, external blockers, and the next safe action. Do not put prompts, chat logs, access tokens, process IDs, or transient `running`/`waiting` states in it.

## Maintainers

`.agent/.agent.maintainers.json` owns the documentation, continuity, and CI operations surfaces. `CODEOWNERS` routes review to the same repository owner. The registry records review intervals and the last reviewed source commit; `pnpm run agent:health` rejects stale or inconsistent control-plane state.

The three operational roles are deliberately separate:

- `docs-maintainer` keeps human Web pages and the `_mcp` projection synchronized.
- `continuity-supervisor` captures a reviewed cursor and restores only stable agent relationships.
- `ci-operations-agent` observes CI and reconciles the operations Issue. It cannot edit source, approve a checkpoint, publish, tag, or deploy.

## Current session

At the start of a repository session:

```powershell
git status --short --branch
pnpm run agent:health
pnpm run agent:resume
```

Read `AGENTS.md`, `.agent/.agent.manifest.json`, `.agent/.agent.state.json`, `.agent/.agent.cursor.json`, and the active checkpoint card. Re-probe Git and CI before treating cursor facts as current. Runtime agent edges use only `open` or `closed`: a stopped process is not automatically a closed delegation.

At handoff, update the versioned cursor only when its durable facts changed, then write the local session snapshot atomically:

```powershell
pnpm run agent:resume -- --agent "/root=open" --agent "/root/reviewer=closed"
```

The command prints the runtime file location. That file remains outside Git by default.

## CI operations

The `operations-agent` workflow observes completed `ci` runs on `main`, runs a weekly drift check, and supports manual inspection. Its observation job has read-only repository permission. A separate reconciliation job has only `issues: write`; it does not check out the repository or execute project scripts.

The workflow records the upstream conclusion, current commit, control-plane health, verification outcomes, and release hold in a JSON artifact and the Actions summary. Failure creates or updates one deterministic Issue. Recovery closes the same Issue. The automation never treats its own report as release evidence and never changes the release hold.

## Recovery and rollback

If a local runtime snapshot is missing or corrupt, remove only that thread's external operations directory and run `pnpm run agent:resume` again. The versioned cursor remains the recovery source. If a governance change is wrong, revert its bounded commit; do not rewrite runtime history into `.agent/`.

This private repository currently cannot enforce the intended branch protection rules under the available GitHub plan. Keep the repository private, preserve the human acceptance gate, and treat CI success as evidence rather than approval.
