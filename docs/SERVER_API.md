# ② 서버·MockProvider 계약

기준 main: `0255259` (PR #1·#2 병합). 이 PR은 인증·업무 서비스·Provider·큐 한 단계 실행을 연결한다. 화면, 브라우저 Realtime 구독과 Playwright는 ③에서 구현한다.

## 실행 환경과 인증

`.env.example`의 Supabase URL/publishable key, `DATABASE_URL`, 정확한 `APP_ORIGIN`을 설정한다. `DATABASE_URL`은 서버 전용이며 `SET LOCAL ROLE service_role`을 지원하는 Supabase 직접 연결 또는 transaction pooler 연결을 사용한다. 원격 연결은 TLS를 유지한다. API 키 기반 admin REST 호출 대신 PostgreSQL 트랜잭션으로 다중 테이블 기록을 원자화한다. 서버의 모든 업무 트랜잭션은 service_role로 권한을 낮추고, CEO UID와 대상 owner를 다시 검사한다. 일반 브라우저의 DB 쓰기 권한은 계속 없다.

기존 확인된 Auth 사용자를 `pnpm setup:ceo`로 등록한다. 로그인·로그아웃 API는 Supabase SSR cookie client를 사용하고 모든 업무 요청에서 `auth.getUser()`로 사용자를 검증한다. JWT/user_metadata의 CEO 주장을 신뢰하지 않는다. SSR 페이지·Proxy와 로그인 화면은 ③에서 이 API에 연결한다. API에서 갱신된 쿠키는 응답에 반영되고 모든 응답은 private/no-store다.

로컬 `[auth].enable_signup=false`는 유지하고 `[auth.email].enable_signup=true`로 기존 사용자의 이메일 로그인을 켠다. CLI의 이메일 옵션은 [GOTRUE_EXTERNAL_EMAIL_ENABLED로 매핑](https://github.com/supabase/cli/blob/main/apps/cli/src/commands/start/services/gotrue.service.ts)되어 false이면 로그인까지 비활성화한다. CI는 실제 신규 가입이 `signup_disabled`로 거부되는 것도 확인한다.

쓰기 요청은 `POST`, `Content-Type: application/json`, `Origin: APP_ORIGIN`, `Idempotency-Key: UUID`가 필요하다. 로그인·로그아웃만 멱등 키를 요구하지 않는다. body는 64 KiB 제한이며 알 수 없는 필드(actor, owner, 임의 증거 포함)를 거부한다. 업무 명령의 키는 owner 전체에서 유일하고, 같은 키·다른 명령은 409다. SQL/Provider 오류 원문·비밀은 응답에 포함하지 않는다.

## API

| 경로 | 메서드 / 입력 | 결과 |
|---|---|---|
| `/api/login` | POST `{email,password}` | CEO만 세션 유지; 비CEO 로그인은 즉시 로그아웃 후 403 |
| `/api/logout` | POST `{}` | 세션 종료 |
| `/api/session` | GET | 검증된 CEO userId |
| `/api/projects` | GET / POST `{name,repositoryUrl?,budgetUsd?}` | 목록 / 프로젝트 생성 |
| `/api/projects/:id` | GET | 프로젝트·작업·결정 |
| `/api/agents` | GET / POST `{slug,displayName}` | 목록 / Mock 에이전트 등록 |
| `/api/agents/:slug` | GET | 에이전트·메시지·실행 |
| `/api/tasks` | GET / POST 아래 형식 | 최근 작업 / 작업·최초 HANDOFF 생성 |
| `/api/tasks/:id` | GET | 작업·메시지·이벤트·run·테스트·산출물 |
| `/api/tasks/:id/step` | POST `{}` | 큐 1건 처리 또는 기존 run 복구; 최신 DB detail |
| `/api/tasks/:id/decision` | POST `{action,reason,budgetUsd?}` | CEO 결정과 작업 상태 |

작업 생성 예시(금액은 부동소수점 오차를 피하기 위한 decimal string):

```json
{
  "projectId": "프로젝트 UUID",
  "title": "벤치마크 세트",
  "description": "정상 및 경계값 검증",
  "leadAgent": "구현 에이전트 UUID",
  "reviewerAgent": "다른 검수 에이전트 UUID",
  "acceptanceCriteria": ["정상·경계·실패 사례 포함"],
  "priority": "MEDIUM",
  "budgetUsd": "5.00",
  "isDemo": true,
  "delayMs": 2500
}
```

결정 action: `approve`, `revise`, `cancel`, `resume`, `pause`, `unpause`, `budget`. pause/unpause는 DB 실행 제어 플래그만 바꾸며 실제 workflow 대기 원인을 해제하지 않는다. budget 변경 후에도 workflow 재개는 별도 resume 결정이 필요하다. UNKNOWN_OUTCOME의 resume은 항상 거부한다. 종료 상태는 다시 시작하지 않고 새 작업을 만든다.

③의 데모 실행 버튼은 작업 생성 후 step을 호출하고 `demo_next_step_at`에 맞춰 다음 요청을 보낸다. pause/unpause와 새 작업 생성이 일시 정지/처음부터에 대응한다. step은 내부 sleep/전체 루프 없이 반환하며, 아직 시각이 되지 않았으면 429다. API 응답 성공 자체를 애니메이션 이벤트로 사용하지 않고 저장된 task/event/message를 사용한다.

## 저장 순서·동시성·실패

1. CEO·owner 검사, request advisory lock, task row lock. 미정산 run이 있으면 새 호출하지 않는다. 담당 agent row lock으로 다른 작업의 동시 호출도 차단한다.
2. 큐 claim, attempts·lease·run(STARTED)·입력 snapshot·명령 영수증을 함께 커밋한다. 잠금을 해제한 후 Provider를 한 번 호출한다.
3. 결과 형식·사용량 검증 후 run(RECORDED)·ledger 기반 task 비용·필요한 예산 중단을 함께 커밋한다. 다음 단계 메시지는 아직 없다.
4. 별도 트랜잭션에서 저장된 결과·최신 task·검수 round·한도를 검증하고 증거·메시지·전이·event·cursor와 APPLIED를 함께 저장한다. 저장 실패 시 RECORDED가 남고 같은/새 요청으로 재적용한다. Provider 재호출과 비용 중복 합산은 없다.

미해결 STARTED의 lease는 30초, Provider 제한은 10초다. 프로세스 중단·저장 실패 후 만료된 STARTED를 발견하면 재호출하지 않고 UNKNOWN_OUTCOME으로 전환한다. Phase 1은 요청 기반 복구이며 화면이 닫히면 백그라운드 워커가 진행하지 않는다.

**사용자가 전달한 Claude 재검수의 ② 참고 사항:** UNKNOWN_OUTCOME run과 `WAITING_USER / pause_reason=UNKNOWN_OUTCOME`을 동일 트랜잭션에서 기록한다. 기존 BUDGET 대기와 경합해도 UNKNOWN_OUTCOME 사유를 보존한다. 한쪽 쓰기 실패 시 둘 다 롤백되는 통합 테스트를 포함한다. 이미 취소·완료된 task는 terminal 상태를 보존하고 run만 UNKNOWN_OUTCOME으로 기록한다. 취소 이후 작업을 대기 상태로 되살리지 않는다. Phase 1에서는 취소만 가능하고 별도 run resolution은 Phase 2 범위다.

예산 초과 시 실제 Mock 사용량은 기록하고 RECORDED 응답을 보류한다. CEO가 예산을 올리고 resume한 후 이 응답을 적용한다. 호출 중 취소는 후속 응답을 폐기하지만 뒤늦게 확인된 사용량은 보존한다. 이를 위해 terminal task는 다른 필드 변경 없이 **기록된 RECORDED/APPLIED run 합계와 일치하는 비용 증가·version 증가만** 허용한다. 상태/담당/수락 조건/증거는 불변이다.

## 증거와 Mock

Provider는 DB·UI를 직접 변경하지 않는다. MockProvider는 저장된 상태·role·토론/검수 round로 결과를 생성한다. 최초 검수는 FAIL, 수정 후 검수 PASS, Mock 단위/회귀 PASS를 기록한다. 실제 코드 실행이나 실제 모델 요금이 아니라 명시적인 시뮬레이션이다. 정상 11회 호출 합계는 $0.55다.

완료 근거는 서버가 현재 round의 lead artifact, reviewer 메시지와 artifact 참조, reviewer의 unit/regression 결과 ID를 DB에서 읽어 구성한다. 브라우저 제출 증거는 사용하지 않는다. 기존 append-only 규칙을 유지한다. 작업 완료/취소/대기, agent 상태, 메시지 queue, 비용·단계·지연은 DB에서 읽어 ③ 화면과 연결한다.

## 검증

`pnpm test`는 독립적으로 커밋하는 PGlite 서비스 통합 테스트도 포함한다. DB 구현을 mock으로 대체하지 않는다. 실제 Supabase에서는 빈 임시 DB에 한해 `OFFICE_TEST_DATABASE_URL`과 `OFFICE_TEST_DISPOSABLE=1`로 `pnpm test:db`를 실행한다. 서비스 suite는 이 DB의 fixture를 초기화하므로 기존 데이터가 있는 환경에서는 실행하지 않는다.

CI의 `scripts/test-http.mjs`는 로컬 Supabase CLI에서 테스트 키를 메모리로 읽고, 실제 GoTrue 사용자·SSR cookie·Next production server로 로그인→작업 생성→11회 step→승인→logout을 수행한다. DB 행과 비용도 검증한다. hosted project 키를 사용하거나 출력하지 않는다. 스택은 job 종료 시 제거된다.

공식 근거: [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Next Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route). 패키지 버전은 lockfile에 고정했다.
