"use client";
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "Idempotency-Key": key ?? crypto.randomUUID(),
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error ?? "REQUEST_FAILED", response.status);
  return data;
}
const errors: Record<string, string> = {
  AUTH_REQUIRED: "로그인이 만료되었어요. 다시 로그인해 주세요.",
  CEO_REQUIRED: "등록된 대표 계정만 이용할 수 있어요.",
  INVALID_CREDENTIALS: "이메일과 비밀번호를 확인해 주세요.",
  SERVER_NOT_CONFIGURED: "서버 연결 설정이 필요합니다.",
  SERVER_UNAVAILABLE: "서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.",
  INVALID_INPUT: "입력 항목을 확인해 주세요.",
  BUDGET_STILL_EXCEEDED:
    "아직 예산을 초과하고 있어요. 예산을 먼저 늘려 주세요.",
  LIMIT_STILL_EXCEEDED:
    "반복 한도를 초과했어요. 취소 후 새 작업을 만들어 주세요.",
  UNKNOWN_OUTCOME_CANCEL_ONLY: "결과를 알 수 없는 실행은 취소만 할 수 있어요.",
  ORIGIN_DENIED:
    "현재 주소의 요청을 허용하도록 서버 주소 설정을 확인해 주세요.",
  AGENT_BUSY: "에이전트가 다른 작업을 처리 중이에요.",
  TASK_NOT_RUNNABLE: "현재 작업은 실행을 기다리는 상태예요.",
  STEP_NOT_DUE: "다음 단계의 실행 시간이 아직 되지 않았어요.",
};
export function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? (errors[error.code] ??
        "요청을 완료하지 못했어요. 상태를 새로고침한 뒤 다시 시도해 주세요.")
    : "연결이 끊겼어요. 다시 시도해 주세요.";
}
