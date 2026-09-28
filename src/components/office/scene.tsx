import Link from "next/link";
import {
  activityFor,
  agentTone,
  messageLabels,
  statusLabels,
} from "../../lib/office/presentation";
import type { Agent, Detail, Message } from "../../lib/office/types";
import { Card, CardHeader } from "../ui/card";

function Robot({ orange }: { orange: boolean }) {
  return (
    <svg viewBox="0 0 140 150" aria-hidden="true" className="robot">
      {orange ? (
        <path
          d="M46 35 40 18M94 35l6-17"
          stroke="#fa8b12"
          strokeWidth="7"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path d="M70 35V14" stroke="#2aaabe" strokeWidth="5" />
          <circle cx="70" cy="12" r="6" fill="#2aaabe" />
        </>
      )}
      <rect
        x="17"
        y="32"
        width="106"
        height="88"
        rx={orange ? 44 : 34}
        fill={orange ? "#fa931e" : "#32aec1"}
      />
      <ellipse
        cx="70"
        cy="42"
        rx="36"
        ry="13"
        fill={orange ? "#ffc36f" : "#77d4e0"}
      />
      <rect
        x="29"
        y="58"
        width="82"
        height="44"
        rx="22"
        fill={orange ? "#452307" : "#10343b"}
      />
      <circle cx="53" cy="80" r="7" fill={orange ? "#ffe1bc" : "#8df0ff"} />
      <circle cx="87" cy="80" r="7" fill={orange ? "#ffe1bc" : "#8df0ff"} />
      <rect
        x="49"
        y="121"
        width="42"
        height="21"
        rx="11"
        fill={orange ? "#f98a13" : "#29a8bc"}
      />
    </svg>
  );
}
export function OfficeScene({
  detail,
  agents,
  parcel,
}: {
  detail: Detail | null;
  agents: Agent[];
  parcel: Message | null;
}) {
  const task = detail?.task ?? null;
  const assigned = task
    ? agents.filter((a) =>
        [task.lead_agent, task.reviewer_agent].includes(a.id),
      )
    : agents.slice(0, 2);
  const ordered = [...assigned].sort((a, b) =>
    a.slug === "gpt" ? -1 : b.slug === "gpt" ? 1 : a.slug.localeCompare(b.slug),
  );
  const halted =
    !task ||
    task.demo_paused ||
    [
      "WAITING_USER",
      "DONE",
      "CANCELLED",
      "ESCALATED",
      "BLOCKED",
      "WAITING_AGENT",
    ].includes(task.status);
  const flash = halted ? null : parcel;
  const latest = detail?.messages.filter((m) => m.from_agent).at(-1);
  const speaker =
    task && ["WAITING_USER", "DONE", "CANCELLED"].includes(task.status)
      ? null
      : (flash ?? latest);
  const names = (id: string | null) =>
    agents.find((a) => a.id === id)?.display_name ?? "대표";
  return (
    <Card className="scene-card">
      <CardHeader>
        <h2>지금 하는 일</h2>
        <span className="muted">
          토론 {task?.discussion_rounds ?? 0}/6　 검수{" "}
          {task?.review_retries ?? 0}/3　 {task?.code}
        </span>
      </CardHeader>
      {!task && (
        <p className="empty-scene">
          작업을 만들고 AI 팀에 첫 지시를 내려 주세요.
        </p>
      )}
      <div className="office-scene" data-testid="office-scene">
        {ordered.map((agent) => {
          const activity = activityFor(agent, task, flash);
          return (
            <div
              key={agent.id}
              className={`desk ${agentTone(agent)} activity-${activity}`}
              data-testid={`desk-${agent.slug}`}
              data-activity={activity}
            >
              <div className="speech-space">
                {speaker?.from_agent === agent.id && (
                  <div className="speech">{speaker.message}</div>
                )}
              </div>
              <Robot orange={agentTone(agent) === "orange"} />
              <div className="monitor" aria-hidden="true">
                <div className="code-lines">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="scan-line" />
                <div className="ellipsis">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="monitor-foot" />
              <Link className="agent-name" href={`/agents/${agent.slug}`}>
                {agent.display_name}
              </Link>
              <span className="activity-label">
                ●{" "}
                {activity === "typing"
                  ? task?.status === "FIXING"
                    ? "수정 중"
                    : "구현 중"
                  : activity === "scan"
                    ? ["NEW", "ANALYZING", "PLANNED"].includes(
                        task?.status ?? "",
                      )
                      ? "분석 중"
                      : "검수 중"
                    : activity === "ellipsis"
                      ? !flash
                        ? "대화 중"
                        : flash.from_agent === agent.id &&
                            flash.type === "QUESTION"
                          ? "질문 중"
                          : "답변 중"
                      : "대기"}
              </span>
            </div>
          );
        })}
        <div className="delivery-track" aria-live="polite">
          {flash && (
            <div
              key={flash.id}
              className={`delivery ${flash.from_agent === ordered[0]?.id ? "to-right" : "to-left"}`}
              data-message-id={flash.id}
            >
              <small>
                {names(flash.from_agent)} → {names(flash.to_agent)}
              </small>
              <span
                className={`parcel ${agentTone(agents.find((a) => a.id === flash.from_agent) ?? ordered[0])}`}
              >
                {messageLabels[flash.type]}
              </span>
            </div>
          )}
        </div>
      </div>
      <p className="scene-caption">
        {task
          ? `${statusLabels[task.status]} · 구현 ${names(task.lead_agent)} · 검수 ${names(task.reviewer_agent)}`
          : "등록된 에이전트가 이곳에서 함께 일합니다."}
      </p>
    </Card>
  );
}
