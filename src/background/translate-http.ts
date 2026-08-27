import { ApiError, parseRetryAfter, withRetry } from './retry';
import type { ProviderClientOptions } from './provider';

export async function fetchTranslation(
  name: string,
  url: string,
  init: RequestInit,
  options: ProviderClientOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return withRetry(async () => {
    if (signal?.aborted) throw new Error('任务已取消');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status === 429) throw new ApiError(429, `${name}翻译请求过于频繁（429）`, parseRetryAfter(response.headers.get('Retry-After')));
      if (!response.ok) throw new ApiError(response.status, `${name}翻译请求失败（${response.status}）`);
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal?.aborted) throw new Error('任务已取消');
      throw new Error(controller.signal.aborted ? `${name}翻译请求超时（${timeoutMs}ms）` : `${name}翻译请求失败`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }, { retries: 2, sleep: options.sleep, signal });
}

export function mapGoogleLanguage(language: string): string {
  return ({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', pt: 'pt-PT' } as Record<string, string>)[language] ?? language;
}

export function mapBingLanguage(language: string): string {
  return ({ 'zh-Hans': 'zh-Hans', 'zh-Hant': 'zh-Hant', pt: 'pt-pt' } as Record<string, string>)[language] ?? language;
}
