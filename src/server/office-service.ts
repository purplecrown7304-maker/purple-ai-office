import 'server-only';
import { randomUUID } from 'node:crypto';
import { ACTIVE, enforceLimits, transition, unknownOutcome } from '../domain/task-policy';
import { usdToMicros } from '../domain/money';
import type { Actor } from '../domain/types';
import { MockProvider } from '../providers/mock';
import { providerResult, type AgentMessage, type AgentProvider, type ProviderResult, type TaskContext } from '../providers/types';
import type { Database, Query, Row } from './db';
import { agentInput, decisionInput, projectInput, requireThat, taskInput, uuid } from './validation';
import { assertOwner, decision, loadEvidence, receipt, saveState, setCost, stateOf, taskForUpdate, type RunRow, type TaskRow } from './repository';

const system:Actor={role:'system',id:'office-server'};
const terminal=(t:TaskRow)=>t.status==='DONE'||t.status==='CANCELLED';
const runnable=(t:TaskRow)=>(ACTIVE as readonly string[]).includes(t.status);
interface Snapshot { task:TaskContext; message:AgentMessage }

export class OfficeService {
  constructor(private db:Database,private provider:AgentProvider=new MockProvider()) {}
  async authorize(owner:string) { await this.scoped(owner,async()=>undefined); }
  private async scoped<T>(owner:string,fn:(tx:Query)=>Promise<T>):Promise<T> {
    uuid.parse(owner);
    return this.db.transaction(async tx=>{ await assertOwner(tx,owner); return fn(tx); });
  }
  private async command<T>(owner:string,requestId:string,command:unknown,fn:(tx:Query)=>Promise<T>):Promise<T> {
    uuid.parse(requestId);
    return this.scoped(owner,async tx=>(await receipt(tx,owner,requestId,command,()=>fn(tx))).value);
  }
  async createProject(owner:string,key:string,input:unknown) {
    const v=projectInput.parse(input);
    return this.command(owner,key,{op:'project',v},async tx=>{
      const [r]=await tx.query('insert into public.projects(owner_id,name,repository_url,default_budget_usd) values($1,$2,$3,$4) returning *',[owner,v.name,v.repositoryUrl??null,v.budgetUsd]); return r;
    });
  }
  async createAgent(owner:string,key:string,input:unknown) {
    const v=agentInput.parse(input);
    return this.command(owner,key,{op:'agent',v},async tx=>{
      const [r]=await tx.query("insert into public.agents(owner_id,slug,display_name,provider,model) values($1,$2,$3,'mock','mock-v1') returning *",[owner,v.slug,v.displayName]); return r;
    });
  }
  async createTask(owner:string,key:string,input:unknown) {
    const v=taskInput.parse(input);
    return this.command(owner,key,{op:'task',v},async tx=>{
      requireThat((await tx.query("select 1 from public.projects where owner_id=$1 and id=$2 and status='ACTIVE'",[owner,v.projectId])).length,'PROJECT_NOT_FOUND',404);
      const agents=await tx.query("select id from public.agents where owner_id=$1 and id in ($2,$3) and provider='mock'",[owner,v.leadAgent,v.reviewerAgent]);
      requireThat(agents.length===2,'MOCK_AGENTS_REQUIRED');
      const [t]=await tx.query<TaskRow>(`insert into public.tasks(owner_id,code,project_id,title,description,lead_agent,reviewer_agent,acceptance_criteria,priority,budget_usd,is_demo,demo_delay_ms,demo_next_step_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) returning *`,[owner,`TASK-${randomUUID()}`,v.projectId,v.title,v.description,v.leadAgent,v.reviewerAgent,JSON.stringify(v.acceptanceCriteria),v.priority,v.budgetUsd,v.isDemo,v.delayMs]);
      await tx.query(`insert into public.agent_messages(owner_id,task_id,from_role,to_role,to_agent,type,message,requires_response,queue_status,request_id)
        values($1,$2,'ceo','agent',$3,'HANDOFF',$4,true,'pending',$5)`,[owner,t.id,t.lead_agent,v.title,randomUUID()]);
      return t;
    });
  }
  async list(owner:string,resource:'projects'|'agents'|'tasks') {
    // Static allow-list: callers never supply SQL identifiers.
    const statements={projects:'select * from public.projects where owner_id=$1 order by created_at desc',agents:'select * from public.agents where owner_id=$1 order by slug',tasks:'select * from public.tasks where owner_id=$1 order by updated_at desc limit 200'};
    return this.scoped(owner,tx=>tx.query(statements[resource],[owner]));
  }
  async detail(owner:string,id:string) {
    uuid.parse(id);
    return this.scoped(owner,async tx=>{
      const task=await taskForUpdate(tx,owner,id);
      const messages=await tx.query('select * from public.agent_messages where owner_id=$1 and task_id=$2 order by created_at,id',[owner,id]);
      const events=await tx.query('select * from public.task_events where owner_id=$1 and task_id=$2 order by task_version',[owner,id]);
      const runs=await tx.query('select * from public.agent_runs where owner_id=$1 and task_id=$2 order by started_at,id',[owner,id]);
      const tests=await tx.query('select * from public.test_results where owner_id=$1 and task_id=$2 order by created_at,id',[owner,id]);
      const artifacts=await tx.query('select * from public.artifacts where owner_id=$1 and task_id=$2 order by created_at,id',[owner,id]);
      return {task,messages,events,runs,tests,artifacts};
    });
  }
  async projectDetail(owner:string,id:string) {
    uuid.parse(id);
    return this.scoped(owner,async tx=>{
      const [project]=await tx.query('select * from public.projects where owner_id=$1 and id=$2',[owner,id]);
      requireThat(project,'PROJECT_NOT_FOUND',404);
      const tasks=await tx.query('select * from public.tasks where owner_id=$1 and project_id=$2 order by updated_at desc',[owner,id]);
      const decisions=await tx.query('select * from public.decisions where owner_id=$1 and project_id=$2 order by created_at desc',[owner,id]);
      return {project,tasks,decisions};
    });
  }
  async agentDetail(owner:string,slug:string) {
    return this.scoped(owner,async tx=>{
      const [agent]=await tx.query('select * from public.agents where owner_id=$1 and slug=$2',[owner,slug]);
      requireThat(agent,'AGENT_NOT_FOUND',404);
      const messages=await tx.query('select * from public.agent_messages where owner_id=$1 and (from_agent=$2 or to_agent=$2) order by created_at desc limit 100',[owner,agent.id]);
      const runs=await tx.query('select * from public.agent_runs where owner_id=$1 and agent_id=$2 order by started_at desc limit 100',[owner,agent.id]);
      return {agent,messages,runs};
    });
  }
  async decide(owner:string,id:string,key:string,input:unknown) {
    uuid.parse(id); const v=decisionInput.parse(input);
    return this.command(owner,key,{op:'decision',id,v},async tx=>{
      let t=await taskForUpdate(tx,owner,id);
      requireThat(!terminal(t),'TERMINAL_TASK');
      const ceo:Actor={role:'ceo',id:owner};
      const decisionId=await decision(tx,t,`${v.action}: ${v.reason}`,'ceo');
      if(v.action==='pause'||v.action==='unpause') {
        const [updated]=await tx.query<TaskRow>('update public.tasks set demo_paused=$3,version=version+1 where owner_id=$1 and id=$2 returning *',[owner,id,v.action==='pause']);
        return updated;
      }
      if(v.action==='budget') {
        requireThat(v.budgetUsd!==undefined,'BUDGET_REQUIRED',400);
        const [updated]=await tx.query<TaskRow>('update public.tasks set budget_usd=$3,version=version+1 where owner_id=$1 and id=$2 returning *',[owner,id,v.budgetUsd]); t=updated;
        const s=await stateOf(tx,t), guarded=enforceLimits(s);
        if(guarded.status!==s.status||guarded.pauseReason!==s.pauseReason) t=await saveState(tx,t,guarded,ceo,'Budget changed');
        return t;
      }
      const evidence=await loadEvidence(tx,t);
      evidence.ceoDecisionId=decisionId;
      const target=v.action==='approve'?'DONE':v.action==='cancel'?'CANCELLED':v.action==='revise'?'FIXING':t.resume_status;
      requireThat(target,'INVALID_RESUME');
      // The domain rejects UNKNOWN_OUTCOME resumes regardless of the CEO decision.
      t=await saveState(tx,t,transition(await stateOf(tx,t),target,ceo,evidence),ceo,v.reason);
      if(t.status==='CANCELLED') {
        await tx.query("update public.agent_messages set queue_status='failed' where owner_id=$1 and task_id=$2 and queue_status in ('pending','processing')",[owner,id]);
        await this.releaseAgents(tx,t);
      } else if(v.action==='revise') {
        await tx.query(`insert into public.agent_messages(owner_id,task_id,from_role,to_role,to_agent,type,message,requires_response,queue_status,request_id)
          values($1,$2,'ceo','agent',$3,'CHALLENGE',$4,true,'pending',$5)`,[owner,id,t.lead_agent,v.reason,randomUUID()]);
      }
      return t;
    });
  }
  private async releaseAgents(tx:Query,t:TaskRow) {
    await tx.query("update public.agents set status='IDLE',current_task_id=null,last_active_at=now() where owner_id=$1 and current_task_id=$2",[t.owner_id,t.id]);
  }
  private async markUnknown(tx:Query,t:TaskRow,run:RunRow,reason:string) {
    // Both changes commit or roll back together. Cancelled/DONE tasks stay terminal.
    const next=unknownOutcome(await stateOf(tx,t));
    if(!terminal(t)) {
      if(t.status===next.status) await decision(tx,t,'Execution outcome unknown; cancel only','system');
      t=await saveState(tx,t,next,system,'Execution outcome unknown; cancel only');
    }
    await tx.query("update public.agent_runs set status='UNKNOWN_OUTCOME',ended_at=now(),error=$3 where task_id=$1 and id=$2 and status='STARTED'",[t.id,run.id,reason]);
    await tx.query("update public.agent_messages set queue_status='failed' where task_id=$1 and id=$2",[t.id,run.message_id]);
    await this.releaseAgents(tx,t);
    return t;
  }
  async step(owner:string,id:string,key:string) {
    uuid.parse(id); uuid.parse(key);
    const claim=await this.scoped(owner,tx=>receipt(tx,owner,key,{op:'step',id},async()=>{
      let t=await taskForUpdate(tx,owner,id);
      // Recover a recorded result before looking for more work; never call twice.
      const [pending]=await tx.query<RunRow>("select * from public.agent_runs where task_id=$1 and status in ('STARTED','RECORDED','UNKNOWN_OUTCOME')",[id]);
      if(pending) return {runId:pending.id,fresh:false};
      requireThat(!terminal(t)&&runnable(t)&&!t.demo_paused,'TASK_NOT_RUNNABLE');
      const s=await stateOf(tx,t),limited=enforceLimits(s);
      if(limited.status!==s.status) { t=await saveState(tx,t,limited,system,'Execution limit reached'); return {runId:null,fresh:false}; }
      const [due]=await tx.query<{ready:boolean}>('select demo_next_step_at is null or demo_next_step_at<=now() ready from public.tasks where id=$1',[id]);
      requireThat(due.ready,'STEP_NOT_DUE',429);
      const [message]=await tx.query<AgentMessage & {payload:Row}>("select * from public.agent_messages where owner_id=$1 and task_id=$2 and requires_response and queue_status='pending' and available_at<=now() order by created_at,id limit 1 for update",[owner,id]);
      requireThat(message?.to_agent,'NO_PENDING_MESSAGE');
      const [agent]=await tx.query<{id:string;provider:string;model:string}>('select * from public.agents where owner_id=$1 and id=$2 for update',[owner,message.to_agent]);
      requireThat(agent?.provider==='mock','PROVIDER_NOT_SUPPORTED');
      requireThat(!(await tx.query("select 1 from public.agent_runs where agent_id=$1 and status='STARTED'",[agent.id])).length,'AGENT_BUSY');
      const recentMessages=await tx.query<AgentMessage>('select * from public.agent_messages where owner_id=$1 and task_id=$2 order by created_at desc,id desc limit 20',[owner,id]);
      const snapshot:Snapshot={task:{...s,id,title:t.title,description:t.description,step:t.demo_step,actorId:agent.id,recentMessages},message};
      const [run]=await tx.query<RunRow>(`insert into public.agent_runs(owner_id,task_id,agent_id,message_id,provider,model,idempotency_key,lease_expires_at,input_payload)
        values($1,$2,$3,$4,'mock',$5,$6,now()+interval '30 seconds',$7) returning *`,[owner,id,agent.id,message.id,agent.model,key,JSON.stringify(snapshot)]);
      await tx.query("update public.agent_messages set queue_status='processing',attempts=attempts+1,claimed_at=now(),lease_expires_at=now()+interval '30 seconds',run_id=$3 where task_id=$1 and id=$2",[id,message.id,run.id]);
      await tx.query("update public.agents set status=$3,current_task_id=$2,last_active_at=now() where owner_id=$1 and id=$4",[owner,id,t.status==='CROSS_REVIEW'?'REVIEWING':'WORKING',agent.id]);
      return {runId:run.id,fresh:true};
    }));
    if(!claim.value.runId) return this.detail(owner,id);
    const runId=claim.value.runId;
    const run=await this.scoped(owner,async tx=>{
      const t=await taskForUpdate(tx,owner,id);
      const [r]=await tx.query<RunRow>('select * from public.agent_runs where owner_id=$1 and task_id=$2 and id=$3',[owner,id,runId]);
      requireThat(r,'RUN_NOT_FOUND',404);
      const [clock]=await tx.query<{expired:boolean}>('select lease_expires_at<=now() expired from public.agent_runs where id=$1',[r.id]);
      if(r.status==='STARTED' && clock.expired) { await this.markUnknown(tx,t,r,'LEASE_EXPIRED'); r.status='UNKNOWN_OUTCOME'; }
      return r;
    });
    if(run.status==='STARTED' && !claim.replayed && claim.value.fresh) {
      let response:ProviderResult;
      try {
        const snapshot=run.input_payload as Snapshot;
        const controller=new AbortController();
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {
          const raw=await Promise.race([this.provider.respond({...snapshot,signal:controller.signal}),new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>{controller.abort();reject(new Error('PROVIDER_TIMEOUT'));},10000);
          })]);
          response=providerResult.parse(raw);
          usdToMicros(String(response.usage.costUsd));
        } finally { clearTimeout(timer); }
      } catch {
        await this.scoped(owner,async tx=>{ const t=await taskForUpdate(tx,owner,id);
          const [r]=await tx.query<RunRow>('select * from public.agent_runs where id=$1',[runId]);
          if(r.status==='STARTED') await this.markUnknown(tx,t,r,'PROVIDER_OUTCOME_UNCERTAIN');
        });
        return this.detail(owner,id);
      }
      // This transaction is separate from apply. A failure keeps STARTED blocking
      // new calls until lease recovery marks the unknown outcome; it never retries the provider.
      await this.scoped(owner,async tx=>{
        let t=await taskForUpdate(tx,owner,id);
        const [r]=await tx.query<RunRow>('select * from public.agent_runs where id=$1',[runId]);
        if(r.status!=='STARTED') return;
        await tx.query(`update public.agent_runs set status='RECORDED',ended_at=now(),input_tokens=$2,output_tokens=$3,cost_usd=$4,response_payload=$5 where id=$1`,
          [runId,response.usage.inputTokens,response.usage.outputTokens,String(response.usage.costUsd),JSON.stringify(response)]);
        const [ledger]=await tx.query<{cost:string}>("select coalesce(sum(cost_usd),0)::text cost from public.agent_runs where task_id=$1 and status in ('RECORDED','APPLIED')",[id]);
        t=await setCost(tx,t,usdToMicros(ledger.cost));
        if(!terminal(t)) {
          const s=await stateOf(tx,t),limited=enforceLimits(s);
          if(limited.status!==s.status || limited.pauseReason!==s.pauseReason) await saveState(tx,t,limited,system,'Recorded usage exceeded limit');
        }
      });
    }
    await this.apply(owner,id,runId);
    return this.detail(owner,id);
  }
  private async apply(owner:string,id:string,runId:string) {
    return this.scoped(owner,async tx=>{
      let t=await taskForUpdate(tx,owner,id);
      const [run]=await tx.query<RunRow>('select * from public.agent_runs where owner_id=$1 and task_id=$2 and id=$3',[owner,id,runId]);
      if(run.status!=='RECORDED') return;
      const finish=async()=>{
        await tx.query("update public.agent_runs set status='APPLIED',applied_at=now() where id=$1",[runId]);
        await tx.query("update public.agent_messages set queue_status='done',processed_at=now() where task_id=$1 and id=$2",[id,run.message_id]);
        await this.releaseAgents(tx,t);
      };
      if(terminal(t)) { await finish(); return; }
      if(t.demo_paused || !runnable(t)) { await this.releaseAgents(tx,t); return; }
      const result=providerResult.parse(run.response_payload);
      const snapshot=run.input_payload as Snapshot;
      // Any intervening workflow change invalidates old progression. Pause for a
      // CEO decision rather than applying evidence to a different review round.
      requireThat(t.status===snapshot.task.status&&t.review_round===snapshot.task.reviewRound,'STALE_RUN_CONTEXT');
      let state=await stateOf(tx,t);
      const proposed={...state,messageCount:state.messageCount+result.replies.length,
        discussionRounds:state.discussionRounds+(result.replies.some(r=>r.type==='ANSWER')&&t.status==='DISCUSSION'?1:0)};
      const limited=enforceLimits(proposed);
      if(limited.status!==state.status) {
        // Persist actual counters only. An unapplied reply is not a discussion round.
        t=await saveState(tx,t,{...limited,discussionRounds:state.discussionRounds},system,'Response would exceed execution limit');
        await this.releaseAgents(tx,t); return;
      }
      state=proposed;
      const actor:Actor={role:'agent',id:run.agent_id};
      let evidence=await loadEvidence(tx,t);
      if(result.evidence?.plan) {
        requireThat(run.agent_id===t.lead_agent,'LEAD_REQUIRED');
        evidence.planDecisionId=await decision(tx,t,result.evidence.plan,run.agent_id);
      }
      if(result.evidence?.artifact) {
        requireThat(run.agent_id===t.lead_agent && ['IMPLEMENTING','FIXING'].includes(t.status),'INVALID_ARTIFACT_ACTOR');
        const [artifact]=await tx.query<{id:string}>(`insert into public.artifacts(owner_id,task_id,agent_id,type,path,metadata)
          values($1,$2,$3,'mock:implementation',$4,$5) returning id`,[owner,id,run.agent_id,`mock://${runId}`,JSON.stringify({round:t.review_round+1,content:result.evidence.artifact,runId})]);
        evidence.artifactId=artifact.id;
      }
      if(result.evidence?.review) {
        requireThat(run.agent_id===t.reviewer_agent&&t.status==='CROSS_REVIEW'&&evidence.artifactId,'REVIEW_EVIDENCE_INVALID');
        evidence.review={agentId:run.agent_id,round:t.review_round,verdict:result.evidence.review,artifactId:evidence.artifactId,
          acceptanceResults:t.acceptance_criteria.map(criterion=>({criterion,passed:result.evidence!.review==='PASS'})),criticalBugCount:result.evidence.review==='PASS'?0:1};
      }
      if(result.evidence?.tests) {
        requireThat(run.agent_id===t.reviewer_agent&&t.status==='TESTING','TEST_ACTOR_REQUIRED');
        for(const type of ['unit','regression']) await tx.query(`insert into public.test_results(owner_id,task_id,agent_id,test_type,result,output)
          values($1,$2,$3,$4,$5,$6)`,[owner,id,run.agent_id,`mock:${type}:${t.review_round}`,result.evidence.tests,`Simulated by MockProvider; run ${runId}`]);
        evidence={...evidence,...await loadEvidence(tx,t)};
      }
      const next=result.statusChange?transition(state,result.statusChange,actor,evidence):state;
      requireThat(result.replies.every(r=>!r.requiresResponse||r.recipient!=='ceo'),'INVALID_RESPONSE_RECIPIENT');
      for(const reply of result.replies) {
        const recipient=reply.recipient==='lead'?t.lead_agent:reply.recipient==='reviewer'?t.reviewer_agent:null;
        const canRespond=reply.requiresResponse&&(ACTIVE as readonly string[]).includes(next.status);
        await tx.query(`insert into public.agent_messages(owner_id,task_id,from_role,from_agent,to_role,to_agent,type,message,requires_response,queue_status,processed_at,in_reply_to,run_id,payload,review_round,available_at,request_id)
          values($1,$2,'agent',$3,$4,$5,$6,$7,$8,$9,case when $8 then null else now() end,$10,$11,$12,$13,now()+($14 * interval '1 millisecond'),$15)`,
          [owner,id,run.agent_id,recipient?'agent':'ceo',recipient,reply.type,reply.message,canRespond,canRespond?'pending':'done',run.message_id,runId,
            JSON.stringify(reply.type==='REVIEW_RESULT'?evidence.review??{}:{}),next.reviewRound||null,t.demo_delay_ms,randomUUID()]);
      }
      t=await saveState(tx,t,next,actor,'Mock response applied');
      await tx.query("update public.tasks set demo_step=demo_step+1,demo_next_step_at=now()+(demo_delay_ms * interval '1 millisecond'),version=version+1 where owner_id=$1 and id=$2",[owner,id]);
      await finish();
    });
  }
}
