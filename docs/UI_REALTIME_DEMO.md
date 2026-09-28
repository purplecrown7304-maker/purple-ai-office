# Phase 1 화면·Realtime·데모

기준: `docs/design/`의 승인 시안 3장. 구현자 GPT / 검수자 Claude.

## 화면과 실행

- CEO 이메일 로그인 후 대시보드, 작업 생성/상세, 에이전트 상세, 프로젝트 상세에 접근합니다. 페이지와 API 모두 CEO를 확인합니다.
- 프로젝트·에이전트는 `/setup`에서 등록합니다. 기존 `setup:ceo` 시드도 사용할 수 있습니다.
- 작업 생성 시 구현자/검수자, 수락 조건, 우선순위, 예산, 단계 간격(기본 2500ms)을 지정합니다.
- ‘데모 실행’은 DB의 `demo_next_step_at`에 맞춰 한 번에 한 step API만 요청합니다. 숨겨진 탭, 끊어진 Realtime, 대표 대기, 한도/예산 초과에서는 진행하지 않습니다.
- 실행 재생 여부는 현재 탭의 요청 제어입니다. 상태·단계·대화·비용은 전부 서버와 DB가 결정합니다. 새로고침하면 자동 재생은 멈춥니다.
- 일시정지는 DB에 남습니다. 이미 호출 중인 응답은 기록 후 적용을 보류합니다.
- ‘처음부터’는 새 작업을 만들고 원래 감사 기록을 보존합니다.
- ‘승인하고 완료’는 작업의 DONE 전이이며 GitHub 병합/배포를 실행하지 않습니다.
- 모의 비용을 명시합니다. 실제 AI 호출은 없습니다.

## Realtime과 애니메이션

`tasks, task_events, agents, agent_messages` 네 테이블을 구독합니다. 이벤트는 직렬화된 서버 스냅샷 조회를 유발하며 조회 도중 수신된 이벤트도 다음 조회에 반영합니다. 연결/재연결/탭 복귀 시 전체 스냅샷으로 누락을 복구하고 메시지 ID 기준선을 다시 잡습니다.

신규 DB 메시지 ID만 두 담당 에이전트 사이에서 꾸러미로 재생합니다. 동일 메시지의 큐 상태 UPDATE는 다시 재생하지 않습니다. 초기 로딩/재연결의 과거 대화는 재생하지 않습니다. 순서는 created_at, id 기준입니다.

담당 에이전트의 current_task_id와 WORKING/REVIEWING, 작업 상태가 구현/수정이면 타이핑, 분석/교차검수이면 스캔선을 결정합니다. 신규 QUESTION/ANSWER는 말줄임표를 표시합니다. 움직이는 에이전트만 들썩이고 대기/완료/취소/정지 상태는 움직임을 멈춥니다. `prefers-reduced-motion`에서는 움직임 없이 텍스트로 상태를 전달합니다.

HTTP 런타임 MockProvider만 호출당 650ms의 취소 가능한 모의 처리 지연을 사용합니다. 이 시간 동안 실제 DB STARTED run과 에이전트 WORKING/REVIEWING을 관찰할 수 있습니다. 테스트의 기본 MockProvider는 지연 0ms입니다.

## PR #3 권장 1~4

1. STALE_RUN_CONTEXT: 응답은 버리고 이미 기록된 사용량은 유지합니다. run을 APPLIED로 정산하고 WAITING_USER(DECISION)로 전환합니다. decision 기록에 폐기 사유를 남기며 대표 재개 시 현재 단계의 새 입력을 생성합니다.
2. 조회: 상세/목록은 repeatable read, read only 스냅샷입니다. SELECT FOR UPDATE를 제거해 실행 TX를 막지 않습니다.
3. 코드: 프로젝트별 TASK-001 순번, private.task_counters로 동시 생성 충돌 방지. 기존 UUID 코드는 감사 보존을 위해 변경하지 않습니다.
4. 예산: 해결 전 resume은 BUDGET_STILL_EXCEEDED 오류이며 대표 결정/상태를 기록하지 않습니다. UI는 예산 변경과 재개를 분리합니다.

## 검증

- Vitest: 상태 규칙/DB/RLS/서버 + 권장 1~4 회귀 + 메시지 중복/재접속/상태별 표시.
- CI 임시 Supabase: 실제 PostgreSQL·GoTrue·RLS·Realtime, production Next 서버.
- Playwright: 로그인 → 생성·배정 → 질문 → 일시정지·새로고침 → 수정 요청 → 승인 대기 → 승인 → DONE, 다른 탭의 Realtime 반영, 상세 페이지, 390px/reduced-motion, 새 데모의 감사 보존, 로그아웃.
- CI artifact `office-ui-screenshots`: 질문/수정/승인 데스크톱과 승인 모바일.

전용 Supabase/Vercel 프로젝트가 아직 없다는 대표 답변에 따라 호스팅 리소스는 생성하지 않았습니다. Vercel 미리보기 검증은 환경 연결 후 수행해야 하며 완료로 간주하지 않습니다.

