# PURPLE AI OFFICE · Phase 1 작업지시서

- Task: `OFFICE-001 AI Office 기본 서버와 대시보드`
- 구현: GPT / 검수: Claude / 최종 승인: CEO
- 상위 명세: `AI_OFFICE_SPEC.md` v1.1 (0절 개정 사항이 본문보다 우선)
- 레포: `purple-ai-office` (신규) / DB: 신규 Supabase 프로젝트 / 배포: Vercel

---

## 1. 목표

AI API를 아직 호출하지 않는 상태에서, **프로젝트·작업·에이전트·메시지를 DB에 기록하고 대시보드에서 실시간으로 보는 관제실**을 만든다.
Phase 2~4에서 실제 GPT·Claude를 연결할 때 **UI와 DB를 고치지 않고 Provider만 추가**하면 되도록 구조를 잡는 것이 핵심이다.

## 2. 범위

### 포함
1. Next.js(App Router) + TypeScript + Tailwind + shadcn/ui 프로젝트 구조
2. Supabase 마이그레이션: 명세 24절 테이블 + 아래 3절 보강
3. CEO 로그인 (Supabase Auth, 이메일). CEO 1명만 접근
4. 프로젝트 등록, 작업 생성·배정, 상태 전이
5. 에이전트 등록 (GPT, Claude 기본 시드) 및 상태 표시
6. Agent 간 메시지 모델 (큐로 쓸 수 있는 구조)
7. Provider Adapter 인터페이스 + **Mock Provider** 1개
8. 대시보드: 애니메이션 사무실, 작업 보드, AI 대화 피드, 진행 단계, 예산 막대 (디자인 시안 참고)
9. **데모 시나리오 실행 버튼**: Mock Provider가 실제 DB에 메시지·상태 변경을 기록하고, 대시보드는 그 DB 변경만 보고 움직인다
10. 단위 테스트, E2E 스모크, GitHub Actions CI

### 제외 (다음 Phase)
- 실제 OpenAI·Anthropic API 호출
- 큐 워커 구동 방식 확정 (pgmq/pg_cron/Edge Function 등)
- GitHub 브랜치·PR 자동 생성, 봇 계정 연동
- 다중 사용자, 팀 권한

## 3. DB 요구사항 (24절 보강)

마이그레이션은 `supabase/migrations/`에 SQL 파일로 둔다. 대시보드에서 직접 스키마를 바꾸지 않는다.

| 테이블 | 24절 대비 추가·변경 |
|---|---|
| `projects` | `owner_id`(auth.users), `default_budget_usd numeric default 5.00` |
| `tasks` | `code text unique`(예: `TASK-001`), `acceptance_criteria jsonb`, `budget_usd`, `cost_usd numeric default 0`, `discussion_rounds int`, `review_retries int`, `fix_attempts int`. **`lead_agent <> reviewer_agent` CHECK 제약** |
| `task_events` (신규) | 상태 전이 기록: `task_id, from_status, to_status, actor, reason, created_at`. 보드 애니메이션과 감사 기록에 사용 |
| `agents` | `slug`(`gpt`, `claude`) unique, `display_name`, `status` enum, `current_task_id`. GPT·Claude 시드 |
| `agent_messages` | `type` enum(9절 12종), `queue_status` enum(`pending`, `processing`, `done`, `failed`), `attempts int`, `processed_at`, `in_reply_to` |
| `agent_runs` | `input_tokens`, `output_tokens`, `cost_usd`, `provider`, `model`, `error` |
| `test_results`, `decisions`, `artifacts` | 24절 그대로 + `owner_id` 경로로 접근 제어 |

필수 규칙:
- **task status enum**: 7절의 전체 상태(`NEW … DONE`, `FIXING`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `ESCALATED`, `CANCELLED`).
- **허용된 상태 전이만** 가능해야 한다. 전이 표를 한 곳(DB 함수 또는 서버 모듈)에 정의하고, 불허 전이는 에러. 모든 전이는 `task_events`에 기록.
- **한도 초과 시 자동 전환**: `discussion_rounds > 6`, `review_retries > 3`, `fix_attempts > 3`, `cost_usd > budget_usd` 중 하나라도 해당하면 `ESCALATED` 또는 `WAITING_USER`로 전환 (명세 11·22절, 0.3절).
- **RLS 모든 테이블 활성화**. 로그인한 CEO(프로젝트 owner)만 읽기·쓰기. `service_role` 키는 서버 코드에서만 사용하고 클라이언트 번들에 절대 포함하지 않는다.
- Realtime: `tasks`, `task_events`, `agents`, `agent_messages` 변경을 대시보드가 구독.

## 4. 코드 구조 요구사항

```
src/
  app/                 페이지와 라우트
  components/          UI (office/, board/, feed/ ...)
  domain/              타입, 상태 전이 표, 한도 규칙 (UI·DB 의존 없음)
  server/              Supabase 서버 클라이언트, 작업·메시지 서비스
  providers/
    types.ts           AgentProvider 인터페이스
    mock.ts            MockProvider
supabase/migrations/
tests/                 (또는 *.test.ts 병치)
e2e/
```

`AgentProvider` 인터페이스 최소 형태:

```ts
interface AgentProvider {
  id: 'gpt' | 'claude' | string;
  respond(input: {
    task: TaskContext;          // 작업, 수락 조건, 최근 메시지, 역할(lead/reviewer)
    message: AgentMessage;      // 응답할 메시지
  }): Promise<{
    replies: NewAgentMessage[]; // 상대 에이전트 또는 CEO에게 보낼 메시지
    statusChange?: TaskStatus;  // 요청할 상태 전이 (서버가 전이 표로 검증)
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
  }>;
}
```

- 에이전트는 상태를 직접 바꾸지 않고 **요청**만 한다. 서버가 전이 표와 한도로 검증한 뒤 적용.
- Provider 호출 결과는 **먼저 `agent_runs`에 기록**하고, 그다음 메시지·상태를 반영 (0.3절).

## 5. 화면 요구사항

| 경로 | 내용 |
|---|---|
| `/` | 대시보드: 애니메이션 사무실(두 에이전트 상태·말풍선·메시지 이동), 작업 보드, AI 대화 피드, 진행 단계, 예산 막대, 대표 승인 대기 알림 |
| `/tasks/new` | 작업 생성: 제목, 설명, 수락 조건, 구현·검수 에이전트 선택(같은 에이전트 선택 불가), 우선순위, 예산 |
| `/tasks/[id]` | 28절 화면: 상태, 담당, 메시지 스레드, 상태 전이 이력, 비용, 테스트 결과 |
| `/agents/[slug]` | 26절 화면 (Phase 1은 상태, 현재 작업, 메시지, 실행 기록) |
| `/projects/[id]` | 27절 화면 (Phase 1은 상태, 열린 작업, 결정 기록) |

- 디자인 참고: 대표가 승인한 "PURPLE AI OFFICE" 캔버스 시안. 애니메이션은 **DB 상태에서 파생**해야 하며, 화면 안에 대본을 하드코딩하지 않는다.
- 데스크톱 1280px 이상 기준, 모바일(390px)에서 깨지지 않을 것.
- 대표 승인 대기(`WAITING_USER`) 작업은 대시보드 상단에 항상 보이게.

## 6. 데모 시나리오

`/` 또는 `/tasks/[id]`에 "데모 실행" 버튼. MockProvider로 아래 흐름을 **실제 DB 기록으로** 재생한다.

NEW → ANALYZING → DISCUSSION(Claude 질문, GPT 답변) → PLANNED → IMPLEMENTING → CROSS_REVIEW → FIXING(수정 요청 1회) → CROSS_REVIEW → TESTING → WAITING_USER → (CEO 승인 클릭) → DONE

- 각 단계 사이 지연은 설정 가능 (기본 2~3초).
- 데모 중 발생한 메시지·전이·비용도 일반 작업과 똑같이 테이블에 남는다.

## 7. 테스트·CI

- 단위 테스트(Vitest):
  - 허용 전이 성공 / 불허 전이 거부
  - 구현자 = 검수자 작업 생성 거부
  - 각 한도(토론 6, 검수 3, 수정 3, 예산) 초과 시 자동 전환
  - MockProvider 응답이 `agent_runs` 기록 후 반영되는 순서
- RLS 테스트: 비로그인·다른 사용자는 읽기·쓰기 불가
- E2E(Playwright): 로그인 → 작업 생성 → 데모 실행 → WAITING_USER 표시 → 승인 → DONE
- GitHub Actions: PR마다 typecheck, lint, unit, build. E2E는 가능하면 포함
- `.env.example` 제공. 실제 키는 커밋 금지

## 8. 완료 조건 (Claude가 검수할 기준)

- [ ] 2절 "포함" 1~10 모두 구현
- [ ] 3절 필수 규칙 전부 DB 또는 서버에서 **강제**됨 (UI 검사만으로는 불합격)
- [ ] `service_role` 키가 클라이언트 번들에 없음
- [ ] 대시보드 애니메이션이 DB Realtime 변경만으로 움직임
- [ ] 7절 테스트 전부 통과, CI 녹색
- [ ] Vercel 미리보기에서 데모 시나리오 끝까지 동작
- [ ] 테스트 삭제·우회, 임시 하드코딩으로 통과시킨 부분 없음 (33절)
- [ ] PR 본문에 17절 Work Report 형식의 보고서

## 9. 진행 방식

1. 구현 전에 **설계 요약**(테이블 목록, 전이 표, 폴더 구조)을 PR 초안이나 이슈에 먼저 올린다. Claude가 설계를 검토한 뒤 구현한다.
2. 한 번에 거대한 PR 하나보다, 가능하면 다음 순서로 나눈다: ① DB·도메인 규칙·테스트 ② 서버 서비스·MockProvider ③ 화면·Realtime·데모.
3. 각 PR은 Claude가 검수하고, 판정은 `판정: 승인` / `판정: 수정 요청` / `판정: 대표 판단 필요` 중 하나.
4. 의문은 CEO보다 Claude에게 먼저 묻는다 (4절 RULE 4). 외부 계정·권한·비용 결정만 CEO에게.
