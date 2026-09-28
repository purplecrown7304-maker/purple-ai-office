# PURPLE AI OFFICE

Phase 1의 **① DB·도메인 규칙·테스트** 기반입니다. 로그인·서버 서비스·MockProvider는 ②, 대시보드·Realtime UI·데모는 ③에서 연결합니다.

## 개발과 검증

Node.js 24, pnpm 11.25.0을 사용합니다. 의존성은 정확한 버전과 lockfile로 고정합니다.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test`는 domain 테스트와 PGlite의 실제 PostgreSQL 엔진에서 migration/권한/트랜잭션 테스트를 실행합니다. PGlite에서는 Supabase Auth 역할·UID 함수를 테스트용으로 생성합니다. 이 검증만으로 GoTrue/PostgREST/Realtime 서비스 검증이 완료되었다고 간주하지 않습니다.

Docker를 사용할 수 있으면 아래 명령으로 **로컬** Supabase를 시작합니다.

```sh
pnpm exec supabase start
pnpm exec supabase db reset --local
pnpm db:test:local
```

`OFFICE_TEST_DATABASE_URL`을 로컬 Supabase PostgreSQL 연결 문자열로 지정하고 `pnpm test:db`를 실행하면 같은 DB 계약 테스트를 실제 Supabase에서 수행합니다. 테스트 연결은 loopback 주소만 허용하고, 각 테스트의 CEO/다른 사용자/업무 fixture는 트랜잭션 종료 시 롤백합니다. 운영 DB를 테스트 대상으로 지정하지 마세요. GitHub Actions는 이 실제 Supabase 검증과 pgTAP 검증도 필수 job으로 실행합니다.

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
- `agent_runs` 결과 저장 → 사용량 정산 → 응답 반영 순서의 서버 통합 테스트는 ②에서 추가합니다. ①에는 저장 무결성과 불변성만 검증합니다.
- 앱 기본 페이지는 빌드 확인용입니다. API·인증 없는 이 단계에서 업무 DB를 읽거나 쓰지 않습니다.

## 문서

- [명세 v1.1](docs/AI_OFFICE_SPEC.md)
- [Phase 1 작업지시서](docs/PHASE1_WORK_ORDER.md)
- [설계](docs/PHASE1_DESIGN.md)
- [Claude 권장 사항 반영표](docs/PHASE1_REVIEW_RESPONSE.md)
- [① Work Report](docs/reports/OFFICE-001-db-domain.md)
