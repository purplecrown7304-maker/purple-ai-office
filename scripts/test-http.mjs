// CI smoke against an isolated local Supabase stack and the real Next production server.
// No browser/API/DB mock, no hosted project keys. The entire stack is destroyed by CI.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { testBrowser } from '../e2e/office.mjs';
import { readFile, readdir } from 'node:fs/promises';

assert.equal(process.env.OFFICE_TEST_DISPOSABLE,'1','Explicit disposable stack flag required');
const status=spawnSync('pnpm',['exec','supabase','status','-o','json'],{encoding:'utf8',windowsHide:true});
assert.equal(status.status,0,'Local Supabase status failed');
const config=JSON.parse(status.stdout);
const api=config.API_URL,dbUrl=config.DB_URL;
for(const url of [api,dbUrl]) assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname),'Loopback only');
const origin='http://127.0.0.1:3100';
const auth=createClient(api,config.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const sql=postgres(dbUrl,{max:1});
let server;
try {
  assert.equal((await sql`select * from private.office_settings`).length,0,'Requires an empty disposable DB');
  assert.equal((await sql`select * from public.projects`).length,0,'Requires an empty disposable DB');
  const password=`Aa9!${randomUUID()}`,email=`http-ceo-${randomUUID()}@example.invalid`;
  const otherEmail=`http-other-${randomUUID()}@example.invalid`;
  const {data,error}=await auth.auth.admin.createUser({email,password,email_confirm:true});
  assert.equal(error,null,'Create isolated CEO user');
  const other=await auth.auth.admin.createUser({email:otherEmail,password,email_confirm:true});
  assert.equal(other.error,null,'Create isolated non-CEO user');
  const publicAuth=createClient(api,config.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const signup=await publicAuth.auth.signUp({email:`blocked-${randomUUID()}@example.invalid`,password});
  assert.equal(signup.error?.code,'signup_disabled','Self-service signup must remain disabled');
  await sql`insert into private.office_settings(ceo_user_id) values(${data.user.id})`;
  const env={...process.env,DATABASE_URL:dbUrl,APP_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:api,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:config.ANON_KEY,NEXT_TELEMETRY_DISABLED:'1'};
  const build=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build'],{env,stdio:'inherit',windowsHide:true});
  assert.equal(build.status,0,'Production build');
  for(const file of await readdir('.next/static',{recursive:true})) if(file.endsWith('.js')) {
    const source=await readFile(`.next/static/${file}`,'utf8');
    assert.ok(!source.includes(dbUrl)&&!source.includes(config.SERVICE_ROLE_KEY),'Server credentials must not enter browser bundles');
  }
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3100'],{env,stdio:'ignore',windowsHide:true});
  let ready=false;
  for(let i=0;i<60;i++) {
    try {if((await fetch(`${origin}/api/session`)).status===401) {ready=true;break;}} catch {}
    await delay(500);
  }
  assert.ok(ready,'Production API ready');
  const jar=new Map();
  const request=async(path,method='GET',body,expected=200,extra={})=>{
    const response=await fetch(`${origin}/api/${path}`,{method,headers:{origin,'content-type':'application/json',
      'idempotency-key':randomUUID(),cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...extra},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    for(const entry of response.headers.getSetCookie()) {
      const pair=entry.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));
    }
    const result=await response.json();
    assert.equal(response.status,expected,`${method} ${path}: ${result.error??'unexpected status'}`);
    assert.match(response.headers.get('cache-control'),/no-store/);
    return result;
  };
  await request('tasks','GET',undefined,401);
  await request('login','POST',{email:otherEmail,password},403);
  await request('tasks','GET',undefined,401);
  await request('login','POST',{email,password});
  assert.ok(jar.size>0,'Real Supabase session cookies received');
  await request('session');
  await request('projects','POST',{name:'Blocked'},403,{origin:'https://evil.invalid'});
  const project=await request('projects','POST',{name:'HTTP demo'},201);
  const lead=await request('agents','POST',{slug:'claude',displayName:'Claude'},201);
  const reviewer=await request('agents','POST',{slug:'gpt',displayName:'GPT'},201);
  const input={projectId:project.id,title:'HTTP demo',leadAgent:lead.id,reviewerAgent:reviewer.id,acceptanceCriteria:['Complete'],isDemo:true,delayMs:0};
  await request('tasks','POST',{...input,owner_id:other.data.user.id},400);
  const task=await request('tasks','POST',input,201);
  await request(`tasks/${task.id}/decision`,'POST',{action:'approve',reason:'Too early'},409);
  let detail;
  for(let i=0;i<11;i++) detail=await request(`tasks/${task.id}/step`,'POST',{});
  assert.equal(detail.task.status,'WAITING_USER');assert.equal(detail.task.pause_reason,'FINAL_APPROVAL');
  await request(`tasks/${task.id}/decision`,'POST',{action:'approve',reason:'Verified'});
  const [stored]=await sql`select status,cost_usd from public.tasks where id=${task.id}`;
  assert.equal(stored.status,'DONE');assert.equal(Number(stored.cost_usd),0.55);
  assert.equal((await sql`select * from public.agent_runs where task_id=${task.id} and status='APPLIED'`).length,11);
  await request('logout','POST',{});await request('tasks','GET',undefined,401);
  console.log('PASS: signup disabled, real Auth cookies, non-CEO/CSRF/forged-owner rejection, 11-step HTTP workflow, DB evidence, CEO approval and logout');
  await testBrowser({origin,email,password,sql});
} finally {
  if(server) {server.kill('SIGTERM');await new Promise(resolve=>{server.once('exit',resolve);setTimeout(resolve,5000).unref();});}
  await sql.end();
}
