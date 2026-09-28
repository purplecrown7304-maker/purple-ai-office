import type { Agent, Message, Task } from "./types";
import type { TaskStatus } from "../../domain/types";
export const statusLabels: Record<TaskStatus, string> = {
  NEW: "대기",
  ANALYZING: "분석",
  DISCUSSION: "토론",
  PLANNED: "계획 완료",
  IMPLEMENTING: "구현",
  CROSS_REVIEW: "교차 검수",
  TESTING: "테스트",
  FIXING: "수정",
  BLOCKED: "문제 해결 대기",
  WAITING_AGENT: "답변 대기",
  WAITING_USER: "대표 승인 대기",
  ESCALATED: "한도 확인",
  DONE: "완료",
  CANCELLED: "취소",
};
export const messageLabels: Record<string, string> = {
  QUESTION: "질문",
  ANSWER: "답변",
  PROPOSAL: "제안",
  REVIEW_REQUEST: "검수 요청",
  REVIEW_RESULT: "검수 결과",
  TEST_REQUEST: "테스트 요청",
  TEST_RESULT: "테스트",
  CHALLENGE: "수정 요청",
  DECISION: "결정",
  HANDOFF: "지시",
  BLOCKER: "문제",
  STATUS: "상태",
};
export const pauseLabels: Record<string, string> = {
  BUDGET: "예산을 초과했어요",
  LIMIT: "반복 한도를 확인해 주세요",
  DECISION: "대표의 판단이 필요해요",
  UNKNOWN_OUTCOME: "실행 결과를 확인할 수 없어요",
  FINAL_APPROVAL: "승인이 필요해요",
  BLOCKER: "문제 해결을 기다려요",
  AGENT: "답변을 기다려요",
};
export const boardColumns = [
  {
    label: "대기",
    statuses: ["NEW", "PLANNED", "BLOCKED", "WAITING_AGENT", "ESCALATED"],
  },
  { label: "토론", statuses: ["ANALYZING", "DISCUSSION"] },
  { label: "구현", statuses: ["IMPLEMENTING", "FIXING"] },
  { label: "검수", statuses: ["CROSS_REVIEW", "TESTING", "WAITING_USER"] },
  { label: "완료", statuses: ["DONE", "CANCELLED"] },
];
export type Activity = "idle" | "typing" | "scan" | "ellipsis";
export function activityFor(
  agent: Agent,
  task: Task | null,
  flash: Message | null,
): Activity {
  if (
    !task ||
    task.demo_paused ||
    [
      "WAITING_USER",
      "DONE",
      "CANCELLED",
      "BLOCKED",
      "WAITING_AGENT",
      "ESCALATED",
    ].includes(task.status)
  )
    return "idle";
  if (
    flash?.task_id === task.id &&
    ["QUESTION", "ANSWER"].includes(flash.type) &&
    [flash.from_agent, flash.to_agent].includes(agent.id)
  )
    return "ellipsis";
  if (
    agent.current_task_id !== task.id ||
    !["WORKING", "REVIEWING"].includes(agent.status)
  )
    return "idle";
  if (
    ["IMPLEMENTING", "FIXING"].includes(task.status) &&
    task.lead_agent === agent.id
  )
    return "typing";
  if (
    task.status === "ANALYZING" ||
    (task.status === "CROSS_REVIEW" && task.reviewer_agent === agent.id)
  )
    return "scan";
  return "idle";
}
export function canRun(task: Task) {
  return (
    task.is_demo &&
    !task.demo_paused &&
    [
      "NEW",
      "ANALYZING",
      "DISCUSSION",
      "PLANNED",
      "IMPLEMENTING",
      "CROSS_REVIEW",
      "FIXING",
      "TESTING",
    ].includes(task.status)
  );
}
export function sortedMessages(messages: Message[]) {
  return [...messages].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}
/** Initial/reconnect snapshots establish a baseline; updates never replay a parcel. */
export class MessageTracker {
  private seen = new Set<string>();
  baseline(messages: Message[]) {
    this.seen = new Set(messages.map((m) => m.id));
  }
  accept(message: Message, taskId: string, participantIds: string[]) {
    if (this.seen.has(message.id)) return false;
    this.seen.add(message.id);
    return (
      message.task_id === taskId &&
      !!message.from_agent &&
      !!message.to_agent &&
      message.from_agent !== message.to_agent &&
      participantIds.includes(message.from_agent) &&
      participantIds.includes(message.to_agent)
    );
  }
}
export function agentTone(agent: Agent) {
  return agent.slug === "claude" ? "orange" : "cyan";
}
export function money(value: string | number | null) {
  return value === null
    ? "미확정"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(Number(value));
}
