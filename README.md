# PURPLE AI OFFICE

Phase 1의 DB·도메인·서버·MockProvider와 **③ 화면·Realtime·데모**를 구현합니다. CEO 로그인 후 프로젝트와 작업을 만들고, 실제 DB에 기록되는 에이전트 대화·검수·비용을 오피스에서 확인할 수 있습니다.

## 개발과 검증

Node.js 24, pnpm 11.25.0을 사용합니다. 의존성은 정확한 버전과 lockfile로 고정합니다.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`.env.example`을 참고해 전용 Supabase의 공개 URL/키, 서버 전용 DATABASE_URL, 앱 주소 APP_ORIGIN을 설정하고 아래 CEO 최초 등록을 마친 뒤 `pnpm dev`로 실행합니다. `/setup`에서 프로젝트를 등록하고 `/tasks/new`에서 작업을 생성한 다음 ‘데모 실행’을 누릅니다. 기본 간격은 2500ms이며 ‘승인하고 완료’는 작업을 DONE으로 전환합니다.

CI는 임시 Supabase와 production Next 서버에서 Playwright 로그인·생성·Realtime·일시정지·승인·모바일 흐름을 실행합니다. 스크린샷은 `office-ui-screenshots` artifact에 저장합니다. 전용 Supabase/Vercel 프로젝트가 아직 없어 호스팅된 미리보기 검증은 남아 있습니다.

`pnpm test`는 domain 테스트와 PGlite의 실제 PostgreSQL 엔진에서 migration/권한/트랜잭션 테스트를 실행합니다. PGlite에서는 Supabase Auth 역할·UID 함수를 테스트용으로 생성합니다. 이 검증만으로 GoTrue/PostgREST/Realtime 서비스 검증이 완료되었다고 간주하지 않습니다.

Docker를 사용할 수 있으면 아래 명령으로 **로컬** Supabase를 시작합니다.

```sh
pnpm exec supabase start
pnpm exec supabase db reset --local
pnpm db:test:local
```

`OFFICE_TEST_DATABASE_URL`을 임시 로컬 Supabase PostgreSQL 연결 문자열로, `OFFICE_TEST_DISPOSABLE=1`을 명시하고 `pnpm test:db`를 실행하면 DB 계약·서비스 통합 테스트를 실제 Supabase에서 수행합니다. 테스트 연결은 loopback만 허용합니다. ① 계약 fixture는 롤백하고, ② 서비스 suite는 독립 커밋·동시 요청을 검증하기 위해 **빈 임시 DB에서만** fixture를 초기화합니다. 기존 데이터가 있는 개발/운영 DB에서 실행하지 마세요. GitHub Actions는 실제 Supabase·pgTAP·Auth/HTTP 검증을 필수 job으로 실행합니다.

## CEO 최초 등록

1. 대상 환경에서 migration을 검토·적용합니다. 이번 PR 자체는 원격 프로젝트에 적용하지 않습니다.
2. Supabase Auth에서 사용할 CEO 이메일 계정을 사전 생성/초대하고 이메일 확인을 완료합니다. 셀프 회원가입과 anonymous sign-in은 비활성화합니다. 로컬 config에도 동일하게 지정되어 있습니다.
3. 신뢰할 수 있는 서버 터미널에서 `CEO_EMAIL`과 관리자용 `DATABASE_URL`을 환경변수로 설정합니다. 값은 Git, PR, 채팅에 올리지 않습니다.
4. `pnpm setup:ceo`를 실행합니다. 기존 Auth 계정을 조회하여 `private.office_settings`에 UID를 등록하고 GPT·Claude Mock 에이전트를 생성합니다.

스크립트는 전체 작업을 트랜잭션으로 처리하고 advisory lock으로 중복 설정을 직렬화합니다. 재실행은 멱등하며 다른 CEO로 교체하지 않습니다. 신규 Auth 사용자나 기본 비밀번호를 자동 생성하지 않습니다. UID는 migration에 하드코딩하지 않습니다. 운영 환경별로 따로 실행합니다.

## 핵심 경계

- 전이·역할·한도: `src/domain/task-policy.ts`가 유일한 정책 원본입니다. PostgreSQL에 같은 전이 표를 복제하지 않습니다.
- 브라우저: CEO 자신이 소유한 데이터만 읽을 수 있고 모든 직접 DML/RPC 쓰기는 금지됩니다.
- 서버 전용 `apply_task_transition`: owner, version, 종료 상태, 회계 불변식을 검사하고 task/event를 함께 저장합니다. ② 서비스가 도메인 검증 후 호출해야 합니다. 이 RPC 자체가 전체 전이 정책을 검사하는 것은 아닙니다.
- 감사: task_events/decisions는 append-only, RECORDED run의 비용/응답은 불변, APPLIED/FAILED/UNKNOWN_OUTCOME run은 전체 불변입니다. service_role의 TRUNCATE 권한도 없습니다.
- 작업 생성 후 lead/reviewer, 수락 조건, code, is_demo는 DB에서 불변입니다. 바꾸려면 취소 후 새 작업을 생성합니다.
- test_results/artifacts도 append-only입니다. PENDING 결과의 완료나 재시험은 기존 행 수정 대신 새 증거 행을 추가합니다. 서버는 현재 검수 round와 증거 ID를 명시적으로 선택해야 합니다.
- agent_messages는 삭제할 수 없고 queue_status, attempts, processed_at, claimed_at, lease_expires_at, available_at, run_id만 갱신할 수 있습니다.
- WAITING_USER/UNKNOWN_OUTCOME은 Phase 1에서 CEO 취소만 허용합니다. 예산 변경·한도 재검사로 재개할 수 없으며 run 해결 정책은 Phase 2 범위입니다.
- `agent_runs` 결과 저장 → 사용량 정산 → 응답 반영은 별도 커밋으로 분리하고 통합 테스트로 검증합니다. UNKNOWN_OUTCOME run과 task의 대기 상태는 함께 커밋합니다.
- UI는 DB 스냅샷과 Realtime을 읽습니다. 데모 타이머는 한 step API만 요청하며 상태·대화·비용을 자체 생성하지 않습니다. ‘처음부터’는 이전 감사 기록을 보존하는 새 작업 생성입니다.

## 문서

- [명세 v1.1](docs/AI_OFFICE_SPEC.md)
- [Phase 1 작업지시서](docs/PHASE1_WORK_ORDER.md)
- [설계](docs/PHASE1_DESIGN.md)
- [Claude 권장 사항 반영표](docs/PHASE1_REVIEW_RESPONSE.md)
- [대표 승인 화면 시안·DB 기반 애니메이션 기준](docs/design/README.md)
- [① Work Report](docs/reports/OFFICE-001-db-domain.md)
- [② 서버 API·실패 복구 계약](docs/SERVER_API.md)
- [② Work Report](docs/reports/OFFICE-001-server-mock.md)
- [③ 화면·Realtime·데모 및 PR #3 권장 1~4 반영](docs/UI_REALTIME_DEMO.md)
