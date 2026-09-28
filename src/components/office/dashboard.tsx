"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, LogOut, Plus, RefreshCw } from "lucide-react";
import { useOffice } from "../../lib/office/use-office";
import { api, ApiError, errorMessage } from "../../lib/office/api";
import {
  canRun,
  money,
  pauseLabels,
  statusLabels,
} from "../../lib/office/presentation";
import type { Detail, Task } from "../../lib/office/types";
import { Button } from "../ui/button";
import { Card, CardHeader } from "../ui/card";
import { Input, Textarea } from "../ui/input";
import { OfficeScene } from "./scene";
import { Feed } from "./feed";
import { Board } from "./board";

export function Dashboard({
  taskId,
  full = false,
}: {
  taskId?: string;
  full?: boolean;
}) {
  const { data, loading, error, connection, refresh, parcel } =
    useOffice(taskId);
  const { detail, agents, projects, tasks } = data,
    task = detail?.task;
  const router = useRouter();
  const [running, setRunning] = useState(false),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const [reason, setReason] = useState(""),
    [budget, setBudget] = useState("");
  const [visible, setVisible] = useState(true);
  const inFlight = useRef(false),
    stepKey = useRef<{ task: string; key: string } | null>(null);
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const executable = !!task && canRun(task);
  useEffect(() => {
    if (
      !task ||
      !running ||
      !executable ||
      !visible ||
      connection !== "실시간 연결" ||
      actionError
    )
      return;
    const timer = setTimeout(
      async () => {
        if (inFlight.current) return;
        inFlight.current = true;
        const request =
          stepKey.current?.task === task.id
            ? stepKey.current
            : { task: task.id, key: crypto.randomUUID() };
        stepKey.current = request;
        try {
          await api<Detail>(`tasks/${task.id}/step`, {}, request.key);
          stepKey.current = null;
        } catch (e) {
          if (e instanceof ApiError && e.code === "TASK_NOT_RUNNABLE") {
            // A Realtime snapshot can race a final/pause transition. Stop quietly.
            stepKey.current = null;
            setRunning(false);
          } else if (
            e instanceof ApiError &&
            ["STEP_NOT_DUE", "AGENT_BUSY"].includes(e.code)
          )
            stepKey.current = null;
          else {
            setActionError(errorMessage(e));
            setRunning(false);
          }
        } finally {
          inFlight.current = false;
          await refresh();
        }
      },
      Math.max(
        150,
        new Date(task.demo_next_step_at ?? 0).getTime() - Date.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [task, running, executable, visible, connection, actionError, refresh]);
  async function action(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const decide = (type: string, why = reason) =>
    action(() =>
      api(`tasks/${task!.id}/decision`, {
        action: type,
        reason: why,
        ...(type === "budget" ? { budgetUsd: budget } : {}),
      }),
    );
  async function restart() {
    if (!task) return;
    setRunning(false);
    await action(async () => {
      const created = await api<Task>("tasks", {
        projectId: task.project_id,
        title: task.title,
        description: task.description,
        leadAgent: task.lead_agent,
        reviewerAgent: task.reviewer_agent,
        acceptanceCriteria: task.acceptance_criteria,
        priority: task.priority,
        budgetUsd: task.budget_usd,
        isDemo: true,
        delayMs: task.demo_delay_ms,
      });
      router.push(`/?task=${created.id}`);
    });
  }
  const project =
    projects.find((p) => p.id === task?.project_id) ?? projects[0];
  const waiting = tasks.filter((t) =>
    ["WAITING_USER", "ESCALATED"].includes(t.status),
  );
  const terminal = task && ["DONE", "CANCELLED"].includes(task.status);
  return (
    <main className="shell">
      <header className="office-header">
        <div>
          <p className="eyebrow">
            PURPLE AI OFFICE
            {project && (
              <>
                {" "}
                · <Link href={`/projects/${project.id}`}>{project.name}</Link>
              </>
            )}
          </p>
          <h1>{full ? "작업 상세" : "오피스"}</h1>
        </div>
        <div className="header-actions">
          <span className="demo-badge">
            <i />{" "}
            {task
              ? `Mock · ${task.demo_step}/11 ${statusLabels[task.status]}`
              : "Mock 데모"}
          </span>
          {task && !terminal && (
            <div className="segmented">
              <Button
                variant="secondary"
                disabled={busy || (!executable && !task.demo_paused)}
                onClick={() => {
                  if (running && !task.demo_paused) {
                    setRunning(false);
                    void decide("pause", "대표가 데모를 일시정지했습니다.");
                  } else {
                    void action(async () => {
                      await api(`tasks/${task.id}/decision`, {
                        action: "unpause",
                        reason: "대표가 데모 실행을 요청했습니다.",
                      });
                      setRunning(true);
                    });
                  }
                }}
              >
                {running && !task.demo_paused ? "일시정지" : "데모 실행"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void restart()}
              >
                처음부터
              </Button>
            </div>
          )}
          {terminal && (
            <Button
              variant="secondary"
              onClick={() => void restart()}
              disabled={busy}
            >
              새 데모 만들기
            </Button>
          )}
          <span className="ceo-badge">
            <b>CEO</b>
            {waiting.length ? "승인 대기 중" : "보고 대기"}
          </span>
        </div>
      </header>
      <nav className="toolbar" aria-label="오피스 메뉴">
        <div>
          <Link href="/">오피스</Link>
          <Link href="/tasks/new">
            <Plus size={15} /> 새 작업
          </Link>
          {task && <Link href={`/tasks/${task.id}`}>{task.code} 상세</Link>}
          <Link href="/setup">프로젝트·에이전트 등록</Link>
        </div>
        <div>
          <span role="status" className="connection">
            {connection}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            aria-label="새로고침"
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void action(async () => {
                await api("logout", {});
                router.replace("/login");
                router.refresh();
              })
            }
            aria-label="로그아웃"
          >
            <LogOut size={16} />
          </Button>
        </div>
      </nav>
      {waiting.length > 0 && (
        <aside className="waiting-banner" role="status">
          <strong>대표 확인이 필요한 작업 {waiting.length}개</strong>
          <div>
            {waiting.map((t) => (
              <Link
                key={t.id}
                href={
                  t.id === task?.id ? "#approval" : `/?task=${t.id}#approval`
                }
              >
                {t.code} · {pauseLabels[t.pause_reason ?? ""] ?? "판단 대기"}
              </Link>
            ))}
          </div>
        </aside>
      )}
      {(error || actionError) && (
        <div className="error-banner" role="alert">
          {actionError || error}{" "}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setActionError("");
              void refresh();
            }}
          >
            상태 다시 확인
          </Button>
        </div>
      )}
      {loading ? (
        <Card>
          <p role="status">오피스를 불러오는 중입니다…</p>
        </Card>
      ) : (
        <>
          {!task && (
            <Card className="welcome">
              <h2>두 에이전트와 함께 시작해요</h2>
              <p>
                프로젝트와 에이전트를 등록하고, 수락 조건이 있는 작업을 만들어
                주세요.
              </p>
              <Link
                className="button button-primary"
                href={
                  projects.length && agents.length >= 2
                    ? "/tasks/new"
                    : "/setup"
                }
              >
                {projects.length && agents.length >= 2
                  ? "첫 작업 만들기"
                  : "오피스 준비하기"}
              </Link>
            </Card>
          )}
          <div className="office-grid">
            <div className="main-column">
              <OfficeScene detail={detail} agents={agents} parcel={parcel} />
              <Feed
                messages={detail?.messages ?? []}
                agents={agents}
                all={full}
              />
            </div>
            <div className="side-column">
              <Board
                tasks={tasks.filter(
                  (t) => !project || t.project_id === project.id,
                )}
                selected={task?.id}
              />
              {task && detail && (
                <>
                  <Progress detail={detail} />
                  {task.pause_reason !== "FINAL_APPROVAL" && (
                    <Card>
                      <CardHeader>
                        <h2>예산</h2>
                        <span>
                          <strong>{money(task.cost_usd)}</strong> /{" "}
                          {money(task.budget_usd)}
                        </span>
                      </CardHeader>
                      <progress
                        aria-label="사용 예산"
                        max={Math.max(Number(task.budget_usd), 0.000001)}
                        value={Number(task.cost_usd)}
                      />
                      <p className="muted">
                        Mock 모의 비용 · 실제 AI API 요금이 발생하지 않습니다.
                      </p>
                    </Card>
                  )}
                  {[
                    "WAITING_USER",
                    "ESCALATED",
                    "BLOCKED",
                    "WAITING_AGENT",
                  ].includes(task.status) && (
                    <Card className="approval-card" id="approval">
                      <h2>
                        {pauseLabels[task.pause_reason ?? ""] ??
                          "대표 확인이 필요해요"}
                      </h2>
                      <p>
                        {task.pause_reason === "FINAL_APPROVAL"
                          ? "교차 검수와 테스트를 통과했습니다. 결과를 확인하고 작업을 승인해 주세요."
                          : task.pause_reason === "UNKNOWN_OUTCOME"
                            ? "외부 실행 결과가 불명확하여 자동 재시도를 멈췄습니다. 실행 기록을 확인한 뒤 이 작업을 취소하고 새 작업을 만들어 주세요."
                            : "진행을 멈추고 대표의 결정을 기다립니다."}
                      </p>
                      <p className="muted">
                        Mock 비용 {money(task.cost_usd)} /{" "}
                        {money(task.budget_usd)}
                      </p>
                      <label>
                        결정 사유
                        <Textarea
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="확인한 내용 또는 수정 요청을 적어 주세요"
                          maxLength={2000}
                        />
                      </label>
                      <div className="action-stack">
                        {task.pause_reason === "FINAL_APPROVAL" && (
                          <>
                            <Button
                              disabled={busy || !reason.trim()}
                              onClick={() => void decide("approve")}
                            >
                              승인하고 완료
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={busy || !reason.trim()}
                              onClick={() => void decide("revise")}
                            >
                              수정 요청
                            </Button>
                          </>
                        )}
                        {["BUDGET", "DECISION"].includes(
                          task.pause_reason ?? "",
                        ) && (
                          <>
                            <label>
                              새 예산 (USD)
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={budget}
                                onChange={(e) => setBudget(e.target.value)}
                              />
                            </label>
                            <Button
                              variant="secondary"
                              disabled={busy || !reason.trim() || !budget}
                              onClick={() => void decide("budget")}
                            >
                              예산 변경
                            </Button>
                            <Button
                              disabled={busy || !reason.trim()}
                              onClick={() => void decide("resume")}
                            >
                              문제 해결 후 재개
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          disabled={busy || !reason.trim()}
                          onClick={() => void decide("cancel")}
                        >
                          작업 취소
                        </Button>
                      </div>
                      <small className="muted">
                        승인은 이 작업을 완료합니다. GitHub 병합·배포는 실행하지
                        않습니다.
                      </small>
                    </Card>
                  )}
                </>
              )}
            </div>
          </div>
          {full && detail && <Evidence detail={detail} />}
        </>
      )}
      <footer>
        상태와 대화는 DB 기록을 기준으로 표시됩니다. ·{" "}
        <span>Phase 1 / Mock Provider</span>
      </footer>
    </main>
  );
}
function Progress({ detail }: { detail: Detail }) {
  const { task, events } = detail;
  const visited = new Set(events.map((e) => e.to_status));
  const steps = [
    ["지시 접수", true],
    ["분석·토론", visited.has("PLANNED")],
    ["구현·테스트", visited.has("CROSS_REVIEW")],
    ["교차 검수", visited.has("TESTING")],
    ["대표 승인", task.status === "DONE"],
    ["배포", false],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <h2>진행</h2>
      </CardHeader>
      <ol className="progress-list">
        {steps.map(([label, done], i) => (
          <li
            key={label}
            className={
              done
                ? "complete"
                : steps.findIndex((s) => !s[1]) === i
                  ? "current"
                  : ""
            }
          >
            <span className="step-dot">{done && <Check size={16} />}</span>
            <strong>{label}</strong>
            <small>{done ? "완료" : i === 5 ? "다음 Phase" : "대기"}</small>
          </li>
        ))}
      </ol>
    </Card>
  );
}
function Evidence({ detail }: { detail: Detail }) {
  return (
    <div className="evidence-grid">
      <Card>
        <h2>수락 조건</h2>
        <p>{detail.task.description}</p>
        <ul>
          {detail.task.acceptance_criteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        <h3>테스트 결과</h3>
        {detail.tests.length ? (
          detail.tests.map((t) => (
            <p key={t.id}>
              {t.test_type} · {t.result} · {t.output}
            </p>
          ))
        ) : (
          <p className="muted">기록된 테스트가 없습니다.</p>
        )}
        <h3>산출물</h3>
        {detail.artifacts.map((a) => (
          <p key={a.id}>
            {a.type} · {a.path}
          </p>
        ))}
      </Card>
      <Card>
        <h2>상태 전이 이력</h2>
        <ol className="audit-list">
          {detail.events.map((e) => (
            <li key={e.id}>
              <b>
                {e.from_status
                  ? statusLabels[e.from_status as Task["status"]]
                  : "접수"}{" "}
                → {statusLabels[e.to_status as Task["status"]]}
              </b>
              <p>{e.reason}</p>
              <small>{new Date(e.created_at).toLocaleString("ko-KR")}</small>
            </li>
          ))}
        </ol>
      </Card>
      <Card>
        <h2>실행·비용 기록</h2>
        <ol className="audit-list">
          {detail.runs.map((r) => (
            <li key={r.id}>
              <b>{r.status}</b> · {money(r.cost_usd)}
              <p>
                입력 {r.input_tokens} / 출력 {r.output_tokens} 토큰
              </p>
              {r.error && <p>{r.error}</p>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
