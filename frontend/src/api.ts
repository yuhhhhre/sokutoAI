let csrfToken = "";
export function setCsrfToken(value: string) {
  csrfToken = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api/${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      "X-CSRFToken": csrfToken,
      ...options.headers,
    },
  });
  const result = await response
    .json()
    .catch(() => ({ error: "サーバーからの応答を読み取れませんでした。" }));
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      result.error || "処理を完了できませんでした。",
      response.status,
      result.code,
    );
  }
  return result as T;
}
export function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "通信に失敗しました。接続を確認して再試行してください。";
}
