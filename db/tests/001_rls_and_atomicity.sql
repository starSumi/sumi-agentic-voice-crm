\set ON_ERROR_STOP on

-- Destructive integration fixture for an ephemeral database only. The runner
-- creates and drops that database; never execute this file against a shared DB.

create role sumi_app login;
grant usage on schema public to sumi_app;
grant select, insert, update, delete on all tables in schema public to sumi_app;
grant usage, select on all sequences in schema public to sumi_app;

insert into tenants (id, slug, status) values
  ('00000000-0000-4000-8000-000000000001', 'tenant-a', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'tenant-b', 'active');

insert into actors (id, tenant_id, subject, display_name, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'actor-a', 'Actor A', 'agent'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'actor-b', 'Actor B', 'agent');

insert into customers (id, tenant_id, name, preferred_language) values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Customer A', 'en-US'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'Customer B', 'zh-CN');

set role sumi_app;
begin;
select set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
do $$ begin
  if (select count(*) from customers) <> 1 then
    raise exception 'tenant A must see exactly one customer';
  end if;
  if exists (select 1 from customers where tenant_id = '00000000-0000-4000-8000-000000000002') then
    raise exception 'tenant A can read tenant B';
  end if;
end $$;
do $$ begin
  begin
    insert into customers (tenant_id, name, preferred_language)
    values ('00000000-0000-4000-8000-000000000002', 'cross-tenant', 'en-US');
    raise exception 'cross-tenant insert unexpectedly succeeded';
  exception when insufficient_privilege or check_violation then
    null;
  end;
end $$;
rollback;

begin;
select set_config('app.tenant_id', '00000000-0000-4000-8000-000000000002', true);
do $$ begin
  if (select count(*) from customers) <> 1 then
    raise exception 'tenant B must see exactly one customer';
  end if;
end $$;
rollback;
reset role;

-- A CRM mutation, command result, audit row, and outbox row share one
-- transaction. The commit fixture must persist all four records.
begin;
select set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
set local role sumi_app;
update customers
set status = 'archived', version = version + 1, updated_at = now()
where id = '20000000-0000-4000-8000-000000000001';
insert into crm_commands
  (id, tenant_id, request_id, idempotency_key, request_fingerprint, intent, payload, status, result, committed_at)
values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   'req_atomic_commit', 'db-atomic-key-0001', repeat('1',64), 'crm.customer.archive', '{}', 'committed',
   '{"aggregate_version":2}', now());
insert into audit_records
  (tenant_id, actor_id, request_id, action, resource_type, resource_id, decision)
values
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'req_atomic_commit', 'crm.customer.archive', 'customer', '20000000-0000-4000-8000-000000000001', 'committed');
insert into outbox_events
  (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, request_id, payload)
values
  ('00000000-0000-4000-8000-000000000001', 'crm.command.committed.v1', 'customer',
   '20000000-0000-4000-8000-000000000001', 2, 'req_atomic_commit', '{"aggregate_version":2}');
commit;

set role sumi_app;
begin;
select set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
do $$ begin
  if (select status from customers where id = '20000000-0000-4000-8000-000000000001') <> 'archived' then
    raise exception 'business mutation was not committed';
  end if;
  if (select count(*) from crm_commands where request_id = 'req_atomic_commit') <> 1
     or (select count(*) from audit_records where request_id = 'req_atomic_commit') <> 1
     or (select count(*) from outbox_events where request_id = 'req_atomic_commit') <> 1 then
    raise exception 'atomic command/audit/outbox records are incomplete';
  end if;
end $$;
rollback;
reset role;

-- The rollback fixture writes the same four categories and then aborts. None
-- of those records may survive.
begin;
select set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
set local role sumi_app;
update customers
set status = 'active', version = version + 1, updated_at = now()
where id = '20000000-0000-4000-8000-000000000001';
insert into crm_commands
  (tenant_id, request_id, idempotency_key, request_fingerprint, intent, payload, status)
values
  ('00000000-0000-4000-8000-000000000001', 'req_atomic_rollback',
   'db-atomic-key-0002', repeat('2',64), 'crm.customer.restore', '{}', 'pending');
insert into audit_records
  (tenant_id, actor_id, request_id, action, resource_type, resource_id, decision)
values
  ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'req_atomic_rollback', 'crm.customer.restore', 'customer', '20000000-0000-4000-8000-000000000001', 'pending');
insert into outbox_events
  (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, request_id, payload)
values
  ('00000000-0000-4000-8000-000000000001', 'crm.command.committed.v1', 'customer',
   '20000000-0000-4000-8000-000000000001', 3, 'req_atomic_rollback', '{"aggregate_version":3}');
rollback;

set role sumi_app;
begin;
select set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);
do $$ begin
  if (select status from customers where id = '20000000-0000-4000-8000-000000000001') <> 'archived' then
    raise exception 'rolled-back business mutation leaked';
  end if;
  if exists (select 1 from crm_commands where request_id = 'req_atomic_rollback')
     or exists (select 1 from audit_records where request_id = 'req_atomic_rollback')
     or exists (select 1 from outbox_events where request_id = 'req_atomic_rollback') then
    raise exception 'rolled-back command/audit/outbox record leaked';
  end if;
end $$;
rollback;
reset role;

select 'sumi postgres integration passed' as result;
