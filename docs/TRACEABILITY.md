---
title: Requirement traceability
description: Mapping from product requirements to owned contracts, implementation artifacts, and executable verification.
docId: crm.traceability
locale: en
audience: both
contentVersion: 0.1.0
---

| Requirement                        | Sumi artifact                                                                                                                         | Verification / gate                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Text and voice question answering  | `contracts/openapi.yaml` `/v1/ask`; `src/application/`; `src/server.mjs`                                                              | contract, application-service and media-boundary tests                                 |
| ASR, intent and key information    | `src/providers.mjs` adapters; generated `Understanding` schema                                                                        | provider capability, audio and review-policy tests                                     |
| TTS text/audio output              | `/v1/tts/synthesize`, `TtsAsset`, private-asset policy                                                                                | authentication, idempotency, asset-content and replay tests                            |
| CRM mutation safety                | mutation policy; RBAC+ABAC authorization contract; application and transaction PEPs; `crm_commands`, `audit_records`, `outbox_events` | fail-closed policy matrix, review, transaction, idempotency and event-envelope tests   |
| Low-confidence human review        | `review_tasks`; `docs/LIFECYCLE.md`                                                                                                   | 202 response with no CRM commit and durable decision tests                             |
| Tenant isolation and audit         | OIDC/JWKS verifier, active actor facts, RBAC+ABAC PDP, forced RLS policies, scoped event access                                       | signed-token and authorization tests plus disposable two-tenant PostgreSQL integration |
| Database and field contract        | ordered migrations, SQL fixtures, `docs/DATA-MODEL.md`                                                                                | repeatable migration, RLS, atomic commit/rollback, WAL and CAS tests                   |
| API documentation and Postman      | OpenAPI source, generated client, Postman collection                                                                                  | protocol drift, typecheck, consumer-boundary and repository checks                     |
| Lifecycle, recovery and operations | lifecycle, events/audit and operations contracts                                                                                      | cancellation, teardown, recovery, relay and fault-drill tests                          |
| Reproducible build and release     | CI workflow, build manifest, Dockerfile, release workflow                                                                             | clean-runner verify, PostgreSQL, Docker smoke, SBOM and attestation gates              |

The table identifies executable evidence, not production approval. Promotion
still requires the staging, rollback, security, artifact, and human approval
gates in [Build and release](BUILD-RELEASE.md).
