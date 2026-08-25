\set ON_ERROR_STOP on

begin;

alter table voice_interactions add column if not exists lease_owner text;
alter table voice_interactions add column if not exists lease_expires_at timestamptz;
alter table voice_interactions add column if not exists recovery_count integer not null default 0;

-- Existing in-flight rows are immediately reclaimable. Their old process
-- cannot own a lease introduced after it started.
update voice_interactions
set lease_owner = coalesce(lease_owner, request_id),
    lease_expires_at = coalesce(lease_expires_at, now())
where status = 'processing';

create index if not exists voice_interactions_stale_processing
  on voice_interactions(tenant_id, lease_expires_at)
  where status = 'processing';

-- PostgreSQL WAL remains the database durability mechanism. This encrypted,
-- append-only application journal records orchestration transitions so a stale
-- interaction can be reclaimed without storing transcripts or provider output
-- in plaintext.
create table if not exists interaction_wal (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  interaction_id uuid not null references voice_interactions(id),
  request_id text not null,
  sequence bigint not null,
  entry_type text not null check (entry_type in ('started','checkpointed','recovered','abandoned','completed','failed')),
  payload_ciphertext text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, interaction_id, sequence)
);

create index if not exists interaction_wal_request
  on interaction_wal(tenant_id, request_id, sequence);

alter table interaction_wal enable row level security;
alter table interaction_wal force row level security;
drop policy if exists tenant_isolation on interaction_wal;
create policy tenant_isolation on interaction_wal
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

create or replace function reject_interaction_wal_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'interaction_wal is append-only' using errcode = '55000';
end;
$$;

drop trigger if exists interaction_wal_append_only on interaction_wal;
create trigger interaction_wal_append_only
before update or delete on interaction_wal
for each row execute function reject_interaction_wal_mutation();

commit;
