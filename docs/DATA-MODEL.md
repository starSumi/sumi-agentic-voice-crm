---
title: Database, fields, invariants and retention
description: CRM tables, field ownership, tenant and idempotency invariants, indexes, and data retention expectations.
docId: crm.data-model
locale: en
audience: both
contentVersion: 0.1.0
---

The production target is PostgreSQL 16+ with migrations. The reference runtime uses an in-memory store so contract tests are deterministic; it is not a production database.

## Tables

### `tenants`

`id uuid PK`, `slug text UNIQUE`, `status active|suspended`, `policy_version text`, `created_at timestamptz`.

### `actors`

`id uuid PK`, `tenant_id uuid FK`, `subject text`, `display_name text`, `role text`, `scopes jsonb`, `created_at timestamptz`.

### `customers`

`id uuid PK`, `tenant_id uuid FK`, `name text`, `phone_ciphertext text NULL`, `preferred_language text`, `status active|archived`, `version bigint`, `created_at`, `updated_at`.

### `accounts`, `contacts`, `deals`, `activities`, `follow_ups`

The target CRM vocabulary includes these aggregates, each with `id`, `tenant_id`, `version`, timestamps and owner references. In the `0.1.0` reference migration only `deals` is materialized; the other four are explicitly **planned**, not silently implied as deployed tables. A production promotion must add their expand migrations, foreign keys, indexes and contract tests before C2 approval. `deals.stage` is an enum; `amount_minor bigint` plus `currency char(3)` is canonical.

### `voice_interactions`

`id uuid PK`, `tenant_id`, `request_id UNIQUE`, `actor_id`, `input_type text`, `status`, `conversation_id NULL`, `transcript_id NULL`, `understanding_id NULL`, `crm_command_id NULL`, `answer_text_ciphertext NULL`, `model_versions jsonb`, `latency_ms jsonb`, `created_at`, `completed_at`.

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

`id uuid PK`, `tenant_id`, `event_type`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `request_id`, `payload jsonb`, `published_at NULL`, `attempts`, `next_attempt_at`, `created_at`; unique `(aggregate_type, aggregate_id, aggregate_version, event_type)`.

### `audit_records`

`id uuid PK`, `tenant_id`, `actor_id`, `request_id`, `action`, `resource_type`, `resource_id`, `before_hash`, `after_hash`, `decision`, `reason_code`, `trace_id`, `created_at`. PII is referenced/hash-protected, not copied into audit messages.

## Invariants

- Every row has `tenant_id`; every query requires tenant predicate.
- `version` increases monotonically per aggregate under optimistic concurrency.
- A committed command has exactly one idempotency result and one corresponding outbox event.
- `crm_commands.status=committed` implies business transaction committed.
- `review_tasks.status=approved` contains actor, time and corrections.
- Media object is private and referenced by expiring URL only.
- Monetary arithmetic uses integer minor units; no floating-point persistence.
- Soft-delete/archival is explicit; hard deletion requires retention/legal policy event.

## Retention

Default: input audio 30 days, TTS audio 30 days (signed URLs 24h), raw transcript 90 days, inference metadata 1 year,
CRM/audit according to tenant/legal policy. A deletion job emits `media.asset.expired.v1`; it does not delete CRM records silently.
