# Claude 검수 · PR #3 ② 서버·MockProvider (925e231)

- 구현: GPT(Codex) / 검수: Claude / 병합: Claude (CEO 위임)
- 판정: **승인**

## 확인한 것

- 로컬 `pnpm install --frozen-lockfile && pnpm test`: 95개 통과 (domain, PGlite DB, 서비스 통합). `pnpm typecheck`, `pnpm lint` 통과.
- 실제 Supabase DB·pgTAP·Auth/HTTP smoke는 CI에서 실행되며 성공 기록이 있음 (GPT 보고, Actions run 36428074606).
- `office-service.ts`, `repository.ts`, `http.ts`, `auth.ts`, `db.ts`, `route.ts`, `20260928125047_server_execution.sql`, `providers/*`, 도메인 변경(`unknownOutcome`)을 읽음.

## 잘된 점

- Provider 호출이 DB 트랜잭션 밖에서 1회만 일어나고, 결과를 RECORDED로 먼저 커밋한 뒤 별도 트랜잭션에서 적용한다. 재시도는 RECORDED를 재적용할 뿐 Provider를 다시 부르지 않는다.
- 비용은 run 원장 합계로 다시 계산해 `tasks.cost_usd`에 반영하므로 이중 합산이 구조적으로 불가능하다. 종료 후 늦게 도착한 사용량도 원장 근거가 있을 때만 증가를 허용한다.
- UNKNOWN_OUTCOME run과 `WAITING_USER(UNKNOWN_OUTCOME)`이 한 트랜잭션에서 함께 저장되고, 동시 예산 초과보다 우선한다 (재검수 참고 사항 반영, 통합 테스트 포함).
- HTTP 경계: 같은 origin 검사, 스트리밍 본문 크기 제한, strict 스키마, 멱등 키 필수, 오류 응답에 SQL·키·스택 미노출.
- `command_receipts`로 인스턴스 간 재시도 멱등성 보장, append-only 트리거 적용.
- 검수·테스트 증거를 서버가 역할과 round로 검증해 만들고, Provider가 임의 증거를 주입할 수 없다.

## 권장 (③ 또는 Phase 2에서 반영)

1. **STALE_RUN_CONTEXT 처리와 주석 불일치** (`apply`)
   주석은 "CEO 결정을 위해 멈춘다"인데 실제로는 예외를 던지고 run이 RECORDED로 남는다. 현재 경로에서는 재현 경로를 찾지 못했지만, 발생하면 해당 작업은 취소 전까지 영구 정지된다. 예외 대신 `WAITING_USER(DECISION)` 전환 또는 "적용 없이 정산" 기록으로 바꾸는 것을 권장.
2. **조회 API의 행 잠금**
   `detail()`이 `taskForUpdate`(SELECT … FOR UPDATE)를 쓴다. ③ 화면이 재조회를 자주 하면 step과 잠금 경쟁이 생긴다. 조회 경로는 일반 SELECT로.
3. **사람이 읽는 작업 코드**
   `code`가 `TASK-<uuid>`로 생성된다. 화면·보고·대화에서 부르기 어렵다. 프로젝트별 순번(`TASK-001`)을 권장.
4. **예산 초과 상태에서의 resume 무응답**
   예산을 올리지 않고 resume하면 상태 변화 없이 성공 응답이 온다. `BUDGET_STILL_EXCEEDED` 같은 명시 오류를 권장.

## Phase 2 메모

- Mock은 수락 조건별 결과를 판정 하나로 일괄 채운다. 실제 Provider 연결 시 조건별 결과를 구조화 응답으로 받아야 한다.
- 호출 전 비용 예약(예상 비용)이 없어 예산과 같은 비용에서 1회 초과가 가능하다. 설계 3.4절대로 유료 Provider 전에 도입.
