import 'server-only';
import { randomUUID } from 'node:crypto';
import { microsToUsd, usdToMicros } from '../domain/money';
import type { Actor, PauseReason, TaskState, TaskStatus, TransitionEvidence, ReviewEvidence } from '../domain/types';
import type { Query, Row } from './db';
import { requireThat } from './validation';

export interface TaskRow extends Row {
  id: string; owner_id: string; project_id: string; title: string; description: string;
  lead_agent: string; reviewer_agent: string; acceptance_criteria: string[]; status: TaskStatus;
  budget_usd: string; cost_usd: string; discussion_rounds: number; review_retries: number;
  fix_attempts: number; review_round: number; pause_reason: PauseReason|null; resume_status: TaskStatus|null;
  version: number; demo_step: number; demo_delay_ms: number; demo_next_step_at: string|null; demo_paused: boolean;
}
export interface RunRow extends Row {
  id: string; task_id: string; agent_id: string; message_id: string;
  status: 'STARTED'|'RECORDED'|'APPLIED'|'FAILED'|'UNKNOWN_OUTCOME';
  response_payload: unknown; input_payload: unknown; lease_expires_at: string;
}
export async function assertOwner(tx: Query, owner: string): Promise<void> {
  requireThat((await tx.query('select 1 from private.office_settings where ceo_user_id=$1',[owner])).length, 'CEO_REQUIRED',403);
}
export async function taskForUpdate(tx: Query, owner: string, id: string): Promise<TaskRow> {
  const [task] = await tx.query<TaskRow>('select * from public.tasks where owner_id=$1 and id=$2 for update',[owner,id]);
  requireThat(task,'TASK_NOT_FOUND',404); return task;
}
export async function stateOf(tx: Query, t: TaskRow): Promise<TaskState> {
  const [count] = await tx.query<{n:number}>("select count(*)::int n from public.agent_messages where task_id=$1 and from_role='agent'",[t.id]);
  return {status:t.status, leadAgent:t.lead_agent,reviewerAgent:t.reviewer_agent,acceptanceCriteria:t.acceptance_criteria,
    discussionRounds:t.discussion_rounds,reviewRetries:t.review_retries,fixAttempts:t.fix_attempts,reviewRound:t.review_round,
    messageCount:count.n,costMicros:usdToMicros(String(t.cost_usd)),budgetMicros:usdToMicros(String(t.budget_usd)),pauseReason:t.pause_reason,resumeStatus:t.resume_status};
}
export async function saveState(tx: Query, t: TaskRow, next: TaskState, actor: Actor, reason: string): Promise<TaskRow> {
  if(t.status!==next.status) {
    const [updated]=await tx.query<TaskRow>(`select * from public.apply_task_transition($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [t.owner_id,t.id,t.version,randomUUID(),next.status,actor.role,actor.role==='agent'?actor.id:null,reason,next.discussionRounds,next.reviewRetries,next.fixAttempts,next.reviewRound,next.pauseReason,next.resumeStatus]);
    return updated;
  }
  const [updated]=await tx.query<TaskRow>(`update public.tasks set version=version+1,discussion_rounds=$3,
    pause_reason=$4,resume_status=$5 where owner_id=$1 and id=$2 returning *`,
    [t.owner_id,t.id,next.discussionRounds,next.pauseReason,next.resumeStatus]);
  return updated;
}
export async function receipt<T>(tx:Query,owner:string,requestId:string,command:unknown,fn:()=>Promise<T>):Promise<{value:T;replayed:boolean}> {
  const body=JSON.stringify(command);
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${owner}:${requestId}`]);
  const [existing]=await tx.query<{result:T;matches:boolean}>('select result, command=$3::jsonb matches from private.command_receipts where owner_id=$1 and request_id=$2',[owner,requestId,body]);
  if(existing) { requireThat(existing.matches,'IDEMPOTENCY_CONFLICT'); return {value:existing.result,replayed:true}; }
  // Canonical JSON on the first response too: timestamps must match a replay.
  const value=JSON.parse(JSON.stringify(await fn())) as T;
  await tx.query('insert into private.command_receipts(owner_id,request_id,command,result) values($1,$2,$3,$4)',[owner,requestId,body,JSON.stringify(value)]);
  return {value,replayed:false};
}
export async function loadEvidence(tx:Query,t:TaskRow):Promise<TransitionEvidence> {
  const evidence:TransitionEvidence={};
  const [artifact]=await tx.query<{id:string}>(`select id from public.artifacts where owner_id=$1 and task_id=$2 and agent_id=$3
    and type='mock:implementation' and metadata->>'round'=$4 order by created_at desc,id desc limit 1`,[t.owner_id,t.id,t.lead_agent,String(t.review_round)]);
  if(artifact) evidence.artifactId=artifact.id;
  const [review]=await tx.query<{payload:ReviewEvidence}>(`select payload from public.agent_messages where owner_id=$1 and task_id=$2 and from_agent=$3
    and type='REVIEW_RESULT' and review_round=$4 order by created_at desc,id desc limit 1`,[t.owner_id,t.id,t.reviewer_agent,t.review_round]);
  if(review && artifact && review.payload.artifactId===artifact.id) evidence.review=review.payload;
  const tests=await tx.query<{id:string;test_type:string;result:'PASS'|'FAIL'|'PENDING'}>(`select id,test_type,result from public.test_results
    where owner_id=$1 and task_id=$2 and agent_id=$3 and test_type in ($4,$5) order by created_at desc,id desc`,
    [t.owner_id,t.id,t.reviewer_agent,`mock:unit:${t.review_round}`,`mock:regression:${t.review_round}`]);
  const unit=tests.find(x=>x.test_type===`mock:unit:${t.review_round}`),regression=tests.find(x=>x.test_type===`mock:regression:${t.review_round}`);
  if(unit && regression) evidence.tests={round:t.review_round,unit:unit.result,regression:regression.result,resultIds:[unit.id,regression.id]};
  return evidence;
}
export async function decision(tx:Query,t:TaskRow,reason:string,by:string):Promise<string> {
  const [row]=await tx.query<{id:string}>(`insert into public.decisions(owner_id,project_id,task_id,question,decision,reason,decided_by)
    values($1,$2,$3,'Next action',$4,$4,$5) returning id`,[t.owner_id,t.project_id,t.id,reason,by]);
  return row.id;
}
export async function setCost(tx:Query,t:TaskRow,costMicros:number):Promise<TaskRow> {
  if(usdToMicros(String(t.cost_usd))===costMicros) return t;
  const [row]=await tx.query<TaskRow>('update public.tasks set cost_usd=$3,version=version+1 where owner_id=$1 and id=$2 returning *',[t.owner_id,t.id,microsToUsd(costMicros)]);
  return row;
}
