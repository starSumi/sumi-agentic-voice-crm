# Sumi agent engineering control plane

`.agent/` is the versioned coordination surface for the Sumi Agentic Voice
CRM. It records who owns each stage, what evidence is required, how work is
delegated, and which checkpoint permits the next irreversible action. The
control plane is explicit: every phase, gate, and role has a machine-readable
identity plus a reviewable `.agent.md` card.

This is governance source, not application runtime code. It is intentionally
kept in Git for review and audit. Machine-local or generated material belongs
under `.agent.local/`, `.agent-runtime/`, `.agent-cache/`, `.agent-artifacts/`
or `.agent-work/`; those paths are excluded from Git, Docker, npm packages,
Vercel and Google Cloud build contexts.

## Reading route

1. Read [`.agent.manifest.json`](.agent.manifest.json) for lifecycle state,
   ownership and phase/checkpoint order.
2. Read [`.agent.workflow.md`](.agent.workflow.md) for the supervisor loop,
   delegation packet and evidence protocol.
3. Read [`.agent.phase-role-matrix.json`](.agent.phase-role-matrix.json) to
   resolve accountable role, contributors, approvers and parallelism.
4. Read the phase card under `phases/` before changing a boundary.
5. Read the relevant checkpoint card under `checkpoints/` before claiming a
   stage complete.
6. Read the role card under `roles/` before accepting or delegating work.
7. Record outputs in `.agent-artifacts/` locally and promote only reviewed,
   redacted evidence into `docs/`.

## State vocabulary

- `planned`: defined but no accepted evidence.
- `in_progress`: work is active and has an owner.
- `blocked`: a named external dependency or decision prevents progress.
- `completed`: exit criteria and evidence are recorded.
- `waived`: an explicitly approved exception with expiry and rollback.

No agent may mark a checkpoint `completed` from code inspection alone when its
card requires runtime, security, database, or release evidence.

## Non-negotiable handoff

Every task has one accountable owner, one bounded output path, one acceptance
test, one evidence reference, and one rollback/expiry rule. The Commander may
reassign work, but may not erase evidence or silently downgrade a gate.

## Role and authority rules

`roles/*.agent.md` is the role registry. `commander`, `supervisor`, `delegate`,
and `reviewer` are control-plane roles; specialist owners are accountable for
their bounded product surface; `worker` is an execution role with no approval
authority. Product, platform and operations owners are explicit approvers for
the final release even when implementation work is delegated to a specialist.
The matrix is authoritative for phase assignment; a role card is authoritative
for that role's write and approval boundary.

Parallel work is permitted only for lanes with disjoint `write_paths` in the
task packet. Boundary-crossing contract, database and runtime changes are
serialized by the Supervisor and independently re-run by the Reviewer.
