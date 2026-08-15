-- Production target: PostgreSQL 16+. Apply with a migration tool, never by hand in production.
create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(), slug text not null unique,
  status text not null check (status in ('active','suspended')), policy_version text not null default 'policy.v1',
  created_at timestamptz not null default now()
);
create table if not exists actors (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
  subject text not null, display_name text not null, role text not null, scopes jsonb not null default '[]', created_at timestamptz not null default now(),
  unique (tenant_id, subject)
);
create table if not exists customers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), name text not null,
  phone_ciphertext text, preferred_language text not null, status text not null default 'active' check (status in ('active','archived')),
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists customers_tenant_updated on customers(tenant_id, updated_at desc);
create table if not exists deals (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), account_id uuid,
  name text not null, stage text not null, amount_minor bigint not null default 0, currency char(3) not null default 'USD',
  probability smallint not null check (probability between 0 and 100), owner_id uuid, version bigint not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists voice_interactions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), request_id text not null unique,
  actor_id uuid, input_type text not null check (input_type in ('text','audio')), status text not null, conversation_id text,
  transcript_id uuid, understanding_id uuid, crm_command_id uuid, answer_text_ciphertext text, model_versions jsonb not null default '{}',
  latency_ms jsonb not null default '{}', created_at timestamptz not null default now(), completed_at timestamptz
);
alter table voice_interactions add column if not exists idempotency_key text;
alter table voice_interactions add column if not exists request_fingerprint char(64);
alter table voice_interactions add column if not exists input_payload_ciphertext text;
alter table voice_interactions add column if not exists transcript_ciphertext text;
alter table voice_interactions add column if not exists understanding_ciphertext text;
alter table voice_interactions add column if not exists response_ciphertext text;
alter table voice_interactions add column if not exists provider_invocations jsonb not null default '[]';
alter table voice_interactions add column if not exists error_code text;
alter table voice_interactions add column if not exists error_message_ciphertext text;
alter table voice_interactions add column if not exists http_status integer;
alter table voice_interactions add column if not exists input_asset_id uuid;
alter table voice_interactions add column if not exists updated_at timestamptz not null default now();
create unique index if not exists voice_interactions_tenant_idempotency
  on voice_interactions(tenant_id, idempotency_key) where idempotency_key is not null;
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), request_id text not null,
  kind text not null check (kind in ('input_audio','tts_audio')), object_key text not null, external_asset_id text,
  content_type text not null,
  byte_length bigint not null check (byte_length >= 0), sha256 char(64) not null, duration_ms integer,
  status text not null, expires_at timestamptz not null, created_at timestamptz not null default now(),
  unique (tenant_id, sha256, kind)
);
alter table media_assets add column if not exists external_asset_id text;
create unique index if not exists media_assets_tenant_external_asset
  on media_assets(tenant_id, external_asset_id) where external_asset_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'voice_interactions_input_asset_fk') then
    alter table voice_interactions add constraint voice_interactions_input_asset_fk foreign key (input_asset_id) references media_assets(id);
  end if;
end $$;
create table if not exists crm_commands (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), request_id text not null,
  idempotency_key text not null, request_fingerprint char(64) not null, intent text not null, payload jsonb not null, status text not null,
  result jsonb, error_code text, created_at timestamptz not null default now(), committed_at timestamptz,
  unique (tenant_id, idempotency_key)
);
-- Expand safely when upgrading an earlier pre-alpha database. The temporary
-- fingerprint is deliberately impossible for new API requests and is only a
-- compatibility marker for historical rows created before this invariant.
alter table crm_commands add column if not exists request_fingerprint char(64);
update crm_commands set request_fingerprint = repeat('0', 64) where request_fingerprint is null;
alter table crm_commands alter column request_fingerprint set not null;
create table if not exists review_tasks (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), interaction_id uuid,
  command_id uuid references crm_commands(id),
  reason text not null, candidates jsonb not null, status text not null default 'open', decision jsonb,
  assignee_id uuid, expires_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table review_tasks add column if not exists command_id uuid references crm_commands(id);
update review_tasks
set command_id = (decision->>'command_id')::uuid
where command_id is null
  and decision ? 'command_id'
  and (decision->>'command_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- Durable TTS idempotency is separate from CRM command idempotency because a
-- TTS request has an asset lifecycle and may be replayed without re-running a
-- CRM mutation. The request row is the conflict boundary; the media row is
-- the tenant-scoped asset metadata and private-object locator.
create table if not exists tts_requests (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
  actor_id uuid references actors(id), request_id text not null, idempotency_key text not null,
  request_fingerprint char(64) not null, media_asset_id uuid not null references media_assets(id),
  result jsonb not null, created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index if not exists tts_requests_tenant_asset on tts_requests(tenant_id, media_asset_id);

-- Review decisions have their own idempotency namespace. A reviewer may retry
-- a decision while the original review task is already closed; replaying the
-- same key must return the original response and a different payload must
-- fail with a conflict.
create table if not exists review_decisions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
  review_id uuid not null references review_tasks(id), idempotency_key text not null,
  request_fingerprint char(64) not null, result jsonb not null, created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), event_type text not null,
  aggregate_type text not null, aggregate_id text not null, aggregate_version bigint not null, request_id text not null,
  payload jsonb not null, published_at timestamptz, attempts integer not null default 0, next_attempt_at timestamptz,
  created_at timestamptz not null default now(), unique (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type)
);
alter table outbox_events add column if not exists locked_at timestamptz;
alter table outbox_events add column if not exists lock_owner text;
alter table outbox_events add column if not exists last_error text;
alter table outbox_events add column if not exists dead_lettered_at timestamptz;
create index if not exists outbox_events_pending
  on outbox_events(tenant_id, next_attempt_at, created_at)
  where published_at is null and dead_lettered_at is null;
create table if not exists audit_records (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), actor_id uuid, request_id text not null,
  action text not null, resource_type text, resource_id text, before_hash text, after_hash text, decision text not null,
  reason_code text, trace_id text, created_at timestamptz not null default now()
);

-- RLS is mandatory in production; policies are generated per deployment tenant model.
alter table tenants enable row level security;
alter table actors enable row level security;
alter table customers enable row level security;
alter table deals enable row level security;
alter table voice_interactions enable row level security;
alter table media_assets enable row level security;
alter table crm_commands enable row level security;
alter table review_tasks enable row level security;
alter table tts_requests enable row level security;
alter table review_decisions enable row level security;
alter table outbox_events enable row level security;
alter table audit_records enable row level security;

-- Deployment role must set these transaction-local claims before queries.
-- FORCE RLS prevents accidental owner bypass in application sessions.
alter table tenants force row level security;
drop policy if exists tenant_isolation on tenants;
create policy tenant_isolation on tenants using (id::text = current_setting('app.tenant_id', true)) with check (id::text = current_setting('app.tenant_id', true));
do $$ declare t text; begin
  foreach t in array array['actors','customers','deals','voice_interactions','media_assets','crm_commands','review_tasks','tts_requests','review_decisions','outbox_events','audit_records'] loop
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;
