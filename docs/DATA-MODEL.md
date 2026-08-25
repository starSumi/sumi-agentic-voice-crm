---
title: Database, fields, invariants and retention
description: CRM tables, field ownership, tenant and idempotency invariants, indexes, and data retention expectations.
docId: crm.data-model
locale: en
audience: both
contentVersion: 0.1.0
---

The production target is PostgreSQL 16+ with migrations. Development can use the deterministic in-memory adapter; `STORE_PROVIDER=postgres` selects the durable adapter and production rejects memory storage.

## Tables

### `tenants`

`id uuid PK`, `slug text UNIQUE`, `status active|suspended`, `policy_version text`, `created_at timestamptz`.

### `actors`

`id uuid PK`, `tenant_id uuid FK`, `subject text`, `display_name text`, `role text`, `scopes jsonb`, `status active|suspended`, `created_at timestamptz`. Role grants are an upper bound; actor scopes narrow them. The current actor row and tenant policy version are read inside each PostgreSQL transaction.

### `customers`

`id uuid PK`, `tenant_id uuid FK`, `name text`, `phone_ciphertext text NULL`, `preferred_language text`, `status active|archived`, `version bigint`, `created_at`, `updated_at`.

### `accounts`, `contacts`, `deals`, `activities`, `follow_ups`

The target CRM vocabulary includes these aggregates, each with `id`, `tenant_id`, `version`, timestamps and owner references. In the `0.1.0` reference migration only `deals` is materialized; the other four are explicitly **planned**, not silently implied as deployed tables. A production promotion must add their expand migrations, foreign keys, indexes and contract tests before the database gate is approved. `deals.stage` is an enum; `amount_minor bigint` plus `currency char(3)` is canonical.

### `voice_interactions`

`id uuid PK`, tenant/request/actor/idempotency identity, request fingerprint,
input type, status, encrypted input/transcript/understanding/response/error fields,
input asset reference, provider invocation metadata, model versions, stage
latency, HTTP result, lease owner/expiry, recovery count, and timestamps.
Sensitive JSON uses tenant-bound AES-256-GCM envelopes; full audio bytes never
enter this table.

### `interaction_wal`

Tenant and interaction identity, request ID, monotonically ordered sequence,
transition type, encrypted transition metadata, and creation time. PostgreSQL
WAL provides database durability; this separate application journal records
`started`, `checkpointed`, `recovered`, `completed`, and `failed` ordering. A
database trigger rejects update/delete, `FORCE RLS` isolates tenants, and the
journal append shares the interaction transaction. It deliberately omits raw
transcripts/provider payloads and is not sufficient to rebuild all state.

### `conversation_states`

Composite key `(tenant_id, conversation_id)`, monotonically increasing
`revision`, tenant-bound encrypted `state_ciphertext`, last updating actor and
timestamps. State is a bounded internal JSON object, not a copy of provider SSE
envelopes or a public transport DTO. Replacement is a single expected-revision
CAS update. A conflict reveals no newer state and requires an explicit read.

### `media_assets`

`id uuid PK`, `tenant_id`, `request_id`, `kind input_audio|tts_audio`, `object_key`, `content_type`, `byte_length`, `sha256`, `duration_ms`, `status`, `expires_at`, `created_at`. Unique `(tenant_id, sha256, kind)` enables safe cache deduplication.

### `transcripts`

Planned for the production persistence migration; the reference runtime keeps the transcript in the immutable interaction result only.

`id uuid PK`, `tenant_id`, `interaction_id`, `text_ciphertext`, `language`, `confidence numeric(5,4)`, `segments jsonb`, `provider`, `model`, `created_at`.

### `understandings`

Planned for the production persistence migration; the reference runtime keeps the understanding in the request response and review task.

`id uuid PK`, `tenant_id`, `interaction_id`, `schema_version`, `intent`, `confidence numeric(5,4)`, `entities jsonb`, `missing text[]`, `needs_confirmation boolean`, `created_at`.

### `crm_commands`

`id uuid PK`, `tenant_id`, `request_id`, `idempotency_key`, `intent`, `payload jsonb`, `status pending|committed|rejected`, `result jsonb`, `error_code NULL`, `created_at`, `committed_at`; unique `(tenant_id,idempotency_key)`.

### `review_tasks`

`id uuid PK`, `tenant_id`, `interaction_id`, `reason`, `candidates jsonb`, `status open|approved|rejected|expired`, `decision jsonb NULL`, `assignee_id NULL`, `expires_at`, timestamps.

### `outbox_events`

`id uuid PK`, tenant/event/aggregate/request identity, payload, publish time, attempts, next attempt, lease owner/time, last error, dead-letter time, and creation time. The relay claims due rows with `FOR UPDATE SKIP LOCKED`, signs CloudEvents delivery, retries with bounded exponential backoff, and preserves exhausted rows as dead letters.

### `audit_records`

`id uuid PK`, `tenant_id`, `actor_id`, `request_id`, `action`, `resource_type`, `resource_id`, `before_hash`, `after_hash`, `decision`, `reason_code`, `trace_id`, `created_at`. PII is referenced/hash-protected, not copied into audit messages.

## Invariants

- Every row has `tenant_id`; every query requires tenant predicate.
- A suspended or unregistered actor cannot enter a business transaction.
- A mutation is authorized against current actor and token scopes before its
  business write, audit and outbox records commit.
- `version` increases monotonically per aggregate under optimistic concurrency.
- A committed command has exactly one idempotency result and one corresponding outbox event.
- `crm_commands.status=committed` implies business transaction committed.
- `review_tasks.status=approved` contains actor, time and corrections.
- Media object is private and referenced by expiring URL only.
- Only an unexpired interaction lease owner may checkpoint or complete; stale
  work is reclaimed with a conditional update and increments `recovery_count`.
- `interaction_wal` is append-only and encrypted; replay responses remain owned
  by `voice_interactions`.
- Conversation state is tenant isolated and encrypted; only the current
  revision may be replaced, and every successful replacement increments it.
- Monetary arithmetic uses integer minor units; no floating-point persistence.
- Soft-delete/archival is explicit; hard deletion requires retention/legal policy event.

## Retention

Default: input audio 30 days, TTS audio 30 days (signed URLs 24h), raw transcript 90 days, inference metadata 1 year,
CRM/audit according to tenant/legal policy. A deletion job emits `media.asset.expired.v1`; it does not delete CRM records silently.
