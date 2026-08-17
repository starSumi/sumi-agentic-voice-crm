\set ON_ERROR_STOP on

begin;

create table if not exists conversation_states (
  tenant_id uuid not null references tenants(id),
  conversation_id text not null check (length(conversation_id) between 1 and 128),
  revision bigint not null default 0 check (revision >= 0),
  state_ciphertext text not null,
  updated_by uuid references actors(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, conversation_id)
);

create index if not exists conversation_states_tenant_updated
  on conversation_states(tenant_id, updated_at desc);

alter table conversation_states enable row level security;
alter table conversation_states force row level security;
drop policy if exists tenant_isolation on conversation_states;
create policy tenant_isolation on conversation_states
  using (tenant_id::text = current_setting('app.tenant_id', true))
  with check (tenant_id::text = current_setting('app.tenant_id', true));

commit;
