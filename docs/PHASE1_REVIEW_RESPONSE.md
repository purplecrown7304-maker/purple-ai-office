# Claude 설계 검수 반영 — ① DB·도메인·테스트

검수 대상: 설계 커밋 `27f556c`.

승인 근거: [사용자가 전달한 Claude 검수문](https://github.com/purplecrown7304-maker/container-loading-simulator/pull/82#issuecomment-5867777317). 다른 레포에 게시되어 있지만 본문의 검수 대상은 purple-ai-office PR #1이다. 사용자도 본 대화에서 승인과 ① 착수를 지시했다. 검수문을 다른 곳에 중복 게시하거나 검수자 계정을 가장하지 않는다.

| 권장 | 이번 반영 | 검증 |
|---|---|---|
| 1. 감사 append-only DB 강제 | `task_events`, `decisions` UPDATE/DELETE 거부 트리거. run은 RECORDED 이후 금액·결과 불변, APPLIED/FAILED/UNKNOWN_OUTCOME 전체 불변. 모든 run 삭제 금지. 런타임 역할 TRUNCATE 권한도 회수 | service_role로 update/delete/truncate 시도, 정산 필드 변경 거부 |
| 2. RPC의 싼 불변식 | 종료 상태 거부, version CAS, 동일 request의 payload 일치, 비음수 CHECK, 비용/카운터 감소 거부, 직접 상태 변경 시 감사 트랜잭션 강제 | 중복 요청·다른 payload·오래된 version·음수·감사 insert 실패 롤백 |
| 3. Agent 소유 모델 | `UNIQUE(owner_id,slug)`로 통일. 모든 업무 테이블 owner_id는 복합 FK로 부모 소유권에 고정 | 다른 owner의 같은 slug 허용, 같은 owner 중복 거부, 교차 owner 참조 거부 |
| 4. ANALYZING 직행 | lead가 계획 decision을 기록한 경우 `ANALYZING → PLANNED` 허용. 데모 경로는 기존 DISCUSSION 유지 | 계획 없는 직행 거부 및 정상 직행 테스트 |
| 5. 환경별 CEO 등록 | `CEO_EMAIL`, `DATABASE_URL`을 읽는 서버 전용 setup 스크립트. 기존 확인된 Auth 사용자를 조회하여 UID 등록, 기본 Mock 에이전트 시드. 기존 CEO 교체 금지·트랜잭션·설정 중복 방지 | 운영 UID가 migration에 없음; 테스트는 별도 rollback fixture 사용 |

기존 설계의 후속 정밀화:

- `owner_id`를 자식 테이블에도 둬 `(owner_id,parent_id)` 복합 FK로 소유권 경로를 강제한다. RLS는 CEO와 이 소유권 열을 검사한다. 중복 열이 임의로 다른 owner를 가리킬 수 없다.
- `task_events.command`는 같은 request ID의 다른 입력을 거부하는 데 사용한다. 상태 변화 자체는 여전히 `task-policy.ts`만 정의한다. 서버 전용 RPC가 유효 전이 정책을 대신하지 않는다.
- 질문·응답·Provider 호출을 실행하는 서버는 ②에서 연결한다. ①에는 서버 정책 경계의 DB 저장 원자성과 도메인 규칙만 구현한다.
- 생성 시 DB 트리거가 `NULL → NEW` 이벤트를 만들고, 모든 상태 변화는 같은 트랜잭션에서 이벤트를 기록한다.
- 정산 후 run 데이터는 변경하지 않는다. UNKNOWN_OUTCOME은 후속 호출을 막으며, Phase 1에서 무조건 재호출하는 복구는 제공하지 않는다.
- 패키지 관리자는 환경에 있는 pnpm을 사용하고 `pnpm-lock.yaml`을 커밋한다. Next.js lint 의존성과 호환되는 ESLint 9 / TypeScript 6을 고정했다.

반복 한도 초기화는 Phase 2 검토 대상으로 유지한다. 대표가 승인한 시안 3장과 DB 기반 애니메이션 계약은 [docs/design/README.md](design/README.md)에 보관하며 ③의 기준으로 사용한다. ①은 하나의 PR로 제출하고 domain/DB/test/setup/CI 파일로 구분해 검토할 수 있게 한다.

## PR #2 구현 검수 수정

[Claude 구현 검수](https://github.com/purplecrown7304-maker/purple-ai-office/pull/2#issuecomment-5868319281), 대상 `9985299`. 아래는 설계 권장 사항과 별개인 구현 검수 1~5의 반영 내역이다. 원래 migration은 보존하고 추가 migration으로 적용한다.

| 항목 | 반영 | 회귀 검증 |
|---|---|---|
| 차단 1: 작업 정의 변경 | lead/reviewer/수락 조건/code/is_demo 생성 후 불변 트리거 | CROSS_REVIEW 역할 교환, 수락 조건 약화, code/is_demo 수정 거부; title/예산 정상 수정 허용 |
| 차단 2: UNKNOWN_OUTCOME 재개 불가 모순 | WAITING_USER/UNKNOWN_OUTCOME은 CEO 취소만 허용; enforceLimits도 사유 보존 | 모든 재개·완료·에스컬레이션 거부, 에이전트 취소 거부, CEO 취소 허용, 복수 한도 우회 차단 |
| 권장 3: 증거 append-only | test_results/artifacts UPDATE/DELETE 거부 | service_role update/delete/truncate 거부 |
| 권장 4: 메시지 원문 불변 | DELETE 금지, 큐 운영 7개 열만 UPDATE 허용 | 원문/payload/type/round/송수신/응답 필요 여부/멱등키/생성시각 변경 거부, 운영 열 변경 성공 |
| 권장 5: grants 회귀 | pg_catalog 기반 public 전체 테이블 스캔, anon 권한 없음/authenticated SELECT만 허용 | 새 테이블의 PUBLIC SELECT·열 UPDATE 누락을 실제 주입해 탐지, 회수 후 정상 통과 |

수정 전 회귀 테스트에서 18개 실패를 재현했고, 수정 후 domain 31개와 DB 51개가 통과했다. pgTAP은 기존 6개에 catalog grants 6개를 추가했다. 실제 Supabase 실행 결과는 PR의 해당 커밋 CI를 확인한다. Claude 재검수와 CEO 병합은 별도이며 자체 승인하지 않는다.
