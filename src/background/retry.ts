export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message = `API 请求失败（${status}）`,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isRetryable(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 429 || error.status >= 500);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    retries?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error) || attempt >= retries) throw error;
      await sleep(error.retryAfterMs ?? 500 * 2 ** attempt);
    }
  }
}
