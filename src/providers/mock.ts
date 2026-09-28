import type { AgentProvider, ProviderResult, TaskContext } from './types';
import { setTimeout as delay } from 'node:timers/promises';

/** Deterministic mock data; no DB access, credentials or external model calls. */
export class MockProvider implements AgentProvider {
  readonly id = 'mock';
  constructor(private latencyMs=0) {}
  async respond({ task, signal }: { task: TaskContext; signal?:AbortSignal }): Promise<ProviderResult> {
    if(this.latencyMs) await delay(this.latencyMs,undefined,{signal});
    const result: ProviderResult = { replies: [], usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 } };
    const say = (message: string, recipient: 'lead'|'reviewer'|'ceo' = 'lead', type: ProviderResult['replies'][number]['type'] = 'STATUS') => {
      result.replies.push({ message, recipient, type, requiresResponse: recipient !== 'ceo' });
    };
    switch (task.status) {
      case 'NEW': result.statusChange='ANALYZING'; say(`${task.title}: 수락 조건을 분석합니다.`); break;
      case 'ANALYZING': result.statusChange='DISCUSSION'; say('구현 범위와 검증 항목을 토론합니다.'); break;
      case 'DISCUSSION':
        if (task.actorId===task.reviewerAgent) say('수락 조건 전체를 포함하고 경계값도 검증합시다.','lead','ANSWER');
        else if (task.discussionRounds===0) say('정상·경계·실패 사례를 모두 포함할까요?','reviewer','QUESTION');
        else { result.statusChange='PLANNED'; result.evidence={plan:'수락 조건별 구현 및 회귀 테스트 계획'}; say('계획을 기록했습니다.','lead','PROPOSAL'); }
        break;
      case 'PLANNED': result.statusChange='IMPLEMENTING'; say('Mock 구현을 시작합니다.'); break;
      case 'IMPLEMENTING': case 'FIXING':
        result.statusChange='CROSS_REVIEW'; result.evidence={artifact:`Mock 산출물: ${task.acceptanceCriteria.join(', ')}`};
        say('산출물 검수를 요청합니다.','reviewer','REVIEW_REQUEST'); break;
      case 'CROSS_REVIEW':
        if (task.reviewRound===1) { result.statusChange='FIXING'; result.evidence={review:'FAIL'}; say('수정 요청: 경계값 사례를 보강해 주세요.','lead','REVIEW_RESULT'); }
        else { result.statusChange='TESTING'; result.evidence={review:'PASS'}; say('검수 승인. 수락 조건 전체를 확인했습니다.','reviewer','REVIEW_RESULT'); }
        break;
      case 'TESTING': result.statusChange='WAITING_USER'; result.evidence={tests:'PASS'}; say('Mock 단위·회귀 테스트 통과. 대표 승인을 기다립니다.','ceo','TEST_RESULT'); break;
      default: throw new Error('MOCK_TASK_NOT_RUNNABLE');
    }
    return result;
  }
}
