# AI OFFICE 구축 명세서

> 목적: GPT와 Claude가 **동등한 AI 개발자**로서 서로 질문하고, 답하고, 설계하고, 구현하고, 테스트하고, 검수하고, 재작업하며 여러 소프트웨어 프로젝트를 지속적으로 개발하는 협업형 AI 사무실을 구축한다.

---

# 0. v1.1 개정 사항 (본문보다 우선)

v1.0 본문과 이 절이 충돌하면 이 절을 따른다.

## 0.1 GitHub가 작업장, AI Office는 관제실
- 코드 변경·테스트·빌드·E2E는 **GitHub(브랜치, PR, GitHub Actions)** 에서 수행한다. Phase 6의 자체 Sandbox는 만들지 않는다.
- Vercel 서버리스는 실행 시간 제한이 있으므로 빌드·테스트를 실행하지 않는다.
- AI Office는 작업 배분, Agent 간 메시지, 상태·비용 기록, 대시보드를 담당하고 GitHub 이벤트(PR, CI 결과, 리뷰)를 읽어 표시한다.

## 0.2 자기 승인 금지는 시스템으로 강제
- GPT와 Claude는 각각 **별도의 GitHub App(봇 계정)** 으로 커밋·리뷰한다. 같은 사람 계정을 공유하지 않는다.
- 각 프로젝트 레포의 `main`에 브랜치 보호: PR 필수, 작성자가 아닌 승인 1건 필수, CI 통과 필수, 강제 푸시 금지.
- 최종 병합은 CEO만 한다.

## 0.3 비용 상한은 금액으로
- `MAX_COST_PER_TASK_USD = 5.00` (프로젝트별 설정 가능). 초과 시 해당 Task는 `WAITING_USER`로 전환되고 Agent 호출을 중단한다.
- 모든 Agent 호출은 `agent_runs`에 토큰과 비용을 기록한 **뒤에** 다음 호출을 허용한다.
- OpenAI API·Anthropic API 사용료는 ChatGPT·Claude 구독과 별도로 청구된다.

## 0.4 Agent 대화는 큐 + 워커로 구동
- API Route 한 번의 요청 안에서 Agent 간 대화를 이어가지 않는다.
- `agent_messages`에 `requires_response=true` 메시지가 쌓이면, 워커가 하나씩 꺼내 대상 Agent를 호출하고 응답을 다시 메시지로 기록한다.
- 워커 구현(Supabase pgmq + pg_cron + Edge Function, 또는 별도 Node 워커)은 Phase 4에서 결정한다. Phase 1은 **큐로 쓸 수 있는 테이블 구조와 상태 전이**만 준비한다.

## 0.5 병렬 구현(13절)의 전제
- 벤치마크 비교는 **고정된 테스트 화물 세트 + 채점 스크립트**가 프로젝트 레포에 있어야 사용한다. 없으면 병렬 구현 모드를 쓰지 않는다.

## 0.6 첫 실제 작업 변경 (29절)
- 시스템 검증용 첫 Task는 결과 확인이 쉬운 작업으로 한다: `TASK-001 적재 벤치마크 화물 세트 및 채점 스크립트 작성`.
- 혼합 적재 최적화는 벤치마크가 생긴 뒤 진행한다.

## 0.7 기억 저장소 분리 (15절)
- **프로젝트 규칙·설계 문서**: 각 프로젝트 레포 (`AGENTS.md`, `CLAUDE.md`, `docs/`).
- **회사 공통 규칙, Task, 메시지, 결정, 실행 기록**: AI Office DB.
- 같은 내용을 두 곳에 복사하지 않는다. DB에는 레포 문서의 경로·커밋만 기록한다.

## 0.8 초기 결정
- 레포: 새 레포 `purple-ai-office` (프로젝트 레포와 분리)
- DB: 새 Supabase 프로젝트 (시뮬레이터 회원 데이터와 분리)
- 1차 범위: Phase 1 (AI API 호출 없음)
- Phase 1 구현: GPT / 검수: Claude

---

# 1. 프로젝트 개요

## 프로젝트명

**PURPLE AI OFFICE**

## 핵심 목표

사용자는 대표(CEO) 역할만 수행한다.

사용자가 자연어로 업무를 지시하면 AI Office가 업무를 분석하여 GPT와 Claude에게 적절히 배분하고, 두 AI가 서로 자유롭게 대화하며 개발을 진행한다.

GPT와 Claude는 특정 역할에 고정되지 않는다.

둘 다 다음 업무를 수행할 수 있어야 한다.

- 요구사항 분석
- 기능 설계
- 시스템 설계
- 알고리즘 설계
- 코드 구현
- 코드 수정
- 코드 리뷰
- 테스트 작성
- 테스트 실행
- 디버깅
- 리팩터링
- 성능 개선
- UI/UX 검토
- 문서 작성
- 상대 AI에게 질문
- 상대 AI의 의견 반박
- 상대 AI 작업 검수
- 상대 AI에게 재작업 요청

핵심 원칙은 다음과 같다.

> **어떤 AI도 자신이 구현한 작업을 혼자 최종 승인할 수 없다.**

---

# 2. 전체 구조

```text
                         USER / CEO
                             │
                             ▼
                  ┌─────────────────────┐
                  │  AI OFFICE SERVER   │
                  │   ORCHESTRATOR      │
                  └──────────┬──────────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
                  ▼                     ▼
           ┌──────────────┐       ┌──────────────┐
           │   GPT AGENT  │◀─────▶│ CLAUDE AGENT │
           │              │       │              │
           │ 분석         │       │ 분석         │
           │ 설계         │       │ 설계         │
           │ 구현         │       │ 구현         │
           │ 테스트       │       │ 테스트       │
           │ 검수         │       │ 검수         │
           └──────┬───────┘       └──────┬───────┘
                  │                      │
                  └──────────┬───────────┘
                             ▼
                  ┌─────────────────────┐
                  │ SHARED WORKSPACE    │
                  │                     │
                  │ GitHub              │
                  │ Tasks               │
                  │ Messages            │
                  │ Decisions           │
                  │ Test Results        │
                  │ Project Memory      │
                  └─────────────────────┘
```

---

# 3. 기술 스택

## Frontend

- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui

## Backend

- Next.js API Routes 또는 별도 Node.js 서버
- TypeScript

## Database

- Supabase PostgreSQL

## AI

- OpenAI API
- Anthropic API
- 필요 시 OpenAI Agents SDK
- 필요 시 Claude Code / Claude Agent SDK

## Repository

- GitHub

## 코드 실행 환경

권장:

- Docker Sandbox
- 또는 격리된 Worktree 환경

## 테스트

- Vitest
- Playwright
- ESLint
- TypeScript compiler
- 프로젝트별 Custom Benchmark

---

# 4. 핵심 운영 원칙

## RULE 1

GPT와 Claude는 동등한 권한을 가진다.

```text
GPT > Claude
```

또는

```text
Claude > GPT
```

구조를 만들지 않는다.

---

## RULE 2

둘 다 다음 작업을 할 수 있다.

```text
PLAN
DESIGN
IMPLEMENT
TEST
REVIEW
DEBUG
REFACTOR
RESEARCH
DOCUMENT
```

---

## RULE 3

자신의 구현을 자신이 최종 승인하지 않는다.

예:

```text
GPT 구현
→ Claude 검수
→ PASS / FAIL
```

또는

```text
Claude 구현
→ GPT 검수
→ PASS / FAIL
```

---

## RULE 4

의문이 생기면 상대 Agent에게 직접 질문한다.

사람에게 바로 질문하지 않는다.

먼저 상대 AI와 해결을 시도한다.

---

## RULE 5

AI 간 의견 충돌은 감으로 결정하지 않는다.

다음 순서로 해결한다.

```text
1. 코드 확인
2. 테스트 작성
3. 테스트 실행
4. Benchmark 비교
5. 결과 기반 결정
```

---

## RULE 6

두 번의 상호 검토 후에도 해결되지 않으면 CEO에게 Escalation 한다.

무한 대화를 금지한다.

---

## RULE 7

기존 기능을 삭제하거나 테스트를 우회하여 PASS 처리하는 행위를 금지한다.

---

## RULE 8

모든 변경 사항은 기록한다.

반드시 다음 내용을 남긴다.

- 무엇을 변경했는가
- 왜 변경했는가
- 어떤 파일을 변경했는가
- 어떤 테스트를 했는가
- 테스트 결과
- 남은 문제
- 다음 담당 Agent

---

# 5. Agent 구조

초기 버전에서는 AI를 많이 만들지 않는다.

기본 Agent는 두 개다.

```text
GPT_AGENT
CLAUDE_AGENT
```

둘 다 동일한 기능을 가진다.

## GPT_AGENT

```text
Capabilities

- requirement analysis
- architecture
- coding
- testing
- debugging
- code review
- UI/UX review
- optimization
- documentation
- question
- answer
- challenge
```

## CLAUDE_AGENT

```text
Capabilities

- requirement analysis
- architecture
- coding
- testing
- debugging
- code review
- UI/UX review
- optimization
- documentation
- question
- answer
- challenge
```

---

# 6. 필요 시 Sub Agent 생성

복잡한 업무에서는 각 AI가 하위 Agent를 생성할 수 있다.

예:

```text
GPT
├─ GPT-Research
├─ GPT-QA
└─ GPT-Frontend

Claude
├─ Claude-Backend
├─ Claude-Test
└─ Claude-Algorithm
```

단, Sub Agent 생성은 무제한 허용하지 않는다.

기본 제한:

```text
MAX_SUB_AGENTS_PER_PARENT = 3
```

---

# 7. 업무 상태(State Machine)

모든 Task는 다음 상태 중 하나를 가진다.

```text
NEW
↓
ANALYZING
↓
DISCUSSION
↓
PLANNED
↓
IMPLEMENTING
↓
CROSS_REVIEW
↓
TESTING
↓
┌───────────────┐
│ PASS ?        │
└───────┬───────┘
        │
   NO   │   YES
   ▼    │    ▼
FIXING  │   DONE
   │    │
   └────┘
```

추가 상태:

```text
BLOCKED
WAITING_AGENT
WAITING_USER
ESCALATED
CANCELLED
```

---

# 8. Task 구조

예시:

```json
{
  "id": "TASK-152",
  "project_id": "container-loading-simulator",
  "title": "박스 + 파렛트 혼합 자동 적재 개선",
  "description": "파렛트 사용량을 줄이고 직접 박스 적재와 혼합하여 공간 효율을 높인다.",
  "status": "IMPLEMENTING",
  "lead_agent": "claude",
  "reviewer_agent": "gpt",
  "priority": "HIGH",
  "created_by": "user",
  "acceptance_criteria": [
    "직접 박스 적재 가능",
    "파렛트 적재 가능",
    "혼합 적재 가능",
    "최대 적층단 준수",
    "중량 중심 검증",
    "기존 기능 회귀 오류 없음"
  ]
}
```

---

# 9. AI 메시지 시스템

GPT와 Claude는 직접 메시지를 교환할 수 있어야 한다.

## Message Types

```text
QUESTION
ANSWER
PROPOSAL
REVIEW_REQUEST
REVIEW_RESULT
TEST_REQUEST
TEST_RESULT
CHALLENGE
DECISION
HANDOFF
BLOCKER
STATUS
```

## 메시지 예시

```json
{
  "task_id": "TASK-152",
  "from": "claude",
  "to": "gpt",
  "type": "QUESTION",
  "message": "파렛트 잔여 공간에 직접 박스를 적재하도록 허용할까?",
  "requires_response": true
}
```

GPT 응답:

```json
{
  "task_id": "TASK-152",
  "from": "gpt",
  "to": "claude",
  "type": "ANSWER",
  "message": "허용한다. 단 최대 적층단, 중량중심, 하역순서 조건을 재검증한다."
}
```

---

# 10. Agent 간 사용 가능한 Action

AI Agent에게 다음 도구를 제공한다.

```text
ask_agent()
send_message()
request_review()
request_test()
request_implementation()
challenge_decision()
share_artifact()
claim_task()
release_task()
create_subtask()
create_branch()
run_tests()
run_benchmark()
commit_changes()
request_merge()
escalate_to_user()
```

---

# 11. 무한 대화 방지

AI가 서로 계속 질문만 주고받는 것을 방지한다.

기본 제한:

```text
MAX_DISCUSSION_ROUNDS = 6
MAX_REVIEW_RETRIES = 3
MAX_FIX_ATTEMPTS = 3
```

제한을 넘기면:

```text
ESCALATE_TO_USER
```

한다.

---

# 12. Git 작업 구조

GPT와 Claude가 같은 작업 디렉터리를 동시에 수정하지 않는다.

권장 방식:

```text
main

agent/gpt/TASK-152

agent/claude/TASK-152
```

또는 Git Worktree:

```text
/workspace/main
/workspace/gpt
/workspace/claude
```

---

# 13. Parallel Implementation Mode

어려운 문제에서는 GPT와 Claude에게 같은 문제를 동시에 구현하게 할 수 있다.

```text
TASK
 │
 ├──────────────┐
 ▼              ▼
GPT            Claude
 │              │
Solution A     Solution B
 │              │
 └───────┬──────┘
         ▼
      Benchmark
         │
         ▼
  Best Solution 선택
```

단순 투표 금지.

실제 결과를 비교한다.

예:

```text
Metric              GPT        Claude

Load Efficiency     91.7%      94.2%
Pallet Count        13         9
Unloaded Boxes      7          2
COG Deviation       4.1%       5.3%
Calculation Time    2.1 sec    3.4 sec
Collision           0          0
```

---

# 14. Decision Score

필요한 경우 여러 구현을 다음 지표로 비교한다.

기본값:

```text
Correctness          35%
Test Pass Rate       25%
Performance          15%
Maintainability      10%
Regression Safety    10%
Complexity            5%
```

프로젝트별로 다른 지표를 사용할 수 있다.

---

# 15. 공용 Memory 구조

```text
AI-OFFICE/
│
├─ README.md
├─ OFFICE_RULES.md
├─ AGENTS.md
│
├─ company/
│   ├─ rules.md
│   ├─ architecture.md
│   └─ decisions.md
│
├─ projects/
│   ├─ container-loading-simulator/
│   │   ├─ requirements.md
│   │   ├─ architecture.md
│   │   ├─ loading-rules.md
│   │   ├─ bugs.md
│   │   ├─ decisions.md
│   │   └─ progress.md
│   │
│   └─ other-project/
│
├─ tasks/
│   ├─ active/
│   ├─ completed/
│   └─ failed/
│
├─ messages/
│
├─ reports/
│
└─ agents/
    ├─ gpt.md
    └─ claude.md
```

---

# 16. Agent 시작 시 필수 Context

모든 Agent는 작업 시작 전에 다음 정보를 읽는다.

```text
OFFICE_RULES.md
PROJECT requirements
PROJECT architecture
PROJECT decisions
PROJECT progress
현재 Task
최근 Agent Messages
Git history
현재 Test 상태
```

---

# 17. Agent 종료 시 필수 보고

Agent가 작업을 끝낼 때 다음 형식으로 기록한다.

```markdown
## Work Report

### Task
TASK-152

### Agent
Claude

### Changed
- loadOptimizer.ts
- palletBuilder.ts

### Reason
기존 로직에서 파렛트 생성 이후 직접 박스 적재 후보를 제거하고 있었음.

### Tests
- unit test
- regression test
- loading benchmark

### Result
PASS

### Remaining Issues
- 하역순서 알고리즘 추가 검증 필요

### Next Agent
GPT

### Next Action
Cross Review
```

---

# 18. Cross Review 규칙

구현 Agent와 Review Agent는 달라야 한다.

예:

```text
GPT Implementation
→ Claude Review
```

```text
Claude Implementation
→ GPT Review
```

Review는 다음을 확인한다.

```text
1. 요구사항 충족
2. 기존 기능 파괴 여부
3. 예외처리
4. 코드 품질
5. 성능
6. 테스트 정확성
7. 임시 우회 코드 존재 여부
8. 테스트 조작 여부
```

---

# 19. PASS 조건

Task 완료 조건:

```text
Acceptance Criteria = PASS
Unit Test = PASS
Regression Test = PASS
Cross Review = PASS
Critical Bug = 0
```

필요한 프로젝트에서는 추가 조건을 둘 수 있다.

예:

```text
Loading Efficiency >= 기존 버전
Collision = 0
Unloaded Items <= 기존 버전
```

---

# 20. FAIL 처리

Review에서 문제가 발견되면 다음 정보를 전달한다.

```json
{
  "status": "FAIL",
  "severity": "HIGH",
  "reason": "maxStackHeight 계산 오류",
  "file": "loadOptimizer.ts",
  "expected": "제품별 최대 적층단 적용",
  "actual": "파렛트 최대 적층값 사용",
  "requested_action": "FIX_AND_RETEST"
}
```

---

# 21. 사용자 개입 조건

AI는 가능한 한 서로 해결한다.

다음 경우에만 사용자에게 질문한다.

```text
1. 요구사항이 서로 충돌함
2. 비즈니스 정책 결정 필요
3. 두 AI 의견이 테스트로도 결정되지 않음
4. 외부 계정 또는 권한 필요
5. 데이터 손실 위험
6. 비용이 큰 작업 실행 전 승인 필요
7. Production 배포 승인 필요
```

---

# 22. 비용 제어

AI들이 토큰을 낭비하지 않도록 다음 제한을 둔다.

```text
MAX_AGENT_MESSAGES_PER_TASK = 20
MAX_SUB_AGENTS = 6
MAX_PARALLEL_IMPLEMENTATIONS = 2
MAX_REVIEW_RETRIES = 3
```

불필요한 전체 코드 재읽기를 피한다.

변경된 파일 중심으로 Context를 전달한다.

---

# 23. 보안 규칙

Agent에게 다음 작업을 기본 금지한다.

```text
Production DB 삭제
환경변수 출력
API Key 출력
Secret Commit
Main 강제 Push
테스트 없는 Production 배포
사용자 승인 없는 DB Migration
사용자 승인 없는 대량 데이터 삭제
```

---

# 24. Database Schema

## projects

```text
id
name
repository_url
status
created_at
updated_at
```

## tasks

```text
id
project_id
title
description
status
priority
lead_agent
reviewer_agent
created_at
updated_at
```

## agents

```text
id
provider
model
status
current_task
last_active_at
```

## agent_messages

```text
id
task_id
from_agent
to_agent
type
message
requires_response
created_at
```

## agent_runs

```text
id
agent_id
task_id
started_at
ended_at
status
tokens_used
cost
```

## test_results

```text
id
task_id
agent_id
test_type
result
output
created_at
```

## decisions

```text
id
project_id
task_id
question
decision
reason
decided_by
created_at
```

## artifacts

```text
id
task_id
agent_id
type
path
metadata
created_at
```

---

# 25. AI OFFICE UI

## Dashboard

```text
┌──────────────────────────────────────────────┐
│               PURPLE AI OFFICE               │
├──────────────────────────────────────────────┤
│ Active Project                               │
│ Container Loading Simulator                  │
├──────────────────────────────────────────────┤
│ GPT                    Claude                │
│ 🟢 Working             🟢 Reviewing          │
│ TASK-152               TASK-152              │
├──────────────────────────────────────────────┤
│ TASK BOARD                                   │
│                                              │
│ TODO      WORKING      REVIEW      DONE      │
│  12          3            1          48      │
├──────────────────────────────────────────────┤
│ AI CHAT                                      │
│                                              │
│ GPT → Claude                                 │
│ "혼합 적재 후보 계산 확인 요청"            │
│                                              │
│ Claude → GPT                                 │
│ "현재 계산에서 하역순서 조건 누락 발견"    │
└──────────────────────────────────────────────┘
```

---

# 26. Agent Detail 화면

Agent 클릭 시 다음을 보여준다.

```text
Agent Name
Provider
Model
Current Task
Current Status
Current Branch
Files Changed
Messages
Token Usage
Cost
Test Results
Review History
```

---

# 27. Project 화면

프로젝트별로 다음을 표시한다.

```text
Project Status
Current Version
Open Tasks
Active Agents
Recent Commits
Test Health
Known Bugs
Performance Metrics
AI Decisions
```

---

# 28. Task 화면

```text
TASK-152

박스 + 파렛트 혼합 적재 개선

Status: CROSS_REVIEW

Lead
Claude

Reviewer
GPT

Files Changed
- loadOptimizer.ts
- palletBuilder.ts

Tests
32 / 32 PASS

Messages
18

Benchmark
Loading Efficiency +7.3%
Pallet Usage -23%

Review
GPT REVIEWING
```

---

# 29. 첫 번째 실제 프로젝트

첫 프로젝트는 다음으로 지정한다.

```text
Container Loading Simulator
```

첫 테스트 Task:

```text
TASK-001

박스 직접 적재 + 파렛트 적재 혼합 최적화
```

목표:

```text
파렛트 과다 사용 방지
직접 박스 적재 허용
혼합 적재 허용
최대 적층단 준수
중량 중심 유지
하역순서 유지
미적재 최소화
컨테이너 공간 효율 최대화
```

---

# 30. 첫 번째 AI 대화 예시

GPT:

```text
현재 자동 적재 알고리즘을 분석했다.
파렛트 후보를 지나치게 일찍 확정하면서 직접 박스 적재 가능성을 제거하고 있다.

Claude에게 요청:
loadOptimizer 내부의 pallet grouping 이후 흐름을 독립적으로 검토해라.
```

Claude:

```text
검토 완료.

GPT 분석에 동의한다.
추가로 대형 박스를 먼저 직접 적재하면 후방 공간 단편화 문제가 발생할 가능성이 있다.

Hybrid scoring 방식을 제안한다.
```

GPT:

```text
제안 검토 완료.

Prototype A를 구현한다.

Claude는 다른 방식의 Prototype B를 구현해라.
두 결과를 benchmark로 비교한다.
```

---

# 31. MVP 개발 단계

## PHASE 1

AI Office 기본 서버

```text
Project 관리
Task 관리
Agent 관리
Message 관리
```

## PHASE 2

GPT 연결

```text
GPT API
Tool calling
Task Context
Message 처리
```

## PHASE 3

Claude 연결

```text
Claude API
Task Context
Message 처리
```

## PHASE 4

Agent-to-Agent Messaging

```text
GPT ↔ Claude
```

## PHASE 5

GitHub 연결

```text
Branch 생성
Diff 확인
Commit
PR
```

## PHASE 6

Sandbox 실행

```text
npm install
build
test
lint
playwright
```

## PHASE 7

Cross Review

```text
GPT 구현 → Claude 검수
Claude 구현 → GPT 검수
```

## PHASE 8

UI Dashboard

```text
Agent Status
Task Board
AI Chat
Test Result
Project Status
```

---

# 32. 1차 MVP 완료 조건

다음 시나리오가 자동으로 작동하면 MVP 완료로 판단한다.

```text
USER
↓
Task 생성
↓
GPT 또는 Claude Task Claim
↓
문제 분석
↓
상대 Agent에게 질문 가능
↓
상대 Agent 답변
↓
구현
↓
Git Branch 생성
↓
코드 변경
↓
Test 실행
↓
상대 Agent Review
↓
FAIL 시 재수정
↓
PASS
↓
PR 생성
↓
USER 최종 승인
```

---

# 33. 절대 하지 말아야 할 구조

다음 방식은 금지한다.

```text
GPT = 무조건 기획
Claude = 무조건 개발
```

둘 다 모든 업무를 할 수 있어야 한다.

또한 다음도 금지한다.

```text
AI가 대화만 하고 실제 코드 수정 안 함
AI가 테스트 없이 DONE 처리
AI가 자기 코드 자기 승인
AI가 같은 파일을 동시에 수정
AI가 무한 토론
AI가 실패한 테스트를 삭제
AI가 기존 기능을 제거해서 PASS
```

---

# 34. 최종 목표

PURPLE AI OFFICE의 목표는 AI들이 대화하는 모습을 보여주는 것이 아니다.

최종 목표는 다음과 같다.

```text
사용자가 목표를 지시한다.

GPT와 Claude가
서로 질문하고,
서로 검토하고,
서로 구현하고,
서로 테스트하고,
서로 반박하고,
실제 코드와 테스트 결과를 기반으로
프로젝트를 지속적으로 완성한다.
```

즉:

> **AI CHAT이 목적이 아니라 AI COLLABORATION이 목적이다.**

---

# 35. 개발 시작 명령

AI 개발 Agent에게 다음 지시부터 수행하게 한다.

```text
이 문서를 PURPLE AI OFFICE의 최상위 개발 명세로 사용한다.

우선 Phase 1부터 시작한다.

1. Next.js + TypeScript 프로젝트 구조를 분석한다.
2. Supabase 기반 DB schema를 설계한다.
3. projects / tasks / agents / agent_messages / agent_runs / test_results / decisions / artifacts 테이블을 만든다.
4. AI Office Dashboard 기본 UI를 만든다.
5. GPT Agent와 Claude Agent를 등록할 수 있는 Agent Manager를 구현한다.
6. Task를 생성하고 두 Agent 중 하나에게 배정할 수 있게 만든다.
7. Agent 간 메시지 모델을 구현한다.
8. 다음 단계에서 실제 OpenAI / Anthropic API를 연결할 수 있도록 Provider Adapter 구조로 설계한다.

처음부터 모든 기능을 한 번에 구현하지 않는다.

각 Phase를 완료할 때마다:

- 구현
- 테스트
- Cross Review
- 결과 기록

을 수행한다.

기존 기능을 삭제하거나 임시 우회하여 테스트를 통과시키는 것은 금지한다.

모든 변경 사항은 Git으로 추적한다.
```

---

# 36. 최종 운영 원칙 요약

```text
USER = CEO

GPT = AI Engineer
Claude = AI Engineer

둘은 동급

둘 다:
PLAN
CODE
TEST
REVIEW
DEBUG

가능

자기 작업 자기 최종승인 금지

의견 충돌 → TEST
TEST로 결정 불가 → USER

모든 작업 → Git 기록
모든 결정 → Memory 기록
모든 완료 → Cross Review 필수
```

---

**문서 버전:** v1.1 (0절 개정: GitHub 작업장, 봇 계정 분리, 금액 상한, 큐 워커, 기억 분리)  
**프로젝트:** PURPLE AI OFFICE  
**초기 Agent:** GPT + Claude  
**초기 적용 프로젝트:** Container Loading Simulator
