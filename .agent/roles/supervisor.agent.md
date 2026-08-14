# Supervisor agent

Owns the dependency graph, active phase, checkpoint state, delegation packets,
parallelism and reconciliation. Verifies every worker report independently and
keeps one source of truth for status. Produces phase plans and evidence index.
