-- Human-facing codes are scoped to a project; UUID remains the global identity.
alter table public.tasks drop constraint tasks_code_key;
alter table public.tasks add constraint tasks_project_code_key unique(project_id,code);
create table private.task_counters (
  owner_id uuid not null, project_id uuid not null,
  next_number integer not null check(next_number>0),
  primary key(owner_id,project_id),
  foreign key(owner_id,project_id) references public.projects(owner_id,id) on delete cascade
);
alter table private.task_counters enable row level security;
revoke all on private.task_counters from public,anon,authenticated,service_role;
grant select,insert,update on private.task_counters to service_role;
insert into private.task_counters(owner_id,project_id,next_number)
  select owner_id,project_id,coalesce(max(substring(code from '^TASK-([0-9]+)$')::integer),0)+1
  from public.tasks group by owner_id,project_id;
