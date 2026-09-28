export const TASK_STATUSES = ['NEW', 'ANALYZING', 'DISCUSSION', 'PLANNED', 'IMPLEMENTING', 'CROSS_REVIEW', 'TESTING', 'FIXING', 'BLOCKED', 'WAITING_AGENT', 'WAITING_USER', 'ESCALATED', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const MESSAGE_TYPES = ['QUESTION', 'ANSWER', 'PROPOSAL', 'REVIEW_REQUEST', 'REVIEW_RESULT', 'TEST_REQUEST', 'TEST_RESULT', 'CHALLENGE', 'DECISION', 'HANDOFF', 'BLOCKER', 'STATUS'] as const;
export type MessageType = typeof MESSAGE_TYPES[number];
export type PauseReason = 'BUDGET' | 'LIMIT' | 'BLOCKER' | 'AGENT' | 'DECISION' | 'FINAL_APPROVAL' | 'UNKNOWN_OUTCOME';
export type Actor = { role: 'ceo' | 'system'; id: string } | { role: 'agent'; id: string };
export interface TaskState {
  status: TaskStatus;
  leadAgent: string;
  reviewerAgent: string;
  acceptanceCriteria: readonly string[];
  discussionRounds: number;
  reviewRetries: number;
  fixAttempts: number;
  reviewRound: number;
  messageCount: number;
  costMicros: number;
  budgetMicros: number;
  pauseReason: PauseReason | null;
  resumeStatus: TaskStatus | null;
}
export interface ReviewEvidence {
  agentId: string;
  round: number;
  verdict: 'PASS' | 'FAIL';
  artifactId: string;
  acceptanceResults: readonly { criterion: string; passed: boolean }[];
  criticalBugCount: number;
}
export interface TestEvidence {
  round: number;
  unit: 'PASS' | 'FAIL' | 'PENDING';
  regression: 'PASS' | 'FAIL' | 'PENDING';
  resultIds: readonly string[];
}
// Evidence must be loaded from storage by the server, never copied from browser input.
export interface TransitionEvidence {
  pauseReason?: 'DECISION' | 'UNKNOWN_OUTCOME';
  planDecisionId?: string;
  artifactId?: string;
  review?: ReviewEvidence;
  tests?: TestEvidence;
  blockerResolved?: boolean;
  replyMessageId?: string;
  ceoDecisionId?: string;
}
