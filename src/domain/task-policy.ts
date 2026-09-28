import { assertMicros } from './money';
import { TASK_STATUSES, type Actor, type TaskState, type TaskStatus, type TransitionEvidence } from './types';

export const LIMITS = { discussionRounds: 6, reviewRetries: 3, fixAttempts: 3, messageCount: 20 } as const;
export const ACTIVE = ['NEW', 'ANALYZING', 'DISCUSSION', 'PLANNED', 'IMPLEMENTING', 'CROSS_REVIEW', 'TESTING', 'FIXING'] as const satisfies readonly TaskStatus[];
export const NORMAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  NEW: ['ANALYZING'], ANALYZING: ['DISCUSSION', 'PLANNED'], DISCUSSION: ['PLANNED'],
  PLANNED: ['IMPLEMENTING'], IMPLEMENTING: ['CROSS_REVIEW'], CROSS_REVIEW: ['FIXING', 'TESTING'],
  FIXING: ['CROSS_REVIEW'], TESTING: ['FIXING', 'WAITING_USER'],
  WAITING_USER: ['DONE', 'FIXING'], BLOCKED: [], WAITING_AGENT: [], ESCALATED: [], DONE: [], CANCELLED: [],
};
const active = (s: TaskStatus) => (ACTIVE as readonly TaskStatus[]).includes(s);
const terminal = (s: TaskStatus) => s === 'DONE' || s === 'CANCELLED';
const unresolvedOutcome = (task: TaskState) => task.status === 'WAITING_USER' && task.pauseReason === 'UNKNOWN_OUTCOME';
function requireCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export function validateTask(task: TaskState): void {
  requireCondition(TASK_STATUSES.includes(task.status), 'INVALID_STATUS');
  requireCondition(task.leadAgent.trim() && task.reviewerAgent.trim() && task.leadAgent !== task.reviewerAgent, 'DISTINCT_AGENTS_REQUIRED');
  requireCondition(task.acceptanceCriteria.length > 0 && task.acceptanceCriteria.every(c => typeof c === 'string' && c.trim().length > 0), 'ACCEPTANCE_CRITERIA_REQUIRED');
  for (const n of [task.discussionRounds, task.reviewRetries, task.fixAttempts, task.reviewRound, task.messageCount]) {
    requireCondition(Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647, 'INVALID_COUNTER');
  }
  assertMicros(task.budgetMicros); assertMicros(task.costMicros);
}
export function exceededLimits(task: TaskState): string[] {
  validateTask(task);
  const reasons: string[] = [];
  if (task.costMicros > task.budgetMicros) reasons.push('BUDGET');
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) if (task[key] > LIMITS[key]) reasons.push(key);
  return reasons;
}
export function enforceLimits(task: TaskState): TaskState {
  const limits = exceededLimits(task);
  // Keep this non-resumable reason: rewriting it as BUDGET/LIMIT would reopen resume.
  if (terminal(task.status) || unresolvedOutcome(task) || limits.length === 0) return task;
  return { ...task, status: limits.includes('BUDGET') ? 'WAITING_USER' : 'ESCALATED',
    pauseReason: limits.includes('BUDGET') ? 'BUDGET' : 'LIMIT',
    resumeStatus: active(task.status) ? task.status : task.resumeStatus };
}
/** Uncertain execution cannot be resumed, including when a budget pause races it. */
export function unknownOutcome(task: TaskState): TaskState {
  validateTask(task);
  if (terminal(task.status)) return task;
  return { ...task, status: 'WAITING_USER', pauseReason: 'UNKNOWN_OUTCOME',
    resumeStatus: active(task.status) ? task.status : task.resumeStatus };
}
function reviewerPass(task: TaskState, e: TransitionEvidence): boolean {
  const r = e.review;
  return !!r && r.agentId === task.reviewerAgent && r.round === task.reviewRound && r.round > 0 &&
    r.verdict === 'PASS' && r.criticalBugCount === 0 && !!r.artifactId &&
    task.acceptanceCriteria.every(c => r.acceptanceResults.some(a => a.criterion === c && a.passed));
}
function testsPass(task: TaskState, e: TransitionEvidence): boolean {
  const t = e.tests;
  return !!t && t.round === task.reviewRound && t.unit === 'PASS' && t.regression === 'PASS' && t.resultIds.length > 0;
}
/** The only transition policy. SQL implements integrity/CAS, not a second policy map. */
export function transition(task: TaskState, to: TaskStatus, actor: Actor, e: TransitionEvidence = {}): TaskState {
  validateTask(task);
  requireCondition(!terminal(task.status), 'TERMINAL_TASK');
  requireCondition(to !== task.status, 'NOT_A_TRANSITION');
  requireCondition(actor.id.trim(), 'ACTOR_REQUIRED');
  requireCondition(actor.role !== 'agent' || [task.leadAgent, task.reviewerAgent].includes(actor.id), 'UNASSIGNED_AGENT');
  const ceo = actor.role === 'ceo';
  const lead = actor.role === 'agent' && actor.id === task.leadAgent;
  const reviewer = actor.role === 'agent' && actor.id === task.reviewerAgent;
  if (to === 'CANCELLED') {
    requireCondition(ceo, 'CEO_REQUIRED');
    return { ...task, status: to, pauseReason: null, resumeStatus: null };
  }
  // UNKNOWN_OUTCOME runs remain immutable/unsettled in Phase 1. A CEO decision
  // cannot clear their unique-index slot; cancel and create a new task instead.
  requireCondition(!unresolvedOutcome(task), 'UNKNOWN_OUTCOME_CANCEL_ONLY');
  if (task.status === 'ESCALATED' && to === 'WAITING_USER') {
    requireCondition(ceo && e.ceoDecisionId, 'CEO_DECISION_REQUIRED');
    return { ...task, status: to, pauseReason: task.costMicros > task.budgetMicros ? 'BUDGET' : 'LIMIT' };
  }
  const guarded = enforceLimits(task);
  if (exceededLimits(task).length > 0) return guarded;

  const pause = ['BLOCKED', 'WAITING_AGENT', 'WAITING_USER', 'ESCALATED'].includes(to);
  if (active(task.status) && pause && !(task.status === 'TESTING' && to === 'WAITING_USER' && !e.pauseReason)) {
    requireCondition(actor.role === 'system' || ceo || lead || reviewer, 'ACTOR_REQUIRED');
    const reason = to === 'BLOCKED' ? 'BLOCKER' : to === 'WAITING_AGENT' ? 'AGENT' : to === 'ESCALATED' ? 'LIMIT' : e.pauseReason ?? 'DECISION';
    return { ...task, status: to, pauseReason: reason, resumeStatus: task.status };
  }
  if (['BLOCKED', 'WAITING_AGENT'].includes(task.status) && ['WAITING_USER', 'ESCALATED'].includes(to)) {
    return { ...task, status: to, pauseReason: to === 'WAITING_USER' ? 'DECISION' : 'LIMIT' };
  }
  if (['BLOCKED', 'WAITING_AGENT', 'WAITING_USER'].includes(task.status) && task.pauseReason !== 'FINAL_APPROVAL') {
    requireCondition(to === task.resumeStatus && active(to), 'INVALID_RESUME');
    if (task.status === 'WAITING_USER') requireCondition(ceo && e.ceoDecisionId, 'CEO_DECISION_REQUIRED');
    if (task.status === 'BLOCKED') requireCondition(e.blockerResolved, 'BLOCKER_NOT_RESOLVED');
    if (task.status === 'WAITING_AGENT') requireCondition(e.replyMessageId, 'REPLY_REQUIRED');
    return { ...task, status: to, pauseReason: null, resumeStatus: null };
  }
  requireCondition(NORMAL_TRANSITIONS[task.status].includes(to), 'INVALID_TRANSITION');
  const next = { ...task, status: to, pauseReason: null, resumeStatus: null } as TaskState;
  if (task.status === 'WAITING_USER') {
    requireCondition(ceo && task.pauseReason === 'FINAL_APPROVAL' && e.ceoDecisionId, 'CEO_APPROVAL_REQUIRED');
    if (to === 'DONE') requireCondition(reviewerPass(task, e) && testsPass(task, e), 'COMPLETION_EVIDENCE_REQUIRED');
  } else if (task.status === 'CROSS_REVIEW') {
    requireCondition(reviewer, 'REVIEWER_REQUIRED');
    if (to === 'TESTING') requireCondition(reviewerPass(task, e), 'REVIEW_PASS_REQUIRED');
    else requireCondition(e.review?.agentId === task.reviewerAgent && e.review.round === task.reviewRound && e.review.verdict === 'FAIL', 'REVIEW_FAIL_REQUIRED');
  } else if (task.status === 'TESTING') {
    requireCondition(actor.role === 'system' || reviewer, 'TEST_ACTOR_REQUIRED');
    if (to === 'WAITING_USER') {
      requireCondition(reviewerPass(task, e) && testsPass(task, e), 'COMPLETION_EVIDENCE_REQUIRED');
      next.pauseReason = 'FINAL_APPROVAL'; next.resumeStatus = 'TESTING';
    } else requireCondition(e.tests?.round === task.reviewRound && (e.tests.unit === 'FAIL' || e.tests.regression === 'FAIL'), 'TEST_FAIL_REQUIRED');
  } else {
    requireCondition(lead, 'LEAD_REQUIRED');
    if (to === 'PLANNED') requireCondition(e.planDecisionId, 'PLAN_REQUIRED');
    if (to === 'CROSS_REVIEW') {
      requireCondition(e.artifactId, 'ARTIFACT_REQUIRED');
      next.reviewRound++;
      if (task.status === 'FIXING') next.reviewRetries++;
    }
  }
  if (to === 'FIXING') next.fixAttempts++;
  const limited = enforceLimits(next);
  // A rejected progression resumes from its actual source, not an uncommitted target.
  if (limited !== next) limited.resumeStatus = task.status === 'WAITING_USER' ? task.resumeStatus : task.status;
  return limited;
}
