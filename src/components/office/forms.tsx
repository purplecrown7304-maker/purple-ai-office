"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useOffice } from "../../lib/office/use-office";
import { api, errorMessage } from "../../lib/office/api";
import type { Task } from "../../lib/office/types";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
export function TaskForm() {
  const { data, loading, error } = useOffice();
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [lead, setLead] = useState("");
  return (
    <main className="form-shell">
      <Link href="/">← 오피스</Link>
      <h1>새 작업</h1>
      <p className="muted">
        할 일과 완료 기준을 알려 주세요. 구현과 검수는 서로 다른 에이전트에게
        맡깁니다.
      </p>
      <Card>
        {loading ? (
          <p>목록을 불러오는 중…</p>
        ) : !data.projects.length || data.agents.length < 2 ? (
          <p>
            <Link href="/setup">
              먼저 프로젝트와 에이전트 2명을 등록해 주세요.
            </Link>
          </p>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFailure("");
              const f = new FormData(e.currentTarget);
              try {
                const t = await api<Task>("tasks", {
                  projectId: f.get("project"),
                  title: f.get("title"),
                  description: f.get("description"),
                  acceptanceCriteria: String(f.get("criteria"))
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  leadAgent: f.get("lead"),
                  reviewerAgent: f.get("reviewer"),
                  priority: f.get("priority"),
                  budgetUsd: f.get("budget"),
                  isDemo: true,
                  delayMs: Number(f.get("delay")),
                });
                router.push("/?task=" + t.id);
              } catch (err) {
                setFailure(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              프로젝트
              <select name="project" required>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              제목
              <Input
                name="title"
                required
                maxLength={200}
                placeholder="예: 적재 벤치마크 화물 세트"
              />
            </label>
            <label>
              설명
              <Textarea name="description" maxLength={8000} />
            </label>
            <label>
              수락 조건 (한 줄에 하나)
              <Textarea
                name="criteria"
                required
                placeholder="정상·경계·실패 사례를 모두 검증한다"
              />
            </label>
            <div className="form-row">
              <label>
                구현 에이전트
                <select
                  name="lead"
                  required
                  defaultValue=""
                  onChange={(e) => setLead(e.target.value)}
                >
                  <option value="" disabled>
                    선택하세요
                  </option>
                  {data.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                검수 에이전트
                <select name="reviewer" required defaultValue="">
                  <option value="" disabled>
                    선택하세요
                  </option>
                  {data.agents.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.id === lead}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                우선순위
                <select name="priority" defaultValue="MEDIUM">
                  <option value="LOW">낮음</option>
                  <option value="MEDIUM">보통</option>
                  <option value="HIGH">높음</option>
                  <option value="CRITICAL">긴급</option>
                </select>
              </label>
              <label>
                예산 (USD)
                <Input
                  name="budget"
                  type="number"
                  required
                  min="0"
                  max="999999"
                  step="0.01"
                  defaultValue="5.00"
                />
              </label>
              <label>
                단계 간격 (ms)
                <Input
                  name="delay"
                  type="number"
                  min="0"
                  max="10000"
                  step="100"
                  defaultValue="2500"
                  required
                />
              </label>
            </div>
            <p className="muted">
              Phase 1에서는 Mock Provider로 실행됩니다. 생성 후 ‘데모 실행’을
              누르면 시작합니다.
            </p>
            <Button type="submit" disabled={busy}>
              {busy ? "생성 중…" : "작업 만들기"}
            </Button>
          </form>
        )}
        {(error || failure) && (
          <p className="form-error" role="alert">
            {failure || error}
          </p>
        )}
      </Card>
    </main>
  );
}
export function SetupForm() {
  const { data, refresh } = useOffice();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit(path: string, body: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(path, body);
      await refresh();
      setMessage("등록했습니다.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="form-shell">
      <Link href="/">← 오피스</Link>
      <h1>오피스 준비하기</h1>
      <p className="muted">프로젝트와 에이전트를 등록합니다.</p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <Card>
        <h2>프로젝트 등록</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void submit("projects", {
              name: f.get("name"),
              ...(f.get("url") ? { repositoryUrl: f.get("url") } : {}),
            });
          }}
        >
          <label>
            프로젝트 이름
            <Input name="name" required maxLength={200} />
          </label>
          <label>
            저장소 URL (선택)
            <Input name="url" type="url" />
          </label>
          <Button disabled={busy}>프로젝트 등록</Button>
        </form>
        <ul>
          {data.projects.map((p) => (
            <li key={p.id}>
              <Link href={"/projects/" + p.id}>{p.name}</Link>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h2>에이전트 등록</h2>
        <p className="muted">
          GPT와 Claude도 여기서 등록할 수 있습니다. 모든 에이전트는 Mock
          Provider를 사용합니다.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void submit("agents", {
              slug: f.get("slug"),
              displayName: f.get("name"),
            });
          }}
        >
          <label>
            식별자
            <Input
              name="slug"
              placeholder="gpt 또는 claude"
              pattern="[a-z][a-z0-9-]{0,39}"
              required
            />
          </label>
          <label>
            표시 이름
            <Input
              name="name"
              placeholder="GPT 또는 Claude"
              maxLength={200}
              required
            />
          </label>
          <Button disabled={busy}>에이전트 등록</Button>
        </form>
        <ul>
          {data.agents.map((a) => (
            <li key={a.id}>
              <Link href={"/agents/" + a.slug}>{a.display_name}</Link> ·{" "}
              {a.status}
            </li>
          ))}
        </ul>
      </Card>
      <Link className="button button-primary" href="/tasks/new">
        새 작업 만들기
      </Link>
    </main>
  );
}
