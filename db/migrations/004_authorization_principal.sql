-- Authorization facts remain tenant data. RLS is still the tenant isolation
-- boundary; the application policy decision point owns business authorization.
alter table actors add column if not exists status text not null default 'active';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'actors_status_check'
      and conrelid = 'actors'::regclass
  ) then
    alter table actors add constraint actors_status_check
      check (status in ('active', 'suspended'));
  end if;
end $$;

-- Existing pre-policy actors inherit the explicit ceiling of their current
-- role. Subsequent grants and reductions must be deliberate data changes.
update actors
set scopes = case role
  when 'agent' then '["interaction.ask","crm.search","crm.customer.create","crm.deal.update_stage","media.tts.create","media.asset.read","events.read","progress.subscribe"]'::jsonb
  when 'reviewer' then '["crm.search","crm.customer.create","crm.deal.update_stage","review.decide","media.asset.read","events.read","progress.subscribe"]'::jsonb
  when 'auditor' then '["crm.search","media.asset.read","events.read"]'::jsonb
  when 'tenant_admin' then '["interaction.ask","crm.*","review.decide","media.*","events.read","progress.subscribe"]'::jsonb
  when 'workload' then '["outbox.relay"]'::jsonb
  else '[]'::jsonb
end
where scopes = '[]'::jsonb;

create index if not exists actors_tenant_subject_active
  on actors (tenant_id, subject) where status = 'active';
