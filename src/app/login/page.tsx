"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "../../lib/office/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
export default function Login() {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <main className="login-shell">
      <div className="login-brand">
        <span className="brand-mark">P</span>
        <p className="eyebrow">PURPLE AI OFFICE</p>
        <h1>
          우리 AI 팀의
          <br />
          작은 오피스
        </h1>
        <p>
          대화에서 구현, 검수와 승인까지.
          <br />
          에이전트가 하는 일을 한곳에서 확인하세요.
        </p>
      </div>
      <section className="card login-card">
        <h2>대표 로그인</h2>
        <p className="muted">등록된 대표 계정으로 입장해 주세요.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api("login", {
                email: form.get("email"),
                password: form.get("password"),
              });
              router.replace("/");
              router.refresh();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            이메일
            <Input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            비밀번호
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <Button disabled={busy} type="submit">
            {busy ? "입장하는 중…" : "오피스 입장"}
          </Button>
        </form>
        <small className="muted">
          이 오피스는 등록된 대표 1명만 이용할 수 있습니다.
        </small>
      </section>
    </main>
  );
}
