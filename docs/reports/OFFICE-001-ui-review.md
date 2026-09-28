# Claude 검수 · PR #4 ③ 화면·Realtime·데모 (1950d53)

- 구현: GPT(Codex) / 검수: Claude / 병합: Claude (CEO 위임)
- 판정: **승인**

## 확인한 것

- 로컬: `pnpm test` 103개 통과, `pnpm typecheck`, `pnpm lint`, `pnpm build` 통과.
- 클라이언트 번들(`.next/static`)에서 `DATABASE_URL`, `service_role`, 서버 서비스 코드, DB 드라이버 문자열을 검색해 **검출 없음**을 확인.
- 실제 Supabase·브라우저 E2E·모바일 검증은 CI에서 실행되었다는 보고를 확인했다 (스크린샷은 CI artifact). 이 검수 환경에는 Docker와 Supabase가 없어 화면을 직접 렌더링하지는 못했다.
- `use-office.ts`, `presentation.ts`, `proxy.ts`, `page-auth.ts`, `auth.ts`, `office-service.ts` 변경, `20260928133346_ui_review_followups.sql`, `docs/UI_REALTIME_DEMO.md`를 읽었다.

## PR #3 권장 1~4 반영 확인

| 권장 | 결과 |
|---|---|
| 1. STALE_RUN_CONTEXT | 예외 대신 사용량 유지 + 응답 폐기 + run 정산 + `WAITING_USER(DECISION)` 전환. 영구 정지 경로가 사라짐 |
| 2. 조회 잠금 | 목록·상세가 `repeatable read, read only` 트랜잭션으로 변경, FOR UPDATE 제거 |
| 3. 작업 코드 | 프로젝트별 `TASK-001` 순번, `private.task_counters`로 동시 생성 충돌 방지. 코드 유일성을 (project_id, code)로 변경 |
| 4. 예산 재개 | 해결 전 resume은 `BUDGET_STILL_EXCEEDED` / `LIMIT_STILL_EXCEEDED` 오류 |

## 잘된 점

- Realtime을 데이터 원본이 아닌 **무효화 신호**로만 쓰고, 실제 데이터는 서버 API 스냅샷으로 다시 받는다. 브라우저는 RLS 읽기와 구독만 하고 쓰기는 전부 서버를 거친다.
- 조회 중에 들어온 이벤트는 dirty 플래그로 다음 조회에 합쳐서, 요청이 폭주하지 않는다.
- 메시지 꾸러미 애니메이션이 **새 메시지 ID에만** 재생된다. 초기 로딩, 재연결, 탭 복귀 때는 기준선을 다시 잡아 과거 대화를 다시 재생하지 않는다.
- 들썩임, 타이핑, 스캔선, 말줄임표가 에이전트의 `current_task_id`와 `status`, 작업 상태에서 파생된다. 화면 안에 대본이 없다.
- `prefers-reduced-motion`을 지원한다.
- 페이지와 API 모두에서 CEO를 확인하고, proxy가 세션 갱신 쿠키를 먼저 저장한다.

## 권장 (Phase 2)

1. **`requireCeo`가 모든 오류를 로그인 리다이렉트로 처리**
   DB 연결 실패나 설정 누락도 `/login`으로 보내서, 운영 장애가 "로그인 반복"처럼 보인다. 인증 실패와 서버 오류를 구분해 오류 화면을 보여주는 것을 권장.
2. **Realtime 이벤트당 전체 재조회**
   이벤트 하나에 프로젝트, 에이전트, 작업 목록, 상세 4개 API를 다시 부른다. 1인 CEO 규모에서는 문제없지만, 실제 AI 연결 후 메시지가 많아지면 변경된 테이블에 맞는 부분 재조회로 줄일 것.

## 남은 일 (CEO)

- 전용 Supabase 프로젝트와 Vercel 프로젝트 연결, 운영 마이그레이션, `setup:ceo` 실행, Vercel 미리보기에서 데모 완주 확인. 이 검증이 끝나야 Phase 1 완료 조건 8절의 "Vercel 미리보기 데모 동작"이 충족된다.
