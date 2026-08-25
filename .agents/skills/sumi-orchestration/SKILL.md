---
name: sumi-orchestration
description: Compile Sumi repository changes into bounded dependency-aware task packets, verify generated Codex role projections, and inspect runnable non-conflicting tasks. Use for multi-agent implementation, independent review, or exact-candidate release evidence in this repository.
---

# Sumi Orchestration

Run `pnpm run orchestration:check` before scheduling work.

Use `orchestration/orchestration.yaml` as the desired-state source. Generated
Codex TOML and skill metadata are adapters; do not edit them directly.

Store live plans and task runtime state under the external roots declared by the
spec. Never write runtime state, agent transcripts, credentials, or approval
decisions into this repository.

Compile each mutation into a task packet with literal bounded write roots,
dependency edges, stable idempotency, acceptance commands, and completion
evidence. Schedule with:

```sh
node orchestration/cli.ts next --plan <plan.json> --state <runtime-state.json>
```

Only the supervisor mutates plan state. Read-only work may fan out. Writers with
overlapping path roots must serialize. Agent verification never replaces human
acceptance or release promotion.
