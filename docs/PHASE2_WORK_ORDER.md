# OFFICE-002 · Phase 2 작업지시서 — 구독 CLI 로컬 러너

- 구현: **Claude** / 검수: **GPT** / 최종 승인: CEO (Phase 1과 역할 교대)
- 상위 명세: `AI_OFFICE_SPEC.md` v1.1, `PHASE1_DESIGN.md`
- 결정 사항(CEO, 2026-09-29): 유료 API 키를 쓰지 않는다. CEO PC에 설치한 **Claude Code**와 **Codex CLI**를 각자의 **구독 계정 로그인**으로 실행한다.

---

## 1. 목표

Phase 1의 MockProvider 자리에 **실제 GPT(Codex CLI)와 Claude(Claude Code)** 를 연결한다.
AI Office 서버와 화면, 상태 규칙은 그대로 두고, **실제 AI 호출은 CEO PC의 러너가 수행**한다.

```
[AI Office (Vercel + Supabase)]  ←HTTPS→  [러너 (CEO PC)]  →  claude -p / codex exec
  작업·메시지·상태·검수 증거                   작업 가져오기·실행·결과 보고        프로젝트 레포 worktree
```

## 2. 전제와 위험 (구독 사용)

- Anthropic 공식 안내(2026-06-15 기준): `claude -p`와 Agent SDK 사용은 **구독 사용량 한도에서 차감**된다. 계획했던 변경은 보류 중이며, 변경 전에 공지하겠다고 밝혔다. 정책이 바뀌면 이 방식은 재검토한다.
- `ANTHROPIC_API_KEY` 환경변수가 있으면 Claude Code가 **API 과금으로 전환**된다. 러너는 자식 프로세스 환경에서 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`를 **반드시 제거**한다.
- Claude 계정의 **추가 사용량(usage credits)** 이 켜져 있으면 한도를 넘은 사용이 API 요금으로 청구된다. CEO는 이 설정을 **끈다**(러너 시작 체크리스트에 포함).
- 구독 한도는 CEO가 채팅에서 쓰는 사용량과 **공유**된다. 러너는 하루 실행 횟수에 상한을 둔다(6절).
- Codex CLI의 ChatGPT 로그인은 `~/.codex/auth.json`에 저장된다. 이 파일은 비밀로 취급하며 레포·로그·AI Office에 절대 올리지 않는다.
- 러너는 **AI가 작성한 코드를 CEO PC에서 실행**한다(테스트 단계). 프로젝트 worktree 밖 파일 접근을 막고, 가능하면 전용 OS 사용자나 컨테이너에서 실행하도록 안내한다.

## 3. 범위

### 포함
1. 러너 인증: CEO가 화면에서 발급·폐기하는 **러너 토큰**. PC에는 `DATABASE_URL`을 두지 않는다.
2. 서버 러너 API: 작업 가져오기(claim), 진행 알림(heartbeat), 완료(complete), 실패(fail).
3. 러너 CLI(`runner/`, `pnpm runner`): 폴링, 실행, 보고, 종료 신호 처리.
4. Provider 어댑터 2종: `claude-code`, `codex-cli`. 구조화 JSON 응답과 서버 측 스키마 검증.
5. 작업 공간: 프로젝트 레포의 **에이전트별 git worktree**와 브랜치 `agent/<slug>/<TASK-code>`.
6. 실제 테스트 실행: 프로젝트별 테스트 명령을 검수 대상 커밋에서 실행하고 결과를 `test_results`에 기록.
7. 화면: 러너 온라인 상태, 에이전트별 실행 중 표시, 진행 문구, 실제 테스트 출력.

### 제외
- GitHub PR 자동 생성·병합 (브랜치 푸시와 비교 링크까지만. 병합은 CEO가 GitHub에서)
- 여러 대의 PC, 여러 러너 동시 실행
- 병렬 구현 모드(명세 13절), 벤치마크 비교
- 유료 API Provider

## 4. DB 변경

| 대상 | 변경 |
|---|---|
| `agents.provider` | 허용값 `mock`, `claude-code`, `codex-cli` (CHECK). 작업 생성 시 `mock` 전용 제한 해제. 한 작업 안에서 Mock과 실제 에이전트를 섞지 않는다 |
| `private.runner_tokens` (신규) | `id, owner_id, token_hash(sha256), label, created_at, last_used_at, revoked_at`. 원문 토큰은 발급 순간 한 번만 화면에 표시 |
| `public.runners` (신규) | `id, owner_id, token_id, hostname_label, version, last_seen_at, current_run_id, capabilities jsonb`. 대시보드 표시용, CEO SELECT만 허용 |
| `projects` | `local_repo_hint text`(선택), `test_command text`(기본 `npm test`), `default_branch text`(기본 `main`) |
| `agent_runs` | `executor text`(`server`/`runner`), `runner_id`, `progress_note text`, `failure_class text`(`NOT_STARTED`/`INVALID_OUTPUT`/`UNCERTAIN`) |
| `artifacts` | 실제 산출물은 `type='git:commit'`, `path='agent/<slug>/<TASK>'`, `metadata={sha, round, base_sha, diffstat}` |
| `test_results` | 실제 실행은 `test_type='run:unit:<round>'` 등으로 Mock과 구분, `output`은 마지막 20KB만 |
| `tasks.pause_reason` | `RATE_LIMIT` 추가 |

Phase 1의 불변 규칙(감사 append-only, 정의 불변, 비용·카운터 감소 금지, 러너도 서버 경유)은 모두 유지한다.

## 5. 서버 러너 API

모든 요청은 `Authorization: Bearer <runner token>`. 서버는 해시로 토큰을 찾고, 폐기 여부와 CEO 소유를 확인한다. 쿠키 세션과 섞지 않는다.

| 엔드포인트 | 동작 |
|---|---|
| `POST /api/runner/claim` | 실행 가능한 메시지 1건을 Phase 1 claim 규칙 그대로 잡고, `agent_runs(STARTED, executor='runner', lease=10분)` 생성. 응답: run id, 역할(lead/reviewer), 스냅샷, 기대 JSON 스키마, 브랜치·기준 커밋 정보. 할 일이 없으면 204 |
| `POST /api/runner/heartbeat` | lease 연장(최대 10분씩, 총 30분 상한), `progress_note` 갱신(200자) |
| `POST /api/runner/complete` | 응답 JSON과 사용량, 산출물(커밋 SHA)을 받아 **RECORDED로 먼저 저장** → Phase 1 `apply` 재사용 |
| `POST /api/runner/fail` | `NOT_STARTED`(CLI가 작업 전에 실패, 예: 한도 초과·로그인 만료): run FAILED, 메시지를 `pending`으로 되돌리고 `available_at` 뒤로 미룸. 3회 연속이면 `WAITING_USER(RATE_LIMIT 또는 DECISION)`. `INVALID_OUTPUT`: run FAILED, 작업 `WAITING_USER(DECISION)`. `UNCERTAIN`: Phase 1의 `UNKNOWN_OUTCOME` 경로(취소만 가능) |

lease 만료는 Phase 1과 같이 `UNKNOWN_OUTCOME`으로 처리한다. 러너가 비정상 종료해도 서버가 같은 작업을 두 번 실행시키지 않는다.

## 6. 한도 (구독 보호)

비용이 USD로 청구되지 않으므로 `cost_usd`는 0으로 기록하고, 대신 아래를 강제한다. 모두 설정값이며 엔진 상수로 묻지 않는다.

- 작업당 에이전트 메시지 20개 (Phase 1 유지)
- 실행 1회 최대 15분 (러너가 CLI를 종료, `UNCERTAIN`으로 보고)
- 하루 실행 40회 (러너 로컬 카운터 + 서버 집계 둘 다. 초과 시 claim 거부)
- 토큰 사용량은 CLI가 알려주면 `input_tokens`, `output_tokens`에 기록하고, 모르면 NULL(0으로 꾸미지 않음)

## 7. 러너 동작

```
시작 점검: 두 CLI 설치·로그인 확인, API 키 환경변수 부재 확인, git 사용자 설정, 작업 폴더 쓰기 가능
반복:
  claim → 없으면 5~30초 백오프
  worktree 준비 (lead: 자기 브랜치에서 작업 / reviewer: lead 브랜치의 해당 커밋을 읽기 전용 worktree로)
  프롬프트 작성 (8절) → CLI 실행 (heartbeat 60초마다)
  lead가 파일을 바꿨으면 git add/commit → SHA를 산출물로
  TESTING 단계면 test_command 실행 → 결과 첨부
  JSON 추출·검증 → complete / fail
  (옵션) 브랜치 push, 비교 링크를 산출물 metadata에
종료 신호: 실행 중 CLI에 종료 요청 → 결과를 확인할 수 없으면 UNCERTAIN 보고 후 종료
```

CLI 실행 옵션(구현 시 최신 문서로 재확인):

- Claude Code: `claude -p <prompt> --output-format json`, 권한은 편집 허용 + 도구 허용 목록(Read/Edit/Write, 테스트·git status/diff 정도). `git push`, 네트워크 명령, worktree 밖 경로는 금지. reviewer는 편집 도구 없이 실행.
- Codex CLI: `codex exec --json --output-schema <schema.json> --sandbox workspace-write`(reviewer는 read-only), 사용자 설정 무시 옵션 사용.
- 두 CLI 모두 `cwd`는 해당 worktree. 자식 환경에서 API 키 변수 제거.

## 8. 프롬프트·응답 계약

프롬프트에 포함: 역할(구현자/검수자), 프로젝트 규칙 파일(`AGENTS.md`, `CLAUDE.md`가 있으면 그 경로), 작업 제목·설명·수락 조건, 최근 메시지 10개, 현재 상태와 round, **응답 JSON 스키마**.

응답은 Phase 1 `providerResult`를 확장한다.
- 검수 결과는 **수락 조건별 통과 여부와 근거**를 필수로 받는다(Phase 1의 일괄 판정 제거).
- `criticalBugCount`는 검수자가 직접 보고한다.
- 서버는 역할과 상태에 맞지 않는 증거(예: 구현자가 보낸 검수 판정)를 Phase 1과 같이 거부한다.

## 9. 화면

- 상단에 **러너 상태**: 연결됨 / 끊김(마지막 신호 시각) / 한도 도달.
- 사무실: 실행 중인 에이전트의 `progress_note`를 말풍선 아래에 작게 표시. 기존 애니메이션 파생 규칙 유지.
- 작업 상세: 브랜치, 커밋 SHA, 실제 테스트 출력(접기), 실패 분류.
- 설정: 러너 토큰 발급·폐기, 에이전트 Provider 선택(mock / claude-code / codex-cli), 프로젝트 테스트 명령.

## 10. 테스트

- 러너 API: 토큰 없음·폐기·다른 소유자 거부, claim 동시성, lease 연장 상한, complete 멱등, fail 분류별 전이.
- 러너: **가짜 CLI 실행 파일**(정상 JSON, 잘못된 JSON, 중간 종료, 시간 초과, 한도 초과 메시지)로 어댑터와 분류를 검증. 실제 구독 CLI는 CI에서 호출하지 않는다.
- 환경 격리: 자식 프로세스 환경에 API 키 변수가 없음을 테스트로 확인.
- E2E: 가짜 CLI 러너를 CI에서 띄워 NEW → DONE 흐름, 수정 요청 1회 포함.
- 수동 점검표(CEO PC): 실제 두 CLI로 작은 작업 1건 완주.

## 11. PR 분할

| PR | 범위 | 구현 | 검수 |
|---|---|---|---|
| ① | DB 변경, 러너 토큰, 러너 API, 실패 분류, 한도 | Claude | GPT |
| ② | 러너 CLI, 두 어댑터, 가짜 CLI 테스트 | Claude | GPT |
| ③ | worktree·커밋·테스트 실행, 화면 변경, CI E2E | Claude | GPT |
| ④ | CEO PC 설치 안내서와 실제 1건 완주 기록 | Claude | GPT |

각 PR은 GPT가 검수하고, 판정 후 CEO(또는 위임받은 검수자)가 병합한다.

## 12. 완료 조건

- [ ] CEO PC에서 러너를 켜면 화면에 "연결됨"이 표시된다
- [ ] 실제 Claude와 GPT가 작은 작업 1건을 질문 → 구현 → 교차 검수 → 테스트 → 대표 승인까지 완주한다
- [ ] 구현 결과가 `agent/<slug>/<TASK>` 브랜치의 커밋으로 남고, 검수자는 그 커밋을 기준으로 판정한다
- [ ] 러너를 강제 종료해도 같은 작업이 두 번 실행되지 않는다
- [ ] 자식 프로세스에 API 키 변수가 전달되지 않는다(테스트로 증명)
- [ ] 하루 실행 상한, 1회 시간 상한이 동작한다
- [ ] Phase 1 테스트 전부 유지, CI 녹색

## 참고

- Anthropic, [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- Anthropic, [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- OpenAI, [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- 사례 보고: [claude -p 과금 경로 이슈 #43333](https://github.com/anthropics/claude-code/issues/43333) (API 키 제거·추가 사용량 끄기 안전장치의 근거)
