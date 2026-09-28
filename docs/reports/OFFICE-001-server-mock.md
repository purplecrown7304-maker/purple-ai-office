# Work Report

## Task
OFFICE-001 · Phase 1 ② 서버·MockProvider

## Agent
GPT(Codex) 구현 / Claude 검수 / CEO 최종 병합

## Changed
- Supabase SSR 로그인·세션·로그아웃, CEO/owner 검사, same-origin·strict input·멱등 키·no-store API.
- 프로젝트·에이전트·작업 생성/조회, CEO 결정, DB 큐 한 단계 실행 서비스.
- AgentProvider 인터페이스와 실제 API 호출 없는 MockProvider.
- STARTED → RECORDED → APPLIED 분리, 저장된 응답 재적용, 한도·사용량 정산, 취소 경쟁, lease 복구.
- UNKNOWN_OUTCOME run과 WAITING_USER(UNKNOWN_OUTCOME)의 원자적 저장.
- command_receipts와 실행 snapshot/일시 정지 필드, 종료 후 늦은 사용량의 제한적 ledger 정산.
- 서비스/DB 통합 테스트와 실제 Auth·HTTP CI smoke.

## Reason
main `0255259`에서 ②를 시작하라는 사용자 지시와 전달된 Claude 재검수 참고 사항을 반영했다. ① DB 무결성/도메인 정책을 실제 서버 요청에 연결하고, ③이 저장된 데이터만으로 화면을 구현할 수 있는 API를 제공한다.

## Tests
- 로컬 domain·DB·서비스 통합 95개 통과. 타입 검사·lint·production build 통과.
- 동시 중복/별도 step, 같은 agent의 다른 작업, RECORDED 재개, 기록/적용/UNKNOWN_OUTCOME 쓰기 실패, 비용 중복 방지, 예산 재개, 호출 중 취소, non-CEO/CSRF/입력 증거 위조 거부.
- 실제 Supabase의 DB 통합·pgTAP 및 Auth cookie/HTTP 전체 흐름은 CI에서 실행한다. 해당 커밋 결과는 PR checks에 기록한다. 로컬 Docker는 없다.
- ③ 브라우저 UI/Realtime/Playwright, 원격 migration과 Vercel 배포는 이번 범위가 아니다.

## Result
② 구현 및 로컬 검증 완료. 실제 Supabase CI와 Claude 검수는 PR에서 확인한다. Phase 1 전체 완료가 아니다.

## Remaining Issues
- UNKNOWN_OUTCOME 해결은 Phase 2 범위. Phase 1 취소 전용 유지.
- 비용을 알 수 없는 run은 null 사용량과 UNKNOWN_OUTCOME을 보존하며 0으로 꾸미지 않는다.
- 로그인 화면/SSR 페이지 Proxy/Realtime/데모 조작 화면은 ③에서 연결한다.
- 서버는 DATABASE_URL로 원자적 트랜잭션을 실행하므로 해당 환경의 연결·TLS 설정이 필요하다. 자동 운영 워커나 실제 모델 API는 없다.

## Next Agent
Claude

## Next Action
② 변경과 통합 테스트를 검수하고 `판정: 승인` / `판정: 수정 요청` / `판정: 대표 판단 필요`를 남긴다. 최종 병합은 CEO가 수행한다.

상세 API·실패 계약: [SERVER_API.md](../SERVER_API.md).
