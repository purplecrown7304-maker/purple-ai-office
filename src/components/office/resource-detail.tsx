"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/office/api";
import { money, statusLabels } from "../../lib/office/presentation";
import type {
  Agent,
  Message,
  Project,
  Run,
  Task,
} from "../../lib/office/types";
import { Card } from "../ui/card";
import { Feed } from "./feed";
type Resource = {
  project?: Project;
  agent?: Agent;
  tasks?: Task[];
  messages?: Message[];
  runs?: Run[];
  decisions?: { id: string; decision: string; created_at: string }[];
};
export function ResourceDetail({
  kind,
  id,
}: {
  kind: "projects" | "agents";
  id: string;
}) {
  const [data, setData] = useState<Resource | null>(null),
    [agents, setAgents] = useState<Agent[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Resource>(kind + "/" + encodeURIComponent(id)),
      api<Agent[]>("agents"),
    ]).then(
      ([d, a]) => {
        if (active) {
          setData(d);
          setAgents(a);
        }
      },
      (e) => {
        if (active) setError(errorMessage(e));
      },
    );
    return () => {
      active = false;
    };
  }, [kind, id]);
  return (
    <main className="form-shell wide">
      <Link href="/">← 오피스</Link>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p>불러오는 중…</p>
      ) : (
        <>
          <h1>{data.project?.name ?? data.agent?.display_name}</h1>
          <Card>
            <h2>현재 상태</h2>
            <p>{data.project?.status ?? data.agent?.status}</p>
            {data.project && (
              <>
                <p>기본 예산 {money(data.project.default_budget_usd)}</p>
                <p>{data.project.repository_url}</p>
              </>
            )}
            {data.agent && (
              <>
                <p>
                  Provider: {data.agent.provider} / {data.agent.model}
                </p>
                <p>
                  현재 작업:{" "}
                  {data.agent.current_task_id ? (
                    <Link href={"/tasks/" + data.agent.current_task_id}>
                      작업 보기
                    </Link>
                  ) : (
                    "대기"
                  )}
                </p>
              </>
            )}
          </Card>
          {data.tasks && (
            <Card>
              <h2>작업</h2>
              <ul>
                {data.tasks.map((t) => (
                  <li key={t.id}>
                    <Link href={"/tasks/" + t.id}>
                      {t.code} · {t.title}
                    </Link>{" "}
                    · {statusLabels[t.status]}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {data.decisions && (
            <Card>
              <h2>결정 기록</h2>
              {data.decisions.length ? (
                data.decisions.map((d) => (
                  <p key={d.id}>
                    {d.decision}{" "}
                    <small>
                      {new Date(d.created_at).toLocaleString("ko-KR")}
                    </small>
                  </p>
                ))
              ) : (
                <p>아직 결정 기록이 없습니다.</p>
              )}
            </Card>
          )}
          {data.messages && (
            <Feed messages={data.messages} agents={agents} all />
          )}
          {data.runs && (
            <Card>
              <h2>실행 기록</h2>
              <ul>
                {data.runs.map((r) => (
                  <li key={r.id}>
                    {r.status} · {money(r.cost_usd)} · 입력 {r.input_tokens} /
                    출력 {r.output_tokens} 토큰
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </main>
  );
}
