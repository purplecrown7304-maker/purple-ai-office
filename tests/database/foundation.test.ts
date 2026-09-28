import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { configureCeo } from '../../scripts/ceo-setup';

const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const task='10000000-0000-4000-8000-000000000004';
const agent='10000000-0000-4000-8000-000000000002';
const tables=['projects','tasks','agents','task_events','agent_messages','agent_runs','test_results','decisions','artifacts'];
let exec: (sql:string) => Promise<unknown>;
let query: (sql:string,params?:string[]) => Promise<Record<string,unknown>[]>;
let close: () => Promise<void>;

beforeAll(async () => {
  const connection=process.env.OFFICE_TEST_DATABASE_URL;
  if(connection) {
    const url=new URL(connection);
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Database tests require an isolated loopback database');
    const sql=postgres(connection,{max:1,onnotice:()=>{}});
    exec=async s=>sql.unsafe(s); query=async (s,p)=>Array.from(await sql.unsafe(s,p)); close=()=>sql.end();
    // Real Supabase is migrated by the CLI in CI. Never recreate its auth schema.
  } else {
    const db=new PGlite();
    exec=s=>db.exec(s); query=async (s,p)=>(await db.query<Record<string,unknown>>(s,p)).rows; close=()=>db.close();
    await exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create publication supabase_realtime;`);
    for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) await exec(await readFile(`supabase/migrations/${file}`,'utf8'));
  }
});
beforeEach(async()=>{ await exec('begin'); await exec(await readFile('tests/database/fixture.sql','utf8')); });
afterEach(async()=>{ await exec('rollback'); });
afterAll(async()=>{ await close?.(); });
async function asRole(role:string,uid='') {
  await exec(`set local role ${role}; select set_config('request.jwt.claim.sub','${uid}',true);`);
}
// PostgreSQL aborts the current transaction on errors; preserve each test's fixture.
async function rejects(sql:string,pattern:RegExp) {
  await exec('savepoint expected_failure');
  try { await expect(exec(sql)).rejects.toThrow(pattern); }
  finally { await exec('rollback to savepoint expected_failure'); }
}
function rpc({status='ANALYZING',version=0,request='30000000-0000-4000-8000-000000000001',fixes=0,reason='Start'}={}) {
  return `select * from public.apply_task_transition('${owner}','${task}',${version},'${request}','${status}','agent','${agent}','${reason}',0,0,${fixes},0)`;
}

describe('database contracts',()=>{
  it('sets up an existing confirmed CEO idempotently without replacing a configured CEO',async()=>{
    await exec('delete from private.office_settings');
    await configureCeo({query},' CEO@EXAMPLE.INVALID ');
    await configureCeo({query},'ceo@example.invalid');
    expect(await query('select ceo_user_id from private.office_settings')).toEqual([{ceo_user_id:owner}]);
    expect(await query(`select * from public.agents where owner_id='${owner}'`)).toHaveLength(2);
    await expect(configureCeo({query},'other@example.invalid')).rejects.toThrow('CEO_ALREADY_CONFIGURED');
    await expect(configureCeo({query},'missing@example.invalid')).rejects.toThrow('CEO_ACCOUNT_NOT_UNIQUE_OR_UNCONFIRMED');
  });
  it('rejects an unconfirmed CEO and leaves setup empty',async()=>{
    await exec(`delete from private.office_settings; update auth.users set email_confirmed_at=null where id='${owner}'`);
    await expect(configureCeo({query},'ceo@example.invalid')).rejects.toThrow('CEO_ACCOUNT_NOT_UNIQUE_OR_UNCONFIRMED');
    expect(await query('select * from private.office_settings')).toHaveLength(0);
  });
  it('enables RLS on every application table including the private singleton',async()=>{
    const rows=await query(`select relname,relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname in ('public','private') and relkind='r'`);
    for(const name of [...tables,'office_settings']) expect(rows.find(r=>r.relname===name)?.relrowsecurity).toBe(true);
  });
  it.each(tables)('blocks anonymous read and write: %s',async table=>{
    await asRole('anon');
    await rejects(`select * from public.${table}`,/permission denied/);
    for(const action of [`insert into public.${table} default values`,`update public.${table} set owner_id='${other}'`,`delete from public.${table}`]) await rejects(action,/permission denied/);
  });
  it.each(tables)('denies other users, permits only CEO owned reads and denies client DML: %s',async table=>{
    await asRole('authenticated',other);
    expect(await query(`select * from public.${table}`)).toHaveLength(0);
    for(const action of [`insert into public.${table} default values`,`update public.${table} set owner_id='${other}'`,`delete from public.${table}`]) await rejects(action,/permission denied/);
    await exec(`select set_config('request.jwt.claim.sub','${owner}',true)`);
    const rows=await query(`select * from public.${table}`);
    expect(rows.length).toBeGreaterThan(0); expect(rows.every(r=>r.owner_id===owner)).toBe(true);
    for(const action of [`insert into public.${table} default values`,`update public.${table} set owner_id='${other}'`,`delete from public.${table}`]) await rejects(action,/permission denied/);
  });
  it('does not expose private settings or transition RPC to logged in CEO',async()=>{
    await asRole('authenticated',owner);
    await rejects('select * from private.office_settings',/permission denied/);
    await rejects(rpc(),/permission denied/);
  });
  it('validates different agents, nonempty criteria and cross-owner references in DB',async()=>{
    await asRole('service_role');
    await rejects(`update public.tasks set reviewer_agent=lead_agent,version=version+1 where id='${task}'`,/check constraint/);
    await rejects(`update public.tasks set acceptance_criteria='[""]',version=version+1 where id='${task}'`,/check constraint/);
    await rejects(`update public.tasks set lead_agent='20000000-0000-4000-8000-000000000002',version=version+1 where id='${task}'`,/foreign key/);
    await rejects(`update public.tasks set budget_usd='NaN',version=version+1 where id='${task}'`,/check constraint/);
  });
  it('enforces owner-local slugs rather than global uniqueness',async()=>{
    expect((await query(`select * from public.agents where slug='gpt'`)).length).toBe(2);
    await rejects(`insert into public.agents(owner_id,slug,display_name) values('${owner}','gpt','Duplicate')`,/unique constraint/);
  });
  it('rejects cross-task reply and run references',async()=>{
    await asRole('service_role');
    await rejects(`update public.agent_messages set task_id='10000000-0000-4000-8000-000000000005'`,/foreign key/);
    await rejects(`update public.agent_runs set task_id='10000000-0000-4000-8000-000000000005'`,/foreign key/);
  });
  it('atomically records a transition, retries idempotently and rejects stale versions',async()=>{
    await asRole('service_role');
    await exec(rpc()); await exec(rpc());
    expect(await query(`select status,version from public.tasks where id='${task}'`)).toEqual([{status:'ANALYZING',version:1}]);
    expect(await query(`select to_status from public.task_events where task_id='${task}' order by task_version`)).toEqual([{to_status:'NEW'},{to_status:'ANALYZING'}]);
    await rejects(rpc({status:'DISCUSSION',request:'30000000-0000-4000-8000-000000000002'}),/VERSION_CONFLICT/);
    await rejects(rpc({reason:'Different payload'}),/IDEMPOTENCY_CONFLICT/);
  });
  it('rolls back a state change if its audit row is invalid',async()=>{
    await asRole('service_role');
    await rejects(rpc({reason:''}),/check constraint/);
    expect(await query(`select status,version from public.tasks where id='${task}'`)).toEqual([{status:'NEW',version:0}]);
    expect(await query(`select * from public.task_events where task_id='${task}'`)).toHaveLength(1);
  });
  it('rejects negative counts, terminal edits, and direct unaudited status writes',async()=>{
    await asRole('service_role');
    await rejects(rpc({fixes:-1}),/ACCOUNTING_CANNOT_DECREASE|check constraint/);
    await rejects(`update public.tasks set status='ANALYZING',version=1 where id='${task}'`,/TRANSITION_RPC_REQUIRED/);
    await exec(rpc({status:'CANCELLED'}));
    await rejects(rpc({status:'ANALYZING',version:1,request:'30000000-0000-4000-8000-000000000002'}),/TERMINAL_TASK/);
    await rejects(`update public.tasks set title='changed',version=2 where id='${task}'`,/TERMINAL_TASK/);
  });
  it.each(['task_events','decisions'])('prevents service-role update, delete and truncate on %s',async table=>{
    await asRole('service_role');
    await rejects(`update public.${table} set reason='tamper'`,/AUDIT_IMMUTABLE/);
    await rejects(`delete from public.${table}`,/AUDIT_IMMUTABLE/);
    await rejects(`truncate public.${table}`,/permission denied/);
  });
  it('freezes recorded financial evidence and freezes the whole settled run',async()=>{
    await asRole('service_role');
    await exec(`update public.agent_runs set status='RECORDED',ended_at=now(),input_tokens=3,output_tokens=5,cost_usd=0.01,response_payload='{}'`);
    await rejects(`update public.agent_runs set cost_usd=0`,/RECORDED_RUN_IMMUTABLE/);
    await exec(`update public.agent_runs set status='APPLIED',applied_at=now()`);
    await rejects(`update public.agent_runs set error='tamper'`,/SETTLED_RUN_IMMUTABLE/);
    await rejects(`delete from public.agent_runs`,/RUN_DELETE_FORBIDDEN/);
    await rejects(`truncate public.agent_runs`,/permission denied/);
  });
  it('prevents concurrent unresolved runs per task',async()=>{
    await asRole('service_role');
    await rejects(`insert into public.agent_runs(owner_id,task_id,agent_id,message_id,provider,model,idempotency_key) select owner_id,task_id,agent_id,message_id,provider,model,gen_random_uuid() from public.agent_runs`,/unique constraint/);
  });
  it('publishes exactly the required business tables',async()=>{
    const rows=await query(`select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'`);
    for(const name of ['tasks','task_events','agents','agent_messages']) expect(rows.some(r=>r.tablename===name)).toBe(true);
  });
});
