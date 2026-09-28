import { z } from 'zod';
import { MESSAGE_TYPES, TASK_STATUSES, type TaskState } from '../domain/types';

export interface AgentMessage { id: string; type: string; message: string; from_agent: string | null; to_agent: string | null }
export interface TaskContext extends TaskState {
  id: string; title: string; description: string; step: number; actorId: string;
  recentMessages: AgentMessage[];
}
export const providerResult = z.strictObject({
  replies: z.array(z.strictObject({ type: z.enum(MESSAGE_TYPES), message: z.string().trim().min(1).max(8000),
    recipient: z.enum(['lead', 'reviewer', 'ceo']), requiresResponse: z.boolean() })).min(1).max(4),
  statusChange: z.enum(TASK_STATUSES).optional(),
  usage: z.strictObject({ inputTokens: z.number().int().nonnegative().max(1e9), outputTokens: z.number().int().nonnegative().max(1e9), costUsd: z.number().nonnegative().max(999999.999999) }),
  evidence: z.strictObject({ plan: z.string().max(8000).optional(), artifact: z.string().max(8000).optional(),
    review: z.enum(['PASS','FAIL']).optional(), tests: z.enum(['PASS','FAIL']).optional() }).optional(),
});
export type ProviderResult = z.infer<typeof providerResult>;
export interface AgentProvider {
  id: string;
  respond(input: { task: TaskContext; message: AgentMessage; signal?: AbortSignal }): Promise<ProviderResult>;
}
