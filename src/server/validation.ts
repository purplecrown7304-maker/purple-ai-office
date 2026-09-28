import { z } from 'zod';
export const uuid = z.uuid();
const money = z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/);
const text = z.string().trim().min(1).max(200);
export const projectInput = z.strictObject({ name: text, repositoryUrl: z.url().max(2000).optional(), budgetUsd: money.default('5.00') });
export const agentInput = z.strictObject({ slug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), displayName: text });
export const taskInput = z.strictObject({ projectId: uuid, title: text, description: z.string().max(8000).default(''),
  leadAgent: uuid, reviewerAgent: uuid, acceptanceCriteria: z.array(text).min(1).max(50),
  priority: z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).default('MEDIUM'), budgetUsd: money.default('5.00'),
  isDemo: z.boolean().default(false), delayMs: z.number().int().min(0).max(10000).default(2500),
}).refine(t=>t.leadAgent!==t.reviewerAgent, 'DISTINCT_AGENTS_REQUIRED');
export const decisionInput = z.strictObject({ action: z.enum(['approve','revise','cancel','resume','pause','unpause','budget']),
  reason: z.string().trim().min(1).max(2000), budgetUsd: money.optional() });
export class ServiceError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export function requireThat(value: unknown, code: string, status = 409): asserts value {
  if (!value) throw new ServiceError(code,status);
}
