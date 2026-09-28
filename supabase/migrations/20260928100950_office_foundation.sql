-- Policy lives in src/domain/task-policy.ts. Only trusted server RPCs may write.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create type public.task_status as enum ('NEW','ANALYZING','DISCUSSION','PLANNED','IMPLEMENTING','CROSS_REVIEW','TESTING','FIXING','BLOCKED','WAITING_AGENT','WAITING_USER','ESCALATED','DONE','CANCELLED');
create type public.agent_status as enum ('IDLE','WORKING','REVIEWING','WAITING','ERROR','OFFLINE');
create type public.message_type as enum ('QUESTION','ANSWER','PROPOSAL','REVIEW_REQUEST','REVIEW_RESULT','TEST_REQUEST','TEST_RESULT','CHALLENGE','DECISION','HANDOFF','BLOCKER','STATUS');
create type public.queue_status as enum ('pending','processing','done','failed');
create type public.run_status as enum ('STARTED','RECORDED','APPLIED','FAILED','UNKNOWN_OUTCOME');

create table private.office_settings (
  singleton boolean primary key default true check (singleton),
  ceo_user_id uuid not null unique references auth.users(id),
  created_at timestamptz not null default now()
);
alter table private.office_settings enable row level security;
revoke all on private.office_settings from public, anon, authenticated;
grant select, insert on private.office_settings to service_role;

create function private.is_ceo() returns boolean language sql stable security definer
set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from private.office_settings where ceo_user_id = auth.uid()
  )
$$;
revoke all on function private.is_ceo() from public;
grant execute on function private.is_ceo() to authenticated, service_role;

create function private.valid_criteria(value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'array' then
    jsonb_array_length(value) > 0 and not exists (
      select 1 from jsonb_array_elements(value) e
      where jsonb_typeof(e) <> 'string' or btrim(e #>> '{}') = ''
    ) else false end
$$;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (btrim(name) <> ''), repository_url text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  default_budget_usd numeric(12,6) not null default 5.00 check (default_budget_usd between 0 and 999999.999999),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id,id)
);
create table public.agents (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  slug text not null check (slug ~ '^[a-z][a-z0-9-]*$'),
  display_name text not null check (btrim(display_name) <> ''),
  provider text not null default 'mock', model text not null default 'mock-v1',
  status public.agent_status not null default 'IDLE', current_task_id uuid, last_active_at timestamptz,
  unique(owner_id,slug), unique(owner_id,id)
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  code text not null unique check (btrim(code) <> ''), project_id uuid not null,
  title text not null check (btrim(title) <> ''), description text not null default '',
  status public.task_status not null default 'NEW',
  priority text not null default 'MEDIUM' check (priority in ('LOW','MEDIUM','HIGH','CRITICAL')),
  lead_agent uuid not null, reviewer_agent uuid not null,
  acceptance_criteria jsonb not null check (private.valid_criteria(acceptance_criteria)),
  budget_usd numeric(12,6) not null default 5.00 check (budget_usd between 0 and 999999.999999),
  cost_usd numeric(12,6) not null default 0 check (cost_usd between 0 and 999999.999999),
  discussion_rounds integer not null default 0 check (discussion_rounds >= 0),
  review_retries integer not null default 0 check (review_retries >= 0),
  fix_attempts integer not null default 0 check (fix_attempts >= 0),
  review_round integer not null default 0 check (review_round >= 0),
  version integer not null default 0 check (version >= 0),
  pause_reason text check (pause_reason in ('BUDGET','LIMIT','BLOCKER','AGENT','DECISION','FINAL_APPROVAL','UNKNOWN_OUTCOME')),
  resume_status public.task_status check (resume_status in ('NEW','ANALYZING','DISCUSSION','PLANNED','IMPLEMENTING','CROSS_REVIEW','TESTING','FIXING')),
  is_demo boolean not null default false, demo_step integer not null default 0 check (demo_step >= 0),
  demo_delay_ms integer not null default 2500 check (demo_delay_ms between 0 and 10000), demo_next_step_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (lead_agent <> reviewer_agent),
  unique(owner_id,id), unique(owner_id,project_id,id),
  foreign key(owner_id,project_id) references public.projects(owner_id,id),
  foreign key(owner_id,lead_agent) references public.agents(owner_id,id),
  foreign key(owner_id,reviewer_agent) references public.agents(owner_id,id)
);
alter table public.agents add foreign key(owner_id,current_task_id) references public.tasks(owner_id,id);

create table public.task_events (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, task_id uuid not null,
  from_status public.task_status, to_status public.task_status not null,
  actor text not null check (actor in ('ceo','agent','system')),
  actor_user_id uuid references auth.users(id), actor_agent_id uuid,
  reason text not null check (btrim(reason) <> ''), task_version integer not null check(task_version >= 0),
  request_id uuid not null, command jsonb not null default '{}', created_at timestamptz not null default now(),
  unique(task_id,task_version), unique(task_id,request_id),
  check (from_status is distinct from to_status),
  check ((actor = 'agent' and actor_agent_id is not null and actor_user_id is null)
    or (actor = 'ceo' and actor_user_id is not null and actor_user_id = owner_id and actor_agent_id is null)
    or (actor = 'system' and actor_user_id is null and actor_agent_id is null)),
  foreign key(owner_id,task_id) references public.tasks(owner_id,id),
  foreign key(owner_id,actor_agent_id) references public.agents(owner_id,id)
);
create table public.agent_messages (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, task_id uuid not null,
  from_agent uuid, to_agent uuid,
  from_role text not null check(from_role in ('agent','ceo','system')),
  to_role text not null check(to_role in ('agent','ceo','system')),
  type public.message_type not null, message text not null check(btrim(message) <> ''),
  requires_response boolean not null default false, queue_status public.queue_status not null default 'done',
  attempts integer not null default 0 check(attempts >= 0), processed_at timestamptz,
  in_reply_to uuid, run_id uuid, payload jsonb not null default '{}' check(jsonb_typeof(payload)='object'),
  review_round integer check(review_round > 0), available_at timestamptz not null default now(),
  claimed_at timestamptz, lease_expires_at timestamptz, request_id uuid not null unique,
  created_at timestamptz not null default now(),
  unique(owner_id,task_id,id),
  check ((from_role='agent') = (from_agent is not null)),
  check ((to_role='agent') = (to_agent is not null)),
  check (requires_response or (queue_status='done' and processed_at is not null)),
  check (queue_status <> 'done' or processed_at is not null),
  foreign key(owner_id,task_id) references public.tasks(owner_id,id),
  foreign key(owner_id,from_agent) references public.agents(owner_id,id),
  foreign key(owner_id,to_agent) references public.agents(owner_id,id),
  foreign key(owner_id,task_id,in_reply_to) references public.agent_messages(owner_id,task_id,id)
);
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, task_id uuid not null, agent_id uuid not null,
  message_id uuid not null, started_at timestamptz not null default now(), ended_at timestamptz,
  status public.run_status not null default 'STARTED',
  input_tokens bigint check(input_tokens >= 0), output_tokens bigint check(output_tokens >= 0),
  cost_usd numeric(12,6) check(cost_usd between 0 and 999999.999999), provider text not null, model text not null, error text,
  idempotency_key uuid not null unique, response_payload jsonb, applied_at timestamptz, lease_expires_at timestamptz,
  unique(owner_id,task_id,id),
  check (status not in ('RECORDED','APPLIED') or (ended_at is not null and input_tokens is not null and output_tokens is not null and cost_usd is not null and response_payload is not null)),
  check ((status='APPLIED') = (applied_at is not null)),
  foreign key(owner_id,task_id) references public.tasks(owner_id,id),
  foreign key(owner_id,agent_id) references public.agents(owner_id,id),
  foreign key(owner_id,task_id,message_id) references public.agent_messages(owner_id,task_id,id)
);
create unique index one_unsettled_run_per_task on public.agent_runs(task_id) where status in ('STARTED','RECORDED','UNKNOWN_OUTCOME');
alter table public.agent_messages add foreign key(owner_id,task_id,run_id) references public.agent_runs(owner_id,task_id,id);
create table public.test_results (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, task_id uuid not null, agent_id uuid not null,
  test_type text not null, result text not null check(result in ('PENDING','PASS','FAIL')),
  output text not null default '', created_at timestamptz not null default now(),
  foreign key(owner_id,task_id) references public.tasks(owner_id,id),
  foreign key(owner_id,agent_id) references public.agents(owner_id,id)
);
create table public.decisions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, project_id uuid not null, task_id uuid,
  question text not null, decision text not null, reason text not null, decided_by text not null,
  created_at timestamptz not null default now(),
  foreign key(owner_id,project_id) references public.projects(owner_id,id),
  foreign key(owner_id,project_id,task_id) references public.tasks(owner_id,project_id,id)
);
create table public.artifacts (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null, task_id uuid not null, agent_id uuid not null,
  type text not null, path text not null, metadata jsonb not null default '{}', created_at timestamptz not null default now(),
  foreign key(owner_id,task_id) references public.tasks(owner_id,id),
  foreign key(owner_id,agent_id) references public.agents(owner_id,id)
);

-- Owner-composite FKs protect ownership; these checks protect assigned-agent identity.
create function private.check_task_participant() returns trigger language plpgsql set search_path='' as $$
declare task_row public.tasks; ids uuid[]; participant uuid;
begin
  select * into task_row from public.tasks where id=new.task_id and owner_id=new.owner_id;
  if not found then raise exception 'TASK_REFERENCE_INVALID' using errcode='23503'; end if;
  if tg_table_name='agent_messages' then ids:=array[new.from_agent,new.to_agent];
  elsif tg_table_name='task_events' then ids:=array[new.actor_agent_id];
  else ids:=array[new.agent_id]; end if;
  foreach participant in array ids loop
    if participant is not null and participant not in (task_row.lead_agent,task_row.reviewer_agent) then
      raise exception 'UNASSIGNED_AGENT' using errcode='23514';
    end if;
  end loop;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['agent_messages','agent_runs','task_events','test_results','artifacts'] loop
    execute format('create trigger assigned_participant before insert or update on public.%I for each row execute function private.check_task_participant()',t);
  end loop;
end $$;

-- DB protection applies even to service_role (RLS bypass is not a trigger bypass).
create function private.reject_audit_mutation() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'AUDIT_IMMUTABLE' using errcode='23514'; end $$;
create trigger task_events_append_only before update or delete on public.task_events for each row execute function private.reject_audit_mutation();
create trigger decisions_append_only before update or delete on public.decisions for each row execute function private.reject_audit_mutation();
create function private.guard_run_mutation() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'RUN_DELETE_FORBIDDEN' using errcode='23514'; end if;
  if old.status in ('APPLIED','FAILED','UNKNOWN_OUTCOME') then raise exception 'SETTLED_RUN_IMMUTABLE' using errcode='23514'; end if;
  if old.status='RECORDED' then
    if new.status <> 'APPLIED' or new.applied_at is null or
      (to_jsonb(new) - 'status' - 'applied_at') is distinct from (to_jsonb(old) - 'status' - 'applied_at') then
      raise exception 'RECORDED_RUN_IMMUTABLE' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
create trigger protect_recorded_run before update or delete on public.agent_runs for each row execute function private.guard_run_mutation();

create function private.guard_task_mutation() returns trigger language plpgsql set search_path='' as $$
begin
  if old.status in ('DONE','CANCELLED') then raise exception 'TERMINAL_TASK' using errcode='23514'; end if;
  if new.owner_id <> old.owner_id or new.project_id <> old.project_id then raise exception 'TASK_OWNER_IMMUTABLE' using errcode='23514'; end if;
  if new.version <> old.version + 1 then raise exception 'VERSION_INCREMENT_REQUIRED' using errcode='40001'; end if;
  if new.cost_usd < old.cost_usd or new.discussion_rounds < old.discussion_rounds or new.review_retries < old.review_retries or new.fix_attempts < old.fix_attempts or new.review_round < old.review_round then
    raise exception 'ACCOUNTING_CANNOT_DECREASE' using errcode='23514';
  end if;
  new.updated_at := now(); return new;
end $$;
create trigger protect_task before update on public.tasks for each row execute function private.guard_task_mutation();
create function private.audit_task_status() returns trigger language plpgsql set search_path='' as $$
declare details jsonb;
begin
  if tg_op='INSERT' then
    if new.status <> 'NEW' or new.version <> 0 then raise exception 'TASK_MUST_START_NEW' using errcode='23514'; end if;
    insert into public.task_events(owner_id,task_id,to_status,actor,actor_user_id,reason,task_version,request_id)
      values(new.owner_id,new.id,'NEW','ceo',new.owner_id,'Task created',0,gen_random_uuid());
  elsif new.status is distinct from old.status then
    details := nullif(current_setting('office.transition',true),'')::jsonb;
    if details is null or (details->>'task_id')::uuid <> new.id then raise exception 'TRANSITION_RPC_REQUIRED' using errcode='23514'; end if;
    insert into public.task_events(owner_id,task_id,from_status,to_status,actor,actor_user_id,actor_agent_id,reason,task_version,request_id,command)
      values(new.owner_id,new.id,old.status,new.status,details->>'actor',
        (details->>'actor_user_id')::uuid,(details->>'actor_agent_id')::uuid,details->>'reason',new.version,(details->>'request_id')::uuid,details->'command');
  end if;
  return new;
end $$;
create trigger audit_task_status after insert or update on public.tasks for each row execute function private.audit_task_status();

-- No duplicated transition map. This RPC accepts ONLY server-validated plans.
create function public.apply_task_transition(
  p_owner_id uuid, p_task_id uuid, p_expected_version integer, p_request_id uuid,
  p_to_status public.task_status, p_actor text, p_actor_agent_id uuid, p_reason text,
  p_discussion_rounds integer, p_review_retries integer, p_fix_attempts integer, p_review_round integer,
  p_pause_reason text default null, p_resume_status public.task_status default null
) returns public.tasks language plpgsql security invoker set search_path='' as $$
declare current_task public.tasks; old_event public.task_events; command jsonb;
begin
  select * into current_task from public.tasks where id=p_task_id and owner_id=p_owner_id for update;
  if not found or not exists(select 1 from private.office_settings where ceo_user_id=p_owner_id) then raise exception 'TASK_NOT_FOUND' using errcode='42501'; end if;
  command := jsonb_build_object('version',p_expected_version,'to',p_to_status,'actor',p_actor,'agent',p_actor_agent_id,'reason',p_reason,'discussion',p_discussion_rounds,'reviews',p_review_retries,'fixes',p_fix_attempts,'round',p_review_round,'pause',p_pause_reason,'resume',p_resume_status);
  select * into old_event from public.task_events where task_id=p_task_id and request_id=p_request_id;
  if found then
    if old_event.command <> command then raise exception 'IDEMPOTENCY_CONFLICT' using errcode='23514'; end if;
    return current_task;
  end if;
  if current_task.status in ('DONE','CANCELLED') then raise exception 'TERMINAL_TASK' using errcode='23514'; end if;
  if current_task.version <> p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if p_to_status = current_task.status then raise exception 'NOT_A_TRANSITION' using errcode='23514'; end if;
  if p_actor='agent' and p_actor_agent_id not in (current_task.lead_agent,current_task.reviewer_agent) then raise exception 'UNASSIGNED_AGENT' using errcode='23514'; end if;
  perform set_config('office.transition',jsonb_build_object('task_id',p_task_id,'request_id',p_request_id,'actor',p_actor,'actor_user_id',case when p_actor='ceo' then p_owner_id end,'actor_agent_id',p_actor_agent_id,'reason',p_reason,'command',command)::text,true);
  update public.tasks set status=p_to_status, version=version+1, discussion_rounds=p_discussion_rounds,
    review_retries=p_review_retries, fix_attempts=p_fix_attempts, review_round=p_review_round,
    pause_reason=p_pause_reason,resume_status=p_resume_status where id=p_task_id returning * into current_task;
  perform set_config('office.transition','',true);
  return current_task;
end $$;
revoke all on function public.apply_task_transition(uuid,uuid,integer,uuid,public.task_status,text,uuid,text,integer,integer,integer,integer,text,public.task_status) from public,anon,authenticated;
grant execute on function public.apply_task_transition(uuid,uuid,integer,uuid,public.task_status,text,uuid,text,integer,integer,integer,integer,text,public.task_status) to service_role;

-- Read access is CEO AND ownership. Client mutations are revoked entirely.
do $$ declare t text; begin
  foreach t in array array['projects','tasks','agents','task_events','agent_messages','agent_runs','test_results','decisions','artifacts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant select, insert, update, delete on public.%I to service_role',t);
    execute format('create policy ceo_read on public.%I for select to authenticated using ((select private.is_ceo()) and owner_id = (select auth.uid()))',t);
    execute format('create index on public.%I(owner_id)',t);
  end loop;
end $$;
-- TRUNCATE skips row triggers: never grant it to the runtime role.
revoke all on all functions in schema private from public, anon;
grant execute on function private.valid_criteria(jsonb) to service_role;

create index on public.tasks(project_id,status,updated_at);
create index on public.tasks(lead_agent);
create index on public.tasks(reviewer_agent);
create index on public.agents(current_task_id);
create index on public.task_events(task_id,created_at,id);
create index on public.agent_messages(task_id,created_at,id);
create index on public.agent_messages(queue_status,available_at,created_at) where requires_response and queue_status='pending';
create index on public.agent_runs(task_id,started_at,id);
create index on public.test_results(task_id);
create index on public.decisions(project_id);
create index on public.artifacts(task_id);

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.tasks, public.task_events, public.agents, public.agent_messages;
  end if;
end $$;
