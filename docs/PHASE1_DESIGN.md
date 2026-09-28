# OFFICE-001 · Phase 1 설계 검토 초안

- 상태: **Claude 설계 승인(`27f556c`) 및 사용자 착수 지시에 따라 ① 구현 진행.** 권장 사항별 반영은 [PHASE1_REVIEW_RESPONSE.md](PHASE1_REVIEW_RESPONSE.md)를 따른다.
- 작성: GPT(Codex) / 검수: Claude / 최종 병합: CEO
- 기준: [AI_OFFICE_SPEC.md](AI_OFFICE_SPEC.md) v1.1, [PHASE1_WORK_ORDER.md](PHASE1_WORK_ORDER.md)
- 우선순위: 사용자의 현재 요청 → 명세 0절 개정 사항 → Phase 1 작업지시서 → 명세의 나머지 본문.
- 이 문서의 상세 정책은 구현 제안이며, Claude 검토 결과를 반영해 확정한다.
- 저장소: `purplecrown7304-maker/purple-ai-office`, 기준 `main@5223d9a5a9c0a8e40e79c2ead28aa53a53d4007d`. README만 있는 신규 레포이며 기존 앱 코드, AGENTS.md, CLAUDE.md, 테스트, CI는 없다.

## 1. 범위와 구현 경계

Next.js App Router + TypeScript + Tailwind + shadcn/ui, Supabase Auth/PostgreSQL/Realtime으로 CEO 1명용 관제실을 만든다. 프로젝트·작업·에이전트·메시지를 실제 DB에 보관하고, Phase 1의 실행 공급자는 MockProvider 하나로 제한한다.

실제 모델 API 호출, 자체 코드 실행 Sandbox, GitHub 작업 자동화, 다중 사용자, 운영 큐 워커 선정은 포함하지 않는다. GitHub Actions가 이 레포의 빌드·테스트를 수행한다. Vercel 앱에서 빌드·테스트나 전체 에이전트 대화 루프를 실행하지 않는다.

Provider는 응답·사용량·상태 변경 요청만 반환한다. 서버가 인증, 소유권, 상태 전이, 한도, 중복 실행을 검사하고 저장한다. UI는 저장된 상태·이벤트·메시지를 표시한다. Provider 결과가 직접 UI나 DB를 변경하는 경로를 두지 않는다.

원본 두 문서는 수정 없이 먼저 별도 커밋한다. 이 설계는 다음 문서 커밋에 넣고 Draft PR로 제출한다. Claude의 `판정: 승인` 전에는 구현 PR을 시작하지 않는다.

## 2. 테이블 목록과 데이터 계약

공통 규칙: 기본 키는 UUID, 시간은 `timestamptz`, 금액은 `numeric(12,6)`이며 음수는 금지한다. 코드·slug는 사람용 식별자다. 금액은 도메인에서 정수 micro-USD로 계산하고 DB 경계에서 변환한다. 브라우저 입력의 금액·횟수·actor를 신뢰하지 않는다.

### 2.1 업무 테이블 9개

| 테이블 | 주요 열 및 추가 설계 | 제약·소유권 |
|---|---|---|
| `projects` | `id, owner_id, name, repository_url, status, default_budget_usd=5.00, created_at, updated_at` | `owner_id → auth.users`; CEO만 프로젝트 생성 가능; 상태 `ACTIVE/ARCHIVED` |
| `tasks` | `id, code, project_id, title, description, status, priority, lead_agent, reviewer_agent, acceptance_criteria, budget_usd, cost_usd=0, discussion_rounds=0, review_retries=0, fix_attempts=0, created_at, updated_at` | `code UNIQUE`; 배정 에이전트 둘 다 NOT NULL FK; **CHECK(lead_agent <> reviewer_agent)**; 수락 조건은 빈 항목 없는 문자열 배열; owner는 project를 통해 판정 |
| `task_events` | `id, task_id, from_status, to_status, actor, reason, created_at`; 추가 `actor_user_id, actor_agent_id, task_version, request_id` | 생성 시 `NULL → NEW` 포함; 이후 실제 상태 변경당 1행; append-only; `(task_id, task_version)` 유일; 작업과 같은 소유권 |
| `agents` | `id, owner_id, slug, display_name, provider, model, status, current_task_id, last_active_at` | `UNIQUE(owner_id,slug)`; GPT·Claude 기본 시드; owner 직접 판정; current task는 같은 owner의 작업; 상태 `IDLE/WORKING/REVIEWING/WAITING/ERROR/OFFLINE` |
| `agent_messages` | `id, task_id, from_agent, to_agent, type, message, requires_response, queue_status, attempts=0, processed_at, in_reply_to, created_at`; 추가 `from_role, to_role, run_id, payload, review_round, available_at, claimed_at, lease_expires_at, request_id` | 메시지 타입 12종; 큐 상태 4종; 답장은 같은 task의 메시지만 참조; CEO·system은 역할 열로 표현하고 agent FK는 NULL 허용; 역할과 FK의 일관성 CHECK |
| `agent_runs` | `id, agent_id, task_id, started_at, ended_at, status, input_tokens, output_tokens, cost_usd, provider, model, error`; 추가 `message_id, idempotency_key, response_payload, applied_at, lease_expires_at` | 호출 전 행 생성, 반환 후 사용량·결과 영속화; 토큰·금액 음수 금지; 멱등 키 UNIQUE; 같은 task에 미처리 run이 있으면 다음 호출 금지 |
| `test_results` | `id, task_id, agent_id, test_type, result, output, created_at` | 명세 24절 유지; owner는 task→project; `result=PENDING/PASS/FAIL`; 데모 결과는 `test_type=mock:*`로 명시 |
| `decisions` | `id, project_id, task_id, question, decision, reason, decided_by, created_at` | 명세 24절 유지; task는 프로젝트 단위 결정이면 NULL; 지정 시 같은 project에 속해야 함; owner는 project |
| `artifacts` | `id, task_id, agent_id, type, path, metadata, created_at` | 명세 24절 유지; owner는 task→project; 규칙 문서는 복제하지 않고 레포 경로·커밋을 metadata에 참조 |

`tasks` 추가 운영 열: `version=0`, `pause_reason`, `resume_status`, `review_round=0`, `is_demo=false`, `demo_step=0`, `demo_delay_ms=2500`, `demo_next_step_at`. `version`은 모든 작업 변경 시 증가한다. 대기 사유와 복귀 상태, 데모 진행 위치도 DB에 저장하여 새로고침·중복 요청에 대응한다.

`agent_runs.status`는 `STARTED → RECORDED → APPLIED`, 또는 `FAILED/UNKNOWN_OUTCOME`. `RECORDED`는 호출 결과와 사용량이 저장되었으나 후속 반영이 끝나지 않은 상태다. `tokens_used`와 `cost`는 각각 `input_tokens + output_tokens`, `cost_usd`로 대체한다. 이전 스키마가 존재하면 데이터 보존 마이그레이션을 별도로 설계한다.

메시지 `payload jsonb`는 타입별 검증된 구조 데이터다. REVIEW_RESULT에는 `verdict`, `review_round`, 수락 조건별 결과, `critical_bug_count`, 검토 대상 artifact 참조를 저장한다. TEST_RESULT에는 같은 round와 `test_results` ID를 연결한다. 완료 조건은 이 구조 데이터로 판정하며 자연어 본문에서 PASS라는 문자열을 찾는 방식은 사용하지 않는다. 수정 round가 바뀌면 이전 검수·테스트 증거는 완료 근거로 사용할 수 없다.

### 2.2 CEO 제한용 내부 설정 1개

`private.office_settings(singleton=true PK CHECK(singleton), ceo_user_id FK auth.users UNIQUE, created_at)`를 둔다. 배포 시 지정된 CEO UID를 등록하며, 최초 방문자가 CEO가 되는 자동 등록은 금지한다. 공개 API 스키마에 노출하지 않는다. 이 테이블도 RLS를 활성화하고 브라우저 쓰기를 허용하지 않는다.

이 설정은 로그인 여부만 확인해서 다른 Supabase 사용자가 자기 프로젝트를 생성할 수 있게 되는 허점을 막기 위한 최소 설정이다. 앱의 CEO 설정 변경 화면이나 다중 사용자 권한 모델은 만들지 않는다.

### 2.3 관계·시드·인덱스

- 프로젝트의 owner, 에이전트의 owner, 작업의 두 담당자, 메시지·실행의 agent/task, `agents.current_task_id`의 owner가 일치해야 한다. 서버 검사와 DB 참조 무결성 검사로 강제한다. 다른 작업의 답장·실행 기록을 끼워 넣을 수 없게 한다.
- GPT·Claude는 `slug=gpt/claude`, `provider=mock`, `model=mock-v1`로 등록한다. Provider 종류와 에이전트 정체성을 분리하여 둘 다 같은 MockProvider를 사용한다. 시드는 CEO 등록 뒤 멱등하게 수행한다.
- 일반 데모는 실제 프로젝트와 구분되는 데모 프로젝트에서 실행하고 화면에 데모임을 표시한다. 실제 적용 프로젝트의 첫 작업명은 명세 0.6절의 `TASK-001 적재 벤치마크 화물 세트 및 채점 스크립트 작성`을 따른다.
- FK 조회 열, `projects(owner_id)`, `tasks(project_id,status,updated_at)`, `task_events(task_id,created_at,id)`, `agent_messages(task_id,created_at,id)`, `agent_runs(task_id,started_at,id)`에 인덱스를 둔다.
- 큐에는 `(queue_status, available_at, created_at)`의 처리 대기용 인덱스를 둔다. `requires_response=false` 메시지는 생성 시 `done`, `processed_at` 지정. 처리 대상만 `pending`으로 생성한다.
- 프로젝트·작업의 삭제로 감사 기록을 지우지 않는다. Phase 1 UI에서는 프로젝트 보관, 작업 취소를 제공한다. 감사·실행·비용 이력 수정/삭제용 일반 API는 제공하지 않는다.

## 3. 상태 전이와 한도

### 3.1 단일 정의와 적용 방법

**허용 전이·역할·한도 규칙의 단일 원본은 `src/domain/task-policy.ts`**다. UI, Next.js, Supabase SDK를 import하지 않는 순수 모듈로 둔다. SQL에 같은 전이 표를 다시 작성하지 않는다.

모든 쓰기는 서버 서비스를 거친다. 인증된 사용자에게 DB 직접 DML 및 상태 변경 RPC 실행 권한을 주지 않는다. 서버는 현재 작업과 `version`을 읽고 도메인 규칙으로 변경안을 만든 뒤, 서버 전용 원자적 RPC로 적용한다. RPC는 소유권, 현재 version, 중복 request/run, FK를 확인하고 작업·횟수·비용·이벤트·메시지를 트랜잭션으로 저장한다. 충돌 시 최신 DB 상태로 다시 검증하며 Provider를 재호출하지 않는다.

### 3.2 정상 흐름

아래 열거되지 않은 전이는 거부한다. 모든 요청은 권한·소유권·한도 검사도 통과해야 한다.

| 현재 상태 | 다음 상태 | 주체·추가 조건 |
|---|---|---|
| 생성 전 | `NEW` | CEO가 유효한 수락 조건·서로 다른 담당자·예산으로 생성; 초기 이벤트 저장 |
| `NEW` | `ANALYZING` | 배정된 lead의 작업 시작 요청 |
| `ANALYZING` | `DISCUSSION` | 분석 후 질문 또는 제안이 DB에 저장됨 |
| `ANALYZING` | `PLANNED` | 질문이 필요 없으면 lead가 계획 decision을 기록하고 직행 가능; 데모는 DISCUSSION 유지 |
| `DISCUSSION` | `PLANNED` | 계획·결정 기록이 저장됨 |
| `PLANNED` | `IMPLEMENTING` | lead가 구현 시작 요청 |
| `IMPLEMENTING` | `CROSS_REVIEW` | lead가 변경 산출물과 검토 요청 제출; review round 시작 |
| `CROSS_REVIEW` | `FIXING` | **배정된 reviewer**의 해당 round `REVIEW_RESULT=FAIL` |
| `CROSS_REVIEW` | `TESTING` | **배정된 reviewer**의 해당 round `REVIEW_RESULT=PASS` |
| `FIXING` | `CROSS_REVIEW` | lead가 수정 산출물과 재검토 요청 제출; 새 review round 시작 |
| `TESTING` | `FIXING` | 현 review round 이후 테스트 FAIL 또는 검증 결함 발견 |
| `TESTING` | `WAITING_USER` | 현 round의 독립 검수 PASS와 필요한 테스트 PASS 확인; `pause_reason=FINAL_APPROVAL` |
| `WAITING_USER` | `DONE` | `FINAL_APPROVAL` 대기만 허용; CEO 승인 요청 시 증거·한도 재확인; 승인 decision과 이벤트 원자적 저장 |
| `WAITING_USER` | `FIXING` | `FINAL_APPROVAL` 상태에서 CEO가 근거와 함께 수정 요청; 새 검수 필요 |
| `DONE`, `CANCELLED` | 없음 | 종료 상태; 새 작업으로 후속 업무 생성 |

`TESTING → DONE` 직접 전이는 없다. 완료는 작업지시서 6절의 CEO 승인 단계를 따른다. 과거 round의 PASS, 구현자가 만든 자기 승인, 상태 문자열만 포함한 Provider 응답은 완료 근거로 인정하지 않는다. 데모에서 생성한 검수·테스트는 Mock임을 표시하며, 이 레포의 실제 Claude 검수나 CI 통과와 혼동하지 않는다.

### 3.3 대기·중단·복귀

정상 진행 상태 집합 `A={NEW, ANALYZING, DISCUSSION, PLANNED, IMPLEMENTING, CROSS_REVIEW, TESTING, FIXING}`로 정의한다.

| 현재 상태 | 다음 상태 | 주체·추가 조건 |
|---|---|---|
| `A` | `BLOCKED` | 담당자/서버가 구체적 장애 기록; 현재 상태를 `resume_status`에 보관 |
| `A` | `WAITING_AGENT` | 필요한 응답 대기; 메시지·기한 기록, 복귀 상태 보관 |
| `A` | `WAITING_USER` | 비용 초과 또는 CEO 결정 필요; 이유·복귀 상태 보관 |
| `A` | `ESCALATED` | 반복/메시지 한도 초과 또는 해결 불가 충돌; 이유·복귀 상태 보관 |
| `BLOCKED`, `WAITING_AGENT` | 보관된 `resume_status ∈ A` | 장애 해소/정상 응답을 서버가 검증하고 한도 재검사 |
| `BLOCKED`, `WAITING_AGENT` | `WAITING_USER`, `ESCALATED` | 비용·반복 한도 또는 사용자 결정 필요 사유가 확인됨 |
| `ESCALATED` | `WAITING_USER` | CEO가 사안을 인수하고 결정 대기로 전환; 원래 복귀 상태 유지 |
| `WAITING_USER` | 보관된 `resume_status ∈ A` | `FINAL_APPROVAL` 이외의 대기; CEO 결정으로 원인이 해소된 경우만 허용 |
| `DONE/CANCELLED` 이외 전부 | `CANCELLED` | CEO 취소; 미처리 큐와 신규 호출 정지, 이미 실행된 호출의 비용은 보존 |

대기에서 임의의 다른 정상 상태로 건너뛰는 것을 금지한다. 반복 횟수 초과는 Phase 1에서 상향·리셋하지 않는다. 해당 작업은 취소 후 후속 작업을 생성한다. 예산 초과는 CEO가 현재 비용 이상으로 작업 예산을 늘리고 decision을 남기면 복귀 가능하다. 반복 초과까지 함께 존재하면 예산만 올려서 복귀할 수 없다.

동일 상태 재요청은 전이가 아니다. 같은 request ID는 원래 결과를 반환하고 이벤트·비용·횟수를 다시 더하지 않는다. 대기 중 사유가 추가될 때에는 decision을 남기며 가짜 상태 전이 이벤트를 만들지 않는다.

### 3.4 횟수와 금액의 의미

| 항목 | 증가/산정 시점 | 경계와 자동 조치 |
|---|---|---|
| `discussion_rounds` | DISCUSSION 중 질문에 연결된 첫 유효 답변 저장 시 한 round; 같은 답변 재처리 제외 | `6`까지 허용, `>6`이면 `ESCALATED` |
| `review_retries` | 첫 검토 이후 `FIXING → CROSS_REVIEW` 재제출 시 | `3`까지 허용, `>3`이면 `ESCALATED` |
| `fix_attempts` | 수정 요청 또는 테스트 FAIL에 의해 `FIXING`에 진입할 때 | `3`까지 허용, `>3`이면 `ESCALATED` |
| `cost_usd` | 기록된 run의 비용을 run당 한 번 누적 | `>budget_usd`면 반드시 `WAITING_USER`; 신규 호출 정지 |
| Agent 메시지 수 | task의 agent 발신 메시지 DB 집계 | 명세 22절의 `20`까지 허용; 21번째를 유발하는 응답은 적용하지 않고 `ESCALATED` |

금액과 반복 한도가 동시에 초과하면 v1.1 0.3절 우선으로 `WAITING_USER`를 선택하고 모든 초과 사유를 남긴다. Provider 호출 전, 결과 기록 시, 후속 결과 적용 전, 대기 해제 시 검사한다. 한도 초과를 일으킨 실제 사용량과 응답 원문은 run에 보존하되 정상 후속 상태와 추가 응답 큐 발행은 차단한다.

정확히 예산과 같은 경우에는 비용 초과로 판정하지 않는다. 추가 유료 호출을 위한 가용 예산은 0이므로 Phase 2 이후의 유료 Provider는 호출 전 예상 비용/예약 정책을 추가해야 한다. Phase 1 Mock은 외부 과금이 없으며, 시뮬레이션 사용량을 명시하여 예산 표시·한도 검사를 검증한다. 실제 요금이 발생한 것처럼 표시하지 않는다.

## 4. 인증·RLS·권한

CEO 이메일 계정을 Supabase Auth에 사전 등록하고 셀프 회원가입을 비활성화한다. 이메일·비밀번호 로그인을 Phase 1 기본으로 하고, 로그인·세션 갱신에는 Supabase SSR 클라이언트를 사용한다. 세션 검증과 CEO UID 확인은 페이지뿐 아니라 모든 쓰기 진입점에서 수행한다. 사용자 편집 가능한 `user_metadata`, 폼의 owner/actor 값으로 권한을 판정하지 않는다.

| 접근 경로 | 허용 범위 |
|---|---|
| 비로그인 / CEO가 아닌 로그인 사용자 | 업무 테이블 읽기·쓰기, 서버 작업, 내부 RPC 모두 거부 |
| CEO의 브라우저 Supabase 클라이언트 | RLS가 허용한 본인 데이터 SELECT와 Realtime만 허용; 직접 INSERT/UPDATE/DELETE 금지 |
| CEO가 호출한 서버 서비스 | 검증된 세션 → CEO/owner 확인 → 도메인 검증 → 서버 전용 저장 연산 |
| `service_role` 서버 모듈 | RLS 우회 가능하므로 모든 대상 project/task/agent 소유권을 명시적으로 검사; 클라이언트 import 불가 |
| 내부 설정·쓰기 RPC | 브라우저에 노출하지 않음; 함수의 기본 PUBLIC EXECUTE를 취소하고 필요한 서버 권한만 부여 |

모든 업무 테이블의 RLS SELECT 조건은 **CEO UID 일치 AND 해당 row의 project owner 또는 agent owner 일치**다. `task_events`, `agent_messages`, `agent_runs`, `test_results`, `artifacts`는 task→project, `decisions`는 project로 접근한다. CEO의 쓰기 기능은 인증된 서버 경로로 제공하므로 작업지시서의 CEO 읽기·쓰기 요건을 충족한다.

CEO 확인용 `private.is_ceo()`만 제한된 읽기 전용 SECURITY DEFINER 헬퍼로 허용한다. `auth.uid()`를 내부에서 검사하고 `search_path`를 고정하며, RLS 정책 실행에 필요한 권한만 부여한다. 그 외 DB 함수는 SECURITY INVOKER를 기본으로 한다. 서버 RPC는 server role 전용 권한과 명시적인 owner 검사를 갖는다.

공개 환경변수는 Supabase URL/publishable key만 둔다. 서버 키·비밀번호는 `.env.example`에 이름과 빈 예시만 기재한다. 서버 관리 클라이언트는 `server-only` 경계를 강제하고 에러·실행 로그에도 키를 기록하지 않는다. 변경 endpoint는 입력 검증, 동일 origin/CSRF 방어, 멱등 키, 적절한 오류 코드를 갖춘다.

## 5. Provider와 서버 저장 순서

`AgentProvider.respond({ task: TaskContext, message: AgentMessage })`는 작업지시서의 `replies`, 선택적 `statusChange`, `usage`를 반환한다. `TaskContext`에는 수락 조건, 역할, 최근 메시지, 현재 round, 제한, 데모 진행 상태를 포함한다. 공급자 반환값은 서버에서 재검증한다. 에이전트 ID·발신자·검수 권한은 호출 문맥에서 결정하며 공급자가 임의로 가장할 수 없다.

| 순서 | 영속화/동작 | 실패·중복 처리 |
|---|---|---|
| 1 | 인증·owner·한도 확인 후 task 잠금/버전 검사; 큐 1건 claim; `agent_runs(STARTED)` 생성 | 중복 request는 기존 run 반환; task당 실행 중 또는 미반영 run 최대 1개 |
| 2 | 잠금을 해제하고 Provider를 **1회만** 호출 | DB 트랜잭션을 네트워크 호출 동안 열어두지 않음 |
| 3 | 응답·토큰·비용을 `agent_runs(RECORDED)`에 **먼저 커밋**; 비용을 한 번 누적; 초과 시 같은 트랜잭션에서 WAITING_USER와 이벤트 기록 | 저장 실패 시 다음 호출·후속 메시지 반영 금지; 실패 사실을 보존하고 재개 판단 |
| 4 | 저장된 응답을 읽고 최신 version·한도·역할 재검증; 메시지·전이·이벤트·데모 단계 적용; `applied_at`, run/queue 완료를 함께 커밋 | 중단 시 RECORDED 응답을 재적용; Provider 재호출·이중 비용 부과 금지 |
| 5 | Realtime이 저장된 변경을 화면에 전달 | 전송 지연/누락 시 DB 재조회로 복구 |

run의 결과 저장이 완료되기 전에는 응답 메시지·정상 진행 전이를 만들지 않는다. 다음 호출은 이전 run이 정산·반영 또는 안전하게 종결되었을 때만 허용한다. 호출 중 CEO 취소/예산 변경이 발생하면 사용량은 기록하되 취소 상태를 되돌리거나 후속 작업을 자동 진행하지 않는다.

Provider 오류는 run과 큐에 기록한다. 응답 유실로 비용·성공 여부를 알 수 없으면 `UNKNOWN_OUTCOME`으로 남기고 `WAITING_USER`로 중단한다. 오류를 성공·비용 0으로 꾸미지 않는다. 임대 만료는 상태 확인 기회이며, 외부 호출을 무조건 재실행하는 근거가 아니다.

큐 전이: `pending → processing → done/failed`. 서버가 claim 시 `attempts`를 증가시키고 lease를 기록한다. `failed → pending`은 원인 해소 및 멱등성 확인 후 명시적 재시도만 허용한다. Phase 1은 이 계약과 Mock 한 단계 처리기만 구현하며 pgmq/cron/별도 워커는 선정하지 않는다.

## 6. 데모·Realtime·화면

데모 버튼은 서버에서 데모 작업을 생성/시작한다. 브라우저의 데모 실행 제어기는 DB의 `demo_next_step_at`을 보고 짧은 `step` 요청을 보낸다. 요청 한 번은 큐 1건 또는 유효한 전이 1단계만 처리한다. 단계 지연 기본값은 2.5초이며 서버가 최소/최대 범위를 검증하고 DB에 저장한다.

여러 탭·더블 클릭은 version과 request ID로 하나의 단계만 반영한다. 탭을 닫으면 데모가 일시 정지하고 다시 열어 DB에서 이어간다. 화면이 닫혀도 계속 실행되는 운영 워커는 Phase 4 범위다. API 한 요청 안에서 sleep하며 전체 대화를 이어가지 않는다.

정상 데모:

```text
NEW → ANALYZING → DISCUSSION
  Claude QUESTION → GPT ANSWER (같은 DISCUSSION 내 DB 메시지)
→ PLANNED → IMPLEMENTING → CROSS_REVIEW
→ FIXING (Claude 수정 요청 1회)
→ CROSS_REVIEW → TESTING → WAITING_USER
→ CEO 승인 클릭 → DONE
```

시나리오의 질문·답변·수정 요청 텍스트는 서버의 MockProvider 데이터다. Provider 입력과 저장된 진행 상태로 다음 응답을 결정한다. 클라이언트는 대본/예상 상태를 재생하지 않으며 API 성공만으로 에이전트를 이동시키지 않는다.

| 경로 | 화면·주요 동작 |
|---|---|
| `/login` | CEO 이메일 로그인, 오류 표시, 로그아웃/세션 만료 처리 |
| `/` | 사무실, 작업 보드, 대화 피드, 진행 단계, 예산, 프로젝트 선택/등록, 에이전트 등록, 데모 실행; WAITING_USER를 상단에 고정 노출 |
| `/tasks/new` | 제목·설명·수락 조건·우선순위·예산·서로 다른 lead/reviewer 선택; 서버/DB에서도 검증 |
| `/tasks/[id]` | 담당자, 메시지 스레드, 상태 이벤트, 비용/사용량, 테스트 결과, 승인/수정 요청·취소·대기 사유 |
| `/agents/[slug]` | 상태, 현재 작업, 메시지, 실행 기록; 등록/설정 관리는 Phase 1의 Mock 구성만 허용 |
| `/projects/[id]` | 프로젝트 상태, 열린 작업, 결정 기록, 기본 예산 |

`tasks`, `task_events`, `agents`, `agent_messages`를 `supabase_realtime` publication에 등록한다. `realtime` 시스템 스키마를 수정하지 않는다. 클라이언트는 RLS가 적용되는 세션으로 구독한다. 초기 조회 → 구독 연결 → 재조회로 초기 공백을 보정하고, 재연결 시에도 재조회한다. 이벤트 ID/version으로 중복·늦은 이벤트를 처리하며 태스크 비용은 tasks 변경에서 읽는다.

애니메이션·말풍선·보드 이동은 DB 스냅샷과 새 이벤트 ID에서 파생한다. 로딩/빈 화면/오류/연결 끊김 상태를 제공하고 reduced-motion을 존중한다. 1280px 이상 및 390px 뷰포트에서 확인한다. 대표가 승인한 질문·수정 요청·승인 대기 시안 3장과 들썩임/타이핑/스캔선/말줄임표/메시지 꾸러미 이동 계약은 [design/README.md](design/README.md)를 ③ 구현 기준으로 사용한다.

## 7. 폴더 구조

아래는 구현 승인 후 만들 구조이며 현재 작성된 코드가 아니다.

```text
docs/
  AI_OFFICE_SPEC.md
  PHASE1_WORK_ORDER.md
  PHASE1_DESIGN.md
  reports/                     각 PR Work Report와 검수 결과 참조
src/
  app/
    layout.tsx
    login/page.tsx
    auth/                        로그인·세션 흐름
    (office)/
      layout.tsx                 인증된 CEO 레이아웃
      page.tsx
      tasks/new/page.tsx
      tasks/[id]/page.tsx
      agents/[slug]/page.tsx
      projects/[id]/page.tsx
    api/
      projects/route.ts
      agents/route.ts
      tasks/route.ts
      tasks/[id]/transition/route.ts
      tasks/[id]/approve/route.ts
      tasks/[id]/demo/start/route.ts
      tasks/[id]/demo/step/route.ts
  components/
    ui/                          shadcn/ui
    office/
    board/
    feed/
    tasks/
    projects/
    agents/
  domain/
    types.ts
    task-policy.ts               전이·역할·한도 규칙의 유일한 정의
    money.ts
    messages.ts
  server/
    auth.ts
    env.ts
    supabase/client.ts           사용자 세션 기반 조회
    supabase/admin.ts            server-only, 보호된 쓰기
    repositories/                SQL/RPC 경계, snake_case 매핑
    services/
      projects.ts
      agents.ts
      tasks.ts
      messages.ts
      runs.ts
      demo.ts
  providers/
    types.ts
    registry.ts
    mock.ts
  lib/
    supabase/browser.ts          공개 key, 조회·Realtime 전용
    realtime/                    구독·재조회·중복 제거
supabase/
  config.toml
  migrations/                    CLI로 이름을 생성한 SQL 파일
  tests/                         RLS·제약·트랜잭션 DB 검증
  seed.sql                       로컬/CI 비밀 없는 재현용 시드
tests/
  domain/
  server/
  providers/
e2e/
  phase1.spec.ts
.github/workflows/ci.yml
.env.example
README.md
package.json
  pnpm-lock.yaml
```

UI는 domain 타입을 사용하고 server/providers 구현을 import하지 않는다. 서버 진입점은 서비스를 호출하는 얇은 경계로 둔다. Supabase 타입 생성은 DB/repository 계층에 두며 domain 타입을 DB SDK에 종속시키지 않는다. 패키지와 CLI 버전은 구현 시 검증 후 고정하고 lockfile을 커밋한다.

## 8. 구현 PR 분할과 검증 기준

| PR | 범위 | 핵심 증거 |
|---|---|---|
| 설계 Draft | 원본 문서 별도 커밋 → 이 설계와 Work Report | 첨부 원문 SHA-256 일치, 요구사항 대조; Claude 설계 판정 |
| ① DB·도메인 규칙·테스트 | 최소 Next.js/TS 실행 골격, 마이그레이션, RLS, 시드 계약, domain, Vitest/DB 테스트, CI 기반 | 14개 상태의 허용/불허 전이, 역할, 경계값, FK, RLS 우회 방지, 원자성·중복 처리 테스트 |
| ② 서버·MockProvider | 인증, 프로젝트/에이전트/작업·메시지 서비스, run 저장/반영, Mock, 한 단계 데모 API | 저장 순서, 중복 요청·동시성, 실패 재개, 다른 사용자 거부, 비용 이중 합산 방지 |
| ③ 화면·Realtime·데모 | 모든 화면, DB 기반 애니메이션, 로그인, 데모 제어, 승인, Playwright, Vercel preview | 실제 로컬 Supabase 기반 전체 E2E, 두 화면 동기화, 반응형, 미리보기 데모 완주 |

①에는 CI의 build를 가능하게 하는 최소 프로젝트 골격만 포함한다. 사용자 화면은 ③에서 구현한다. 앞 PR의 Claude 검수 결과를 반영한 뒤 다음 PR을 진행하고 CEO만 병합한다. 순차 병합을 기본으로 하며 필요 시 의존 PR을 명시한 stacked PR을 사용한다. 현재 턴에서 구현 PR 3개를 빈 껍데기로 만들지 않는다.

### 테스트 매트릭스

| 분류 | 필수 검증 |
|---|---|
| Domain/Vitest | 모든 정상·예외 전이, 미허용 전이, 두 담당자 동일 거부, terminal 상태 변경 거부, lead의 자기 검수 거부, FINAL_APPROVAL 이외 DONE 거부 |
| 경계값 | 횟수 6/7, 3/4, 3/4; 금액 예산과 같음/1 micro-USD 초과; 메시지 20/21; 중복 이벤트로 횟수 증가하지 않음; 복수 한도 비용 우선 |
| DB/RLS | 비로그인·다른 사용자 모든 테이블 read/write 거부, CEO SELECT 허용, CEO 직접 DML/RPC 거부, 서버 경로 CEO 쓰기 성공, 소유권 변경/교차 참조 거부 |
| DB 트랜잭션 | task/event 원자성, 버전 충돌, 중복 request/run, 병렬 claim 중 하나만 성공, run 비용 1회 합산, FK/검수자 CHECK, append-only 감사 경로 |
| Server/Provider | run 저장 완료 전 메시지·전이 미발생, 결과 저장 실패 시 중단, RECORDED 재개 시 재호출 없음, 취소 경쟁, 호출 오류·불명확 결과 처리, 한도 초과 후 호출 차단 |
| Playwright | 실제 이메일 로그인 → 프로젝트/작업 생성 → 데모 → WAITING_USER 상단 표시 → 승인 → DONE; DB 행/이벤트/비용도 확인 |
| Realtime/UI | 다른 탭에서 변경 후 화면 반영, 재연결·새로고침, 지연/중복 이벤트, 390px/1280px, 동작 감소 설정 |
| 비밀·빌드 | typecheck, lint, unit, build; 클라이언트 번들에 서버 키와 admin 모듈이 포함되지 않음 |

GitHub Actions는 PR마다 `typecheck`, `lint`, `unit`, `build`를 수행한다. RLS/DB 검증과 E2E는 Docker 기반 임시 로컬 Supabase에서 실행하며 운영 DB 키를 사용하지 않는다. 로컬 개발 환경에서 Docker가 없더라도 CI 검증을 요구하고, 미실행 테스트를 PASS로 기록하지 않는다. E2E는 앱 인증/DB를 대체하는 mock으로 통과시키지 않는다.

## 9. Claude 검토 항목 및 남은 준비

다음 항목에 대해 `판정: 승인` / `판정: 수정 요청` / `판정: 대표 판단 필요` 중 하나와 근거를 남긴다. GPT가 Claude를 대신해 승인하지 않는다.

1. 9개 업무 테이블 + 내부 CEO 단일 설정이 충분한가.
2. domain 규칙 1곳 + 브라우저 직접 쓰기 차단 + 서버 전용 원자적 저장 구조가 적절한가.
3. 정상/대기/종료 전이 및 round 단위 검수·완료 증거가 명확한가.
4. 반복 횟수 정의, 메시지 20개 한도, 비용 우선 정책, 초과 후 복귀 정책이 명세와 일치하는가.
5. run 먼저 저장, 사용량 정산, 응답 적용, 다음 호출의 순서와 실패 복구가 충분한가.
6. 한 요청 한 단계 Mock 데모와 DB 기반 UI가 Phase 4 워커를 미리 구현하지 않고 요구를 충족하는가.
7. 3개 구현 PR의 경계 및 검증 기준이 적절한가.

현재 확인되지 않은 환경 의존성: Claude 자동 검토 채널, 신규 Supabase/Vercel 프로젝트 연결, CEO Auth UID. 승인된 화면 시안은 docs/design/에 확보했다. 실제 키·비밀번호를 문서나 PR에 붙이지 않는다.

레포 확인 결과 현재 main은 보호되지 않았고 CI/Claude 자동 검수 workflow도 없다. 현재 GitHub 연결 주체는 `purplecrown7304-maker`이므로, 이 문서 PR의 생성 자체가 명세 0.2절의 GPT/Claude 별도 App 분리 완료를 의미하지 않는다. 봇 신원과 required review/CI/강제 push 금지 설정은 실제 구현 작업 흐름의 준비 항목으로 남기고, Phase 1 앱의 GitHub 자동화 기능으로 확대하지 않는다. 본 작업에서 자기 승인·main 직접 갱신·병합은 수행하지 않는다.

## 10. 기술 근거

2026-09-28 공식 문서를 확인했다. 구현 직전 버전과 API를 다시 확인한다.

- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security): grants와 RLS를 함께 설정하고 사용자별 allow/deny를 DB 테스트로 검증한다.
- [Supabase SSR 클라이언트](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs): 브라우저·서버 클라이언트 경계를 분리한다.
- [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes): 업무 테이블 publication과 세션 기반 변경 구독에 사용한다.
- [Realtime 스키마 변경 제한](https://supabase.com/changelog/realtime-schema-locked-down-against-modification): 시스템 realtime 스키마에 사용자 테이블/함수를 만들지 않는다.
- [Extension 버전 지정 변경](https://supabase.com/changelog/extension-version-pinning-ignored): migration에서 확장 버전 강제 지정을 사용하지 않는다.
- [Next.js 프로젝트 구조](https://nextjs.org/docs/app/getting-started/project-structure): App Router의 route group, 서버/클라이언트 파일 경계를 따른다.
