\set ON_ERROR_STOP on

begin;

-- User work is separate from the transactional outbox.  The job row is the
-- durable inbound receipt; the transition table preserves the short inbound
-- -> job_queued edge even though both writes commit atomically.
create table if not exists message_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  actor_id uuid references actors(id),
  request_id text not null,
  idempotency_key text not null,
  request_fingerprint char(64) not null,
  status text not null check (status in ('inbound','job_queued','running','succeeded','retry_wait','dead_letter','cancelled')),
  payload_ciphertext text not null,
  result_ciphertext text,
  error_code text,
  error_message_ciphertext text,
  attempts integer not null default 0 check (attempts >= 0),
  worker_id text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, request_id)
);

create index if not exists message_jobs_claimable
  on message_jobs (tenant_id, status, next_attempt_at, created_at)
  where status in ('job_queued','retry_wait');

create index if not exists message_jobs_expired
  on message_jobs (tenant_id, lease_expires_at)
  where status = 'running';

create table if not exists message_job_transitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid not null references message_jobs(id),
  sequence bigint not null,
  status text not null check (status in ('inbound','job_queued','running','succeeded','retry_wait','dead_letter','cancelled')),
  worker_id text,
  reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, job_id, sequence)
);

create table if not exists event_consumer_receipts (
  tenant_id uuid not null references tenants(id),
  consumer_id text not null,
  event_id text not null,
  event_type text,
  status text not null check (status in ('claimed','completed')),
  attempts integer not null default 1 check (attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, consumer_id, event_id)
);

create index if not exists event_consumer_receipts_expired
  on event_consumer_receipts (tenant_id, lease_expires_at)
  where status = 'claimed';

alter table message_jobs enable row level security;
alter table message_jobs force row level security;
drop policy if exists tenant_isolation on message_jobs;
create policy tenant_isolation on message_jobs
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

alter table message_job_transitions enable row level security;
alter table message_job_transitions force row level security;
drop policy if exists tenant_isolation on message_job_transitions;
create policy tenant_isolation on message_job_transitions
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

alter table event_consumer_receipts enable row level security;
alter table event_consumer_receipts force row level security;
drop policy if exists tenant_isolation on event_consumer_receipts;
create policy tenant_isolation on event_consumer_receipts
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

commit;
