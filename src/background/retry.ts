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

function abortError(): Error {
  return new Error('任务已取消');
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      reject(abortError());
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function isRetryable(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 429 || error.status >= 500);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    retries?: number;
    signal?: AbortSignal;
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? abortableSleep;

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error) || attempt >= retries) throw error;
      await sleep(Math.min(error.retryAfterMs ?? 500 * 2 ** attempt, 30_000), options.signal);
    }
  }
}
