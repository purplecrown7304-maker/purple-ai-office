-- PR #2 Claude review: keep the initial migration intact and harden existing rows.
create or replace function private.guard_task_mutation() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.status in ('DONE','CANCELLED') then raise exception 'TERMINAL_TASK' using errcode='23514'; end if;
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

create trigger test_results_append_only before update or delete on public.test_results
  for each row execute function private.reject_audit_mutation();
create trigger artifacts_append_only before update or delete on public.artifacts
  for each row execute function private.reject_audit_mutation();

create function private.guard_message_mutation() returns trigger
language plpgsql set search_path='' as $$
declare mutable_columns constant text[] := array[
  'queue_status','attempts','processed_at','claimed_at','lease_expires_at','available_at','run_id'
];
begin
  if tg_op='DELETE' then raise exception 'MESSAGE_DELETE_FORBIDDEN' using errcode='23514'; end if;
  -- Allow-list mutable fields: newly added evidence columns are immutable by default.
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception 'MESSAGE_CONTENT_IMMUTABLE' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function private.guard_message_mutation() from public,anon,authenticated;
create trigger protect_message before update or delete on public.agent_messages
  for each row execute function private.guard_message_mutation();
