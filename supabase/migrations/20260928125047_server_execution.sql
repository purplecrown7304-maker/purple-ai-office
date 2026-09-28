-- Server command receipts support retries across instances, including non-transition commands.
create table private.command_receipts (
  owner_id uuid not null references auth.users(id), request_id uuid not null,
  command jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
  primary key(owner_id,request_id)
);
alter table private.command_receipts enable row level security;
revoke all on private.command_receipts from public,anon,authenticated,service_role;
grant select,insert on private.command_receipts to service_role;
create trigger command_receipts_append_only before update or delete on private.command_receipts
  for each row execute function private.reject_audit_mutation();

alter table public.tasks add column demo_paused boolean not null default false;
alter table public.agent_runs add column input_payload jsonb not null default '{}';

-- A cancelled in-flight call may still return usage. Only a ledger-backed cost
-- increase is allowed on a terminal task; status, evidence and all other fields stay frozen.
create or replace function private.guard_task_mutation() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.status in ('DONE','CANCELLED') then
    if new.cost_usd <= old.cost_usd or new.cost_usd <> (
      select coalesce(sum(cost_usd),0) from public.agent_runs
      where task_id=old.id and status in ('RECORDED','APPLIED')
    ) or (to_jsonb(new)-array['cost_usd','version','updated_at']) is distinct from
           (to_jsonb(old)-array['cost_usd','version','updated_at']) then
      raise exception 'TERMINAL_TASK' using errcode='23514';
    end if;
  end if;
  if (new.lead_agent,new.reviewer_agent,new.acceptance_criteria,new.code,new.is_demo)
    is distinct from (old.lead_agent,old.reviewer_agent,old.acceptance_criteria,old.code,old.is_demo) then
    raise exception 'TASK_DEFINITION_IMMUTABLE' using errcode='23514';
  end if;
  if new.owner_id <> old.owner_id or new.project_id <> old.project_id then raise exception 'TASK_OWNER_IMMUTABLE' using errcode='23514'; end if;
  if new.version <> old.version + 1 then raise exception 'VERSION_INCREMENT_REQUIRED' using errcode='40001'; end if;
  if new.cost_usd < old.cost_usd or new.discussion_rounds < old.discussion_rounds or new.review_retries < old.review_retries or new.fix_attempts < old.fix_attempts or new.review_round < old.review_round then
    raise exception 'ACCOUNTING_CANNOT_DECREASE' using errcode='23514';
  end if;
  new.updated_at := now(); return new;
end $$;
