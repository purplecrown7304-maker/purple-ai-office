begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(6);

-- Scan the catalog, not a list of current application tables. Effective checks
-- include grants inherited from PUBLIC/roles and column-level write/read grants.
create function pg_temp.public_grant_violations(target_role name, allow_select boolean)
returns setof text language sql stable as $$
  select c.relname::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','f') and (
    has_table_privilege(target_role,c.oid,
      case when allow_select then 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        else 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN' end)
    or has_any_column_privilege(target_role,c.oid,
      case when allow_select then 'INSERT,UPDATE,REFERENCES' else 'SELECT,INSERT,UPDATE,REFERENCES' end)
  )
$$;

select is((select count(*)::integer from pg_temp.public_grant_violations('anon',false)),0,
  'anon has zero privileges on every public table');
select is((select count(*)::integer from pg_temp.public_grant_violations('authenticated',true)),0,
  'authenticated has at most SELECT on every public table');

-- Prove the scan catches a new table and inherited/column grants too. Rolled back.
create table public.grant_regression_probe(id integer);
revoke all on public.grant_regression_probe from public,anon,authenticated;
grant select on public.grant_regression_probe to public;
grant update(id) on public.grant_regression_probe to authenticated;
select ok(exists(select 1 from pg_temp.public_grant_violations('anon',false) where public_grant_violations='grant_regression_probe'),
  'new table with PUBLIC read grant is detected for anon');
select ok(exists(select 1 from pg_temp.public_grant_violations('authenticated',true) where public_grant_violations='grant_regression_probe'),
  'new table with column UPDATE grant is detected for authenticated');
revoke select on public.grant_regression_probe from public;
revoke update(id) on public.grant_regression_probe from authenticated;
grant select on public.grant_regression_probe to authenticated;
select is((select count(*)::integer from pg_temp.public_grant_violations('anon',false)),0,
  'anon scan is clean after removing the accidental grant');
select is((select count(*)::integer from pg_temp.public_grant_violations('authenticated',true)),0,
  'authenticated SELECT-only grants are permitted');
select * from finish();
rollback;
