import type { TaskStatus, PauseReason, MessageType } from "../../domain/types";
export interface Project {
  id: string;
  name: string;
  repository_url: string | null;
  default_budget_usd: string;
  status: string;
}
export interface Agent {
  id: string;
  slug: string;
  display_name: string;
  status: string;
  current_task_id: string | null;
  last_active_at: string | null;
  provider: string;
  model: string;
}
export interface Task {
  id: string;
  project_id: string;
  code: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: string;
  lead_agent: string;
  reviewer_agent: string;
  acceptance_criteria: string[];
  budget_usd: string;
  cost_usd: string;
  discussion_rounds: number;
  review_retries: number;
  fix_attempts: number;
  review_round: number;
  pause_reason: PauseReason | null;
  resume_status: TaskStatus | null;
  version: number;
  is_demo: boolean;
  demo_step: number;
  demo_delay_ms: number;
  demo_next_step_at: string | null;
  demo_paused: boolean;
  updated_at: string;
}
export interface Message {
  id: string;
  task_id: string;
  from_agent: string | null;
  to_agent: string | null;
  from_role: string;
  to_role: string;
  type: MessageType;
  message: string;
  requires_response: boolean;
  queue_status: string;
  created_at: string;
  run_id: string | null;
  payload: Record<string, unknown>;
}
export interface Run {
  id: string;
  agent_id: string;
  status: string;
  cost_usd: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: string;
  error: string | null;
}
export interface TaskEvent {
  id: string;
  from_status: TaskStatus | null;
  to_status: TaskStatus;
  reason: string;
  actor: string;
  task_version: number;
  created_at: string;
}
export interface Detail {
  task: Task;
  messages: Message[];
  events: TaskEvent[];
  runs: Run[];
  tests: { id: string; test_type: string; result: string; output: string }[];
  artifacts: { id: string; type: string; path: string }[];
}
export interface OfficeData {
  projects: Project[];
  agents: Agent[];
  tasks: Task[];
  detail: Detail | null;
}
