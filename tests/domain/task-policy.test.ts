import { describe, expect, it } from 'vitest';
import { enforceLimits, exceededLimits, transition, validateTask } from '../../src/domain/task-policy';
import { TASK_STATUSES, type TaskState, type TransitionEvidence } from '../../src/domain/types';
import { microsToUsd, usdToMicros } from '../../src/domain/money';

const lead = { role: 'agent', id: 'gpt' } as const;
const reviewer = { role: 'agent', id: 'claude' } as const;
const ceo = { role: 'ceo', id: 'owner' } as const;
const system = { role: 'system', id: 'orchestrator' } as const;
function task(patch: Partial<TaskState> = {}): TaskState {
  return { status: 'NEW', leadAgent: 'gpt', reviewerAgent: 'claude', acceptanceCriteria: ['Works'], discussionRounds: 0, reviewRetries: 0, fixAttempts: 0, reviewRound: 0, messageCount: 0, costMicros: 0, budgetMicros: 5_000_000, pauseReason: null, resumeStatus: null, ...patch };
}
function evidence(round: number): TransitionEvidence {
  return { planDecisionId: 'plan', artifactId: 'artifact', ceoDecisionId: 'decision',
    review: { agentId: 'claude', round, verdict: 'PASS', artifactId: 'artifact', criticalBugCount: 0, acceptanceResults: [{ criterion: 'Works', passed: true }] },
    tests: { round, unit: 'PASS', regression: 'PASS', resultIds: ['unit-result','regression-result'] } };
}
describe('workflow policy', () => {
  it('completes the demo with independent review, one fix and CEO approval', () => {
    let t = task();
    for (const next of ['ANALYZING','DISCUSSION','PLANNED','IMPLEMENTING','CROSS_REVIEW'] as const) t = transition(t,next,lead,evidence(1));
    t = transition(t,'FIXING',reviewer,{ review: { ...evidence(1).review!, verdict: 'FAIL' } });
    expect(t.fixAttempts).toBe(1);
    t = transition(t,'CROSS_REVIEW',lead,evidence(1));
    expect([t.reviewRound,t.reviewRetries]).toEqual([2,1]);
    t = transition(t,'TESTING',reviewer,evidence(2));
    t = transition(t,'WAITING_USER',system,evidence(2));
    expect(t.pauseReason).toBe('FINAL_APPROVAL');
    expect(transition(t,'DONE',ceo,evidence(2)).status).toBe('DONE');
  });
  it('allows ANALYZING → PLANNED only with a recorded plan', () => {
    expect(transition(task({status:'ANALYZING'}),'PLANNED',lead,evidence(0)).status).toBe('PLANNED');
    expect(() => transition(task({status:'ANALYZING'}),'PLANNED',lead)).toThrow('PLAN_REQUIRED');
  });
  it('rejects equal implementer and reviewer, blank criteria and invalid counters', () => {
    expect(() => validateTask(task({reviewerAgent:'gpt'}))).toThrow('DISTINCT_AGENTS_REQUIRED');
    expect(() => validateTask(task({acceptanceCriteria:[' ']}))).toThrow('ACCEPTANCE_CRITERIA_REQUIRED');
    expect(() => validateTask(task({fixAttempts:-1}))).toThrow('INVALID_COUNTER');
  });
  it('rejects self-review, strangers and stale or incomplete evidence', () => {
    const t=task({status:'CROSS_REVIEW',reviewRound:2});
    expect(() => transition(t,'TESTING',lead,evidence(2))).toThrow('REVIEWER_REQUIRED');
    expect(() => transition(t,'TESTING',{role:'agent',id:'stranger'},evidence(2))).toThrow('UNASSIGNED_AGENT');
    expect(() => transition(t,'TESTING',reviewer,evidence(1))).toThrow('REVIEW_PASS_REQUIRED');
    expect(() => transition(t,'TESTING',reviewer,{review:{...evidence(2).review!,acceptanceResults:[]}})).toThrow('REVIEW_PASS_REQUIRED');
    expect(() => transition(t,'TESTING',reviewer,{review:{...evidence(2).review!,criticalBugCount:1}})).toThrow('REVIEW_PASS_REQUIRED');
  });
  it('does not permit direct completion or agent approval', () => {
    expect(() => transition(task({status:'TESTING'}),'DONE',ceo,evidence(0))).toThrow('INVALID_TRANSITION');
    const t=task({status:'WAITING_USER',pauseReason:'FINAL_APPROVAL',reviewRound:1});
    expect(() => transition(t,'DONE',lead,evidence(1))).toThrow('CEO_APPROVAL_REQUIRED');
    expect(() => transition(t,'DONE',ceo,{...evidence(1),tests:{...evidence(1).tests!,regression:'FAIL'}})).toThrow('COMPLETION_EVIDENCE_REQUIRED');
    expect(() => transition({...t,pauseReason:'BUDGET'},'DONE',ceo,evidence(1))).toThrow('INVALID_RESUME');
  });
  it.each(['DONE','CANCELLED'] as const)('rejects every transition out of %s', status => {
    for(const next of TASK_STATUSES) expect(() => transition(task({status}),next,ceo,evidence(0))).toThrow('TERMINAL_TASK');
  });
  it('forbids skipping phases and same-state mutations', () => {
    for(const next of ['PLANNED','IMPLEMENTING','CROSS_REVIEW','TESTING','FIXING','DONE'] as const) expect(() => transition(task(),next,lead)).toThrow('INVALID_TRANSITION');
    expect(() => transition(task(),'NEW',lead)).toThrow('NOT_A_TRANSITION');
  });
  it.each([
    ['discussionRounds',6], ['reviewRetries',3], ['fixAttempts',3], ['messageCount',20],
  ] as const)('%s allows the boundary and escalates one over it', (key,limit) => {
    expect(exceededLimits(task({[key]:limit}))).toEqual([]);
    const result=enforceLimits(task({status:'IMPLEMENTING',[key]:limit+1}));
    expect(result.status).toBe('ESCALATED'); expect(result.resumeStatus).toBe('IMPLEMENTING');
  });
  it('prioritizes overspend over all loop limits and preserves cost at exact budget', () => {
    expect(enforceLimits(task({costMicros:5_000_000})).status).toBe('NEW');
    const t=enforceLimits(task({costMicros:5_000_001,fixAttempts:4}));
    expect(t.status).toBe('WAITING_USER'); expect(t.pauseReason).toBe('BUDGET');
    expect(transition(t,'ANALYZING',lead).status).toBe('WAITING_USER');
    expect(transition(t,'CANCELLED',ceo).status).toBe('CANCELLED');
  });
  it('counts retries/fixes and escalates before progressing beyond a boundary', () => {
    const t=transition(task({status:'FIXING',reviewRetries:3,reviewRound:4}),'CROSS_REVIEW',lead,evidence(4));
    expect(t).toMatchObject({status:'ESCALATED',reviewRetries:4,resumeStatus:'FIXING'});
  });
  it('resumes only the saved phase with required evidence', () => {
    const blocked=transition(task({status:'IMPLEMENTING'}),'BLOCKED',lead);
    expect(() => transition(blocked,'TESTING',lead)).toThrow('INVALID_RESUME');
    expect(() => transition(blocked,'IMPLEMENTING',lead)).toThrow('BLOCKER_NOT_RESOLVED');
    expect(transition(blocked,'IMPLEMENTING',lead,{blockerResolved:true}).pauseReason).toBeNull();
    const waiting=transition(task({status:'DISCUSSION'}),'WAITING_AGENT',lead);
    expect(() => transition(waiting,'DISCUSSION',lead)).toThrow('REPLY_REQUIRED');
    expect(transition(waiting,'DISCUSSION',system,{replyMessageId:'answer'}).status).toBe('DISCUSSION');
    const budget=task({status:'WAITING_USER',pauseReason:'BUDGET',resumeStatus:'IMPLEMENTING',costMicros:6_000_000,budgetMicros:7_000_000});
    expect(() => transition(budget,'IMPLEMENTING',lead)).toThrow('CEO_DECISION_REQUIRED');
    expect(transition(budget,'IMPLEMENTING',ceo,evidence(0)).status).toBe('IMPLEMENTING');
  });
  it('allows a CEO to take ownership of an escalation without clearing its limits', () => {
    const t=task({status:'ESCALATED',fixAttempts:4,pauseReason:'LIMIT',resumeStatus:'FIXING'});
    const waiting=transition(t,'WAITING_USER',ceo,evidence(1));
    expect(waiting.status).toBe('WAITING_USER'); expect(waiting.fixAttempts).toBe(4);
    expect(transition(waiting,'FIXING',ceo,evidence(1)).status).toBe('ESCALATED');
  });
  it('can pause uncertain test execution without pretending final approval is ready', () => {
    const t=transition(task({status:'TESTING'}),'WAITING_USER',system,{pauseReason:'UNKNOWN_OUTCOME'});
    expect(t.pauseReason).toBe('UNKNOWN_OUTCOME');
    expect(() => transition(t,'DONE',ceo,evidence(0))).toThrow('INVALID_RESUME');
  });
});
describe('fixed-point USD', () => {
  it.each(['0','5','0.000001','999999.999999'])('round-trips %s without floats', value => {
    expect(usdToMicros(microsToUsd(usdToMicros(value)))).toBe(usdToMicros(value));
  });
  it.each(['-1','NaN','Infinity','1e3','0.0000001','1000000','01',' 1'])('rejects %s', value => {
    expect(() => usdToMicros(value)).toThrow('INVALID_MONEY');
  });
  it('does not round fractional micros', () => expect(() => microsToUsd(0.1)).toThrow('INVALID_MONEY'));
});
