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
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), request_id text not null,
  kind text not null check (kind in ('input_audio','tts_audio')), object_key text not null, content_type text not null,
  byte_length bigint not null check (byte_length >= 0), sha256 char(64) not null, duration_ms integer,
  status text not null, expires_at timestamptz not null, created_at timestamptz not null default now(),
  unique (tenant_id, sha256, kind)
);
create table if not exists crm_commands (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), request_id text not null,
  idempotency_key text not null, intent text not null, payload jsonb not null, status text not null,
  result jsonb, error_code text, created_at timestamptz not null default now(), committed_at timestamptz,
  unique (tenant_id, idempotency_key)
);
create table if not exists review_tasks (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), interaction_id uuid,
  reason text not null, candidates jsonb not null, status text not null default 'open', decision jsonb,
  assignee_id uuid, expires_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), event_type text not null,
  aggregate_type text not null, aggregate_id text not null, aggregate_version bigint not null, request_id text not null,
  payload jsonb not null, published_at timestamptz, attempts integer not null default 0, next_attempt_at timestamptz,
  created_at timestamptz not null default now(), unique (aggregate_type, aggregate_id, aggregate_version, event_type)
);
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
alter table outbox_events enable row level security;
alter table audit_records enable row level security;

-- Deployment role must set these transaction-local claims before queries.
-- FORCE RLS prevents accidental owner bypass in application sessions.
alter table tenants force row level security;
create policy tenant_isolation on tenants using (id::text = current_setting('app.tenant_id', true)) with check (id::text = current_setting('app.tenant_id', true));
do $$ declare t text; begin
  foreach t in array array['actors','customers','deals','voice_interactions','media_assets','crm_commands','review_tasks','outbox_events','audit_records'] loop
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;
