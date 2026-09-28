import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { OfficeService } from '../../src/server/office-service';
import type { Database, Query } from '../../src/server/db';
import { MockProvider } from '../../src/providers/mock';
import type { AgentProvider } from '../../src/providers/types';
import { handleOfficeRequest } from '../../src/server/http';
import type { OfficeAuth } from '../../src/server/auth';

const owner='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
let database:Database,admin:Query,close:()=>Promise<void>,exec:(s:string)=>Promise<unknown>;
let office:OfficeService,projectId:string,lead:string,reviewer:string;
let ownsFixture=false;
const appTables='public.agent_messages,public.agent_runs,public.task_events,public.test_results,public.artifacts,public.decisions,public.tasks,public.agents,public.projects,private.command_receipts,private.office_settings';

beforeAll(async()=>{
  const url=process.env.OFFICE_TEST_DATABASE_URL;
  if(url) {
    // This suite commits independent service transactions and needs a disposable
    // empty CI DB. Never silently reset a developer's existing application data.
    if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)||process.env.OFFICE_TEST_DISPOSABLE!=='1') throw new Error('DISPOSABLE_LOOPBACK_DB_REQUIRED');
    const sql=postgres(url,{max:4,onnotice:()=>{}});
    admin={query:async<T extends object>(s:string,p:unknown[]=[])=>Array.from(await sql.unsafe(s,p as never[])) as T[]};
    exec=s=>sql.unsafe(s);close=()=>sql.end();
    database={transaction:async fn=>await sql.begin(async tx=>{
      await tx.unsafe('set local role service_role');
      return fn({query:async<T extends object>(s:string,p:unknown[]=[])=>Array.from(await tx.unsafe(s,p as never[])) as T[]});
    }) as Awaited<ReturnType<typeof fn>>};
  } else {
    const db=new PGlite();
    exec=s=>db.exec(s);admin={query:async<T extends object>(s:string,p:unknown[]=[]) =>(await db.query<T>(s,p)).rows};close=()=>db.close();
    await exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;
      create publication supabase_realtime;`);
    for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) await exec(await readFile(`supabase/migrations/${file}`,'utf8'));
    database={transaction:fn=>db.transaction(async tx=>{await tx.exec('set local role service_role');return fn({query:async<T extends object>(s:string,p:unknown[]=[]) =>(await tx.query<T>(s,p)).rows});})};
  }
  expect(await admin.query('select * from private.office_settings')).toHaveLength(0);
  expect(await admin.query('select * from public.projects')).toHaveLength(0);
  await admin.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now())',[owner,'server-ceo@example.invalid',other,'server-other@example.invalid']);
  ownsFixture=true;
});
beforeEach(async()=>{
  await exec(`truncate ${appTables} cascade`);
  await admin.query('insert into private.office_settings(ceo_user_id) values($1)',[owner]);
  office=new OfficeService(database);
  projectId=String((await office.createProject(owner,randomUUID(),{name:'Demo'})).id);
  lead=String((await office.createAgent(owner,randomUUID(),{slug:'claude',displayName:'Claude'})).id);
  reviewer=String((await office.createAgent(owner,randomUUID(),{slug:'gpt',displayName:'GPT'})).id);
});
afterAll(async()=>{
  if(ownsFixture) { await exec(`truncate ${appTables} cascade`); await admin.query('delete from auth.users where id in ($1,$2)',[owner,other]); }
  await close?.();
});
const input=()=>({projectId,title:'Mock demo',leadAgent:lead,reviewerAgent:reviewer,acceptanceCriteria:['Works','Handles limits'],isDemo:true,delayMs:0});
async function task(budgetUsd='5.00') { return office.createTask(owner,randomUUID(),{...input(),budgetUsd}); }
function gated() {
  let release!:()=>void,entered!:()=>void,calls=0;
  const wait=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const provider:AgentProvider={id:'mock',async respond(v){calls++;entered();await wait;return new MockProvider().respond(v);}};
  return {provider,release,started,calls:()=>calls};
}
function failQueryOnce(match:string) {
  let armed=true;
  const db:Database={transaction:fn=>database.transaction(tx=>fn({query:async<T extends object>(s:string,p?:unknown[])=>{
    if(armed&&s.includes(match)) {armed=false;throw new Error('INJECTED_STORAGE_FAILURE');}return tx.query<T>(s,p);
  }}))};
  return db;
}
describe('server / PostgreSQL integration',()=>{
  it('persists the complete Mock flow, round-bound evidence, costs and CEO approval',async()=>{
    const t=await task(),seen:string[]=[];
    for(let i=0;i<11;i++) {const d=await office.step(owner,t.id,randomUUID());seen.push(d.task.status);}
    expect(seen).toEqual(['ANALYZING','DISCUSSION','DISCUSSION','DISCUSSION','PLANNED','IMPLEMENTING','CROSS_REVIEW','FIXING','CROSS_REVIEW','TESTING','WAITING_USER']);
    const before=await office.detail(owner,t.id);
    expect(before.task).toMatchObject({pause_reason:'FINAL_APPROVAL',review_round:2,review_retries:1,fix_attempts:1,discussion_rounds:1,demo_step:11});
    expect(Number(before.task.cost_usd)).toBe(0.55);
    expect(before.runs).toHaveLength(11);expect(before.runs.every(r=>r.status==='APPLIED')).toBe(true);
    expect(before.tests).toHaveLength(2);expect(before.artifacts).toHaveLength(2);
    const key=randomUUID();
    const done=await office.decide(owner,t.id,key,{action:'approve',reason:'Verified'});
    expect(done.status).toBe('DONE');expect(await office.decide(owner,t.id,key,{action:'approve',reason:'Verified'})).toEqual(done);
    expect((await office.detail(owner,t.id)).events.filter(e=>e.to_status==='DONE')).toHaveLength(1);
  });
  it('rejects foreign owners, swapped agents, fake evidence and conflicting idempotency keys',async()=>{
    await expect(office.list(other,'tasks')).rejects.toThrow('CEO_REQUIRED');
    const foreign=randomUUID();await admin.query('insert into public.projects(id,owner_id,name) values($1,$2,$3)',[foreign,other,'Foreign']);
    await expect(office.createTask(owner,randomUUID(),{...input(),projectId:foreign})).rejects.toThrow('PROJECT_NOT_FOUND');
    await expect(office.createTask(owner,randomUUID(),{...input(),reviewerAgent:lead})).rejects.toThrow();
    const key=randomUUID(),t=await office.createTask(owner,key,input());
    expect((await office.createTask(owner,key,input())).id).toBe(t.id);
    await expect(office.createTask(owner,key,{...input(),title:'Changed'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(office.decide(owner,t.id,randomUUID(),{action:'approve',reason:'fake',review:{verdict:'PASS'}})).rejects.toThrow();
  });
  it('calls the provider once for concurrent identical and distinct step requests',async()=>{
    const t=await task(),gate=gated(),service=new OfficeService(database,gate.provider),key=randomUUID();
    const first=service.step(owner,t.id,key);await gate.started;
    await service.step(owner,t.id,key);await service.step(owner,t.id,randomUUID());
    gate.release();await first;await service.step(owner,t.id,key);
    expect(gate.calls()).toBe(1);
    const d=await office.detail(owner,t.id);expect(d.runs).toHaveLength(1);expect(Number(d.task.cost_usd)).toBe(0.05);expect(d.messages).toHaveLength(2);
  });
  it('blocks the same agent being claimed by another task while a call is active',async()=>{
    const a=await task(),b=await task(),gate=gated(),service=new OfficeService(database,gate.provider);
    const first=service.step(owner,a.id,randomUUID());await gate.started;
    await expect(office.step(owner,b.id,randomUUID())).rejects.toThrow('AGENT_BUSY');
    gate.release();await first;
    expect((await office.step(owner,b.id,randomUUID())).task.status).toBe('ANALYZING');
  });
  it('records response and usage before application; retries RECORDED without calling again',async()=>{
    const t=await task();let calls=0;
    const provider:AgentProvider={id:'mock',async respond(v){calls++;return new MockProvider().respond(v);}};
    const service=new OfficeService(failQueryOnce('insert into public.agent_messages'),provider),key=randomUUID();
    await expect(service.step(owner,t.id,key)).rejects.toThrow('INJECTED_STORAGE_FAILURE');
    const recorded=await office.detail(owner,t.id);
    expect(recorded.task.status).toBe('NEW');expect(Number(recorded.task.cost_usd)).toBe(0.05);
    expect(recorded.runs[0].status).toBe('RECORDED');expect(recorded.messages).toHaveLength(1);
    await service.step(owner,t.id,key);expect(calls).toBe(1);
    const applied=await office.detail(owner,t.id);expect(applied.task.status).toBe('ANALYZING');expect(applied.runs[0].status).toBe('APPLIED');expect(Number(applied.task.cost_usd)).toBe(0.05);
  });
  it('atomically pairs UNKNOWN_OUTCOME run with WAITING_USER and allows only cancellation',async()=>{
    const t=await task(),provider:AgentProvider={id:'mock',async respond(){throw new Error('lost response');}};
    const service=new OfficeService(database,provider),key=randomUUID();
    const d=await service.step(owner,t.id,key);
    expect(d.task).toMatchObject({status:'WAITING_USER',pause_reason:'UNKNOWN_OUTCOME'});
    expect(d.runs[0]).toMatchObject({status:'UNKNOWN_OUTCOME',cost_usd:null});expect(d.messages[0].queue_status).toBe('failed');
    expect(d.events.some(e=>e.to_status==='WAITING_USER')).toBe(true);
    await expect(service.decide(owner,t.id,randomUUID(),{action:'resume',reason:'Try again'})).rejects.toThrow('UNKNOWN_OUTCOME_CANCEL_ONLY');
    expect((await service.step(owner,t.id,key)).runs).toHaveLength(1);
    expect((await service.decide(owner,t.id,randomUUID(),{action:'cancel',reason:'Stop'})).status).toBe('CANCELLED');
  });
  it('rolls back both unknown run and waiting task if either write fails; lease recovery never recalls provider',async()=>{
    const t=await task();let calls=0;
    const provider:AgentProvider={id:'mock',async respond(){calls++;throw new Error('lost');}};
    const service=new OfficeService(failQueryOnce("set status='UNKNOWN_OUTCOME'"),provider),key=randomUUID();
    await expect(service.step(owner,t.id,key)).rejects.toThrow('INJECTED_STORAGE_FAILURE');
    const unchanged=await office.detail(owner,t.id);expect(unchanged.task.status).toBe('NEW');expect(unchanged.runs[0].status).toBe('STARTED');
    await admin.query("update public.agent_runs set lease_expires_at=now()-interval '1 second' where task_id=$1",[t.id]);
    const recovered=await service.step(owner,t.id,key);
    expect(recovered.task).toMatchObject({status:'WAITING_USER',pause_reason:'UNKNOWN_OUTCOME'});expect(recovered.runs[0].status).toBe('UNKNOWN_OUTCOME');expect(calls).toBe(1);
  });
  it('does not apply replies or call again when result recording fails',async()=>{
    const t=await task();let calls=0;
    const service=new OfficeService(failQueryOnce("set status='RECORDED'"),{id:'mock',async respond(v){calls++;return new MockProvider().respond(v);}}),key=randomUUID();
    await expect(service.step(owner,t.id,key)).rejects.toThrow('INJECTED_STORAGE_FAILURE');
    let d=await office.detail(owner,t.id);expect(d.messages).toHaveLength(1);expect(d.runs[0].status).toBe('STARTED');expect(Number(d.task.cost_usd)).toBe(0);
    await admin.query("update public.agent_runs set lease_expires_at=now()-interval '1 second' where task_id=$1",[t.id]);
    d=await service.step(owner,t.id,key);expect(d.task.pause_reason).toBe('UNKNOWN_OUTCOME');expect(calls).toBe(1);
  });
  it('records over-budget usage, waits, then applies the saved result once after CEO budget/resume',async()=>{
    const t=await task('0.01'),key=randomUUID();
    const paused=await office.step(owner,t.id,key);expect(paused.task).toMatchObject({status:'WAITING_USER',pause_reason:'BUDGET'});
    expect(paused.runs[0].status).toBe('RECORDED');expect(paused.messages).toHaveLength(1);
    await office.decide(owner,t.id,randomUUID(),{action:'budget',reason:'Increase',budgetUsd:'1.00'});
    await office.decide(owner,t.id,randomUUID(),{action:'resume',reason:'Budget resolved'});
    const d=await office.step(owner,t.id,key);expect(d.task.status).toBe('ANALYZING');expect(Number(d.task.cost_usd)).toBe(0.05);expect(d.runs).toHaveLength(1);
  });
  it('preserves cancellation while recording late usage without applying a reply',async()=>{
    const t=await task(),gate=gated(),service=new OfficeService(database,gate.provider);
    const first=service.step(owner,t.id,randomUUID());await gate.started;
    await office.decide(owner,t.id,randomUUID(),{action:'cancel',reason:'Cancel during call'});
    gate.release();const d=await first;
    expect(d.task.status).toBe('CANCELLED');expect(Number(d.task.cost_usd)).toBe(0.05);expect(d.messages).toHaveLength(1);expect(d.runs[0].status).toBe('APPLIED');
  });
  it('preserves UNKNOWN_OUTCOME rather than a concurrent budget pause',async()=>{
    const t=await task();let reject!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(r=>{entered=r;});
    const service=new OfficeService(database,{id:'mock',async respond(){entered();await new Promise<never>((_,r)=>{reject=()=>r(new Error('uncertain'));});throw new Error('unreachable');}});
    const first=service.step(owner,t.id,randomUUID());await waiting;
    await admin.query("update public.tasks set cost_usd=0.1,version=version+1 where id=$1",[t.id]);
    await office.decide(owner,t.id,randomUUID(),{action:'budget',budgetUsd:'0.01',reason:'Lower'});
    reject();const d=await first;expect(d.task).toMatchObject({status:'WAITING_USER',pause_reason:'UNKNOWN_OUTCOME'});
  });
  it('pauses without dropping a RECORDED result and enforces the persisted next-step delay',async()=>{
    const t=await office.createTask(owner,randomUUID(),{...input(),delayMs:10000});
    await office.decide(owner,t.id,randomUUID(),{action:'pause',reason:'Pause'});
    await expect(office.step(owner,t.id,randomUUID())).rejects.toThrow('TASK_NOT_RUNNABLE');
    await office.decide(owner,t.id,randomUUID(),{action:'unpause',reason:'Continue'});
    await office.step(owner,t.id,randomUUID());
    await expect(office.step(owner,t.id,randomUUID())).rejects.toThrow('STEP_NOT_DUE');
  });
  it('enforces session, same-origin, payload allow-lists and owner checks at the HTTP boundary',async()=>{
    let id:string|null=null;
    const auth:OfficeAuth={async userId(){return id;},async login(){return owner;},async logout(){id=null;}};
    const req=(method:string,body:unknown={},origin='http://office.test')=>new Request('http://office.test/api/tasks',{method,headers:{origin,'content-type':'application/json','idempotency-key':randomUUID()},...(method==='POST'?{body:JSON.stringify(body)}:{})});
    const send=(r:Request,path=['tasks'])=>handleOfficeRequest(r,path,{office,auth,origin:'http://office.test'});
    expect((await send(req('GET'))).status).toBe(401);id=other;expect((await send(req('GET'))).status).toBe(403);id=owner;
    expect((await send(req('POST',input(),'http://evil.test'))).status).toBe(403);
    expect((await send(req('POST',{...input(),owner_id:other}))).status).toBe(400);
    expect((await send(req('POST',input()))).status).toBe(201);
    const response=await send(req('GET'));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
    const t=await task();expect((await send(req('GET'),['tasks',t.id])).status).toBe(200);
  });
});
