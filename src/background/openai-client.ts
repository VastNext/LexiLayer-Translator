import { createTranslationMessages, parseTranslationResponse, type TranslationRequest, type TranslationResult } from '../shared/messages';
import { buildChatCompletionsUrl } from '../shared/url';
import { ApiError, parseRetryAfter, withRetry } from './retry';
import { SseParser } from './sse';

interface OpenAiClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ResponseHandle {
  response: Response;
  controller: AbortController;
  externalSignal?: AbortSignal;
  timeoutMs: number;
  cleanup(): void;
}

function readResponseContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('API 响应格式无效');
  }

  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('API 响应格式无效');
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) throw new Error('API 响应格式无效');
  const message = (choice as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new Error('API 响应格式无效');
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string') throw new Error('API 响应格式无效');
  return content;
}

export class OpenAiClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: OpenAiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult[]> {
    return withRetry(async () => {
      if (signal?.aborted) throw new Error('任务已取消');
      const first = await this.send(request, true, signal);
      try {
        if (first.response.status === 400 && await this.isResponseFormatUnsupported(first.response)) {
          first.cleanup();
          const fallback = await this.send(request, false, signal);
          try {
            return await this.readTranslations(fallback, request);
          } finally {
            fallback.cleanup();
          }
        }
        return await this.readTranslations(first, request);
      } finally {
        first.cleanup();
      }
    }, { sleep: this.options.sleep, signal });
  }

  async *streamText(
    text: string,
    sourceLanguage: string,
    targetLanguage: string,
    signal?: AbortSignal,
    userInstruction?: string,
    context?: string,
  ): AsyncGenerator<string> {
    const maxRetries = 10;
    let emitted = '';
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw new Error('任务已取消');
      const handle = await this.sendRaw({
        model: this.options.model,
        messages: [
          {
            role: 'system',
            content: [
              `将用户文本从 ${sourceLanguage} 翻译为 ${targetLanguage}，只输出译文。`,
              emitted ? `上一次流已输出以下译文：${emitted}\n请只继续输出尚未完成的部分，不要重复已有译文。` : '',
              userInstruction?.trim(),
              context ? `以下邻近文本仅用于消歧，不要翻译或输出：${context}` : '',
            ].filter(Boolean).join('\n'),
          },
          { role: 'user', content: emitted ? `${text}\n\n已有译文：${emitted}` : text },
        ],
        temperature: 0,
        stream: true,
      }, signal);
      let reader: ReadableStreamDefaultReader<string> | undefined;
      try {
        if (!handle.response.ok) throw new ApiError(handle.response.status, undefined, parseRetryAfter(handle.response.headers.get('Retry-After')));
        if (!handle.response.body) throw new Error('API 未返回流式内容');

        const parser = new SseParser();
        reader = handle.response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const result = parser.push(value);
          if (result.fallback) throw new Error('流式响应格式无效');
          for (const chunk of result.chunks) {
            const next = this.continuation(chunk, emitted);
            if (next) { emitted += next; yield next; }
          }
          if (result.done) return;
        }
        const final = parser.finish();
        if (final.fallback) throw new Error('流式响应格式无效');
        for (const chunk of final.chunks) {
          const next = this.continuation(chunk, emitted);
          if (next) { emitted += next; yield next; }
        }
        throw new Error('流式响应在完成前断开');
      } catch (error) {
        this.throwRequestAbort(handle, error);
        const retryable = error instanceof ApiError
          ? error.status === 408 || error.status === 429 || error.status >= 500
          : error instanceof Error && (
            error.message === '流式响应在完成前断开'
            || /stream disconnected|stream closed before response\.completed|upstream_error/i.test(error.message)
          );
        if (!retryable || attempt >= maxRetries) throw error;
        await (this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(
          Math.min(error instanceof ApiError && error.retryAfterMs !== undefined ? error.retryAfterMs : 500 * 2 ** attempt, 30_000), signal,
        );
      } finally {
        await reader?.cancel().catch(() => undefined);
        handle.cleanup();
      }
    }
  }

  private continuation(chunk: string, emitted: string): string {
    if (!emitted || !chunk.startsWith(emitted)) return chunk;
    return chunk.slice(emitted.length);
  }

  private async send(request: TranslationRequest, useResponseFormat: boolean, signal?: AbortSignal): Promise<ResponseHandle> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: createTranslationMessages(request),
      temperature: 0,
    };
    if (useResponseFormat) body.response_format = { type: 'json_object' };

    return this.sendRaw(body, signal);
  }

  private async sendRaw(body: Record<string, unknown>, externalSignal?: AbortSignal): Promise<ResponseHandle> {
    const timeoutMs = this.options.timeoutMs ?? 45_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await this.fetch(buildChatCompletionsUrl(this.options.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let cleaned = false;
      return {
        response,
        controller,
        externalSignal,
        timeoutMs,
        cleanup() {
          if (cleaned) return;
          cleaned = true;
          clearTimeout(timeout);
          externalSignal?.removeEventListener('abort', abort);
        },
      };
    } catch {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
      if (externalSignal?.aborted) throw new Error('任务已取消');
      throw new Error(controller.signal.aborted ? `API 请求超时（${timeoutMs}ms）` : 'API 请求失败');
    }
  }

  private async isResponseFormatUnsupported(response: Response): Promise<boolean> {
    const body = await response.clone().text();
    return /response_format/i.test(body)
      && /does not support|not supported|unsupported|unknown parameter|unrecognized|extra fields?/i.test(body);
  }

  private async readTranslations(handle: ResponseHandle, request: TranslationRequest): Promise<TranslationResult[]> {
    const { response } = handle;
    if (!response.ok) {
      throw new ApiError(response.status, undefined, parseRetryAfter(response.headers.get('Retry-After')));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      this.throwRequestAbort(handle, error);
      throw new Error('API 响应不是有效 JSON');
    }
    const content = readResponseContent(payload);

    return parseTranslationResponse(content, request.segments.map(({ id }) => id));
  }

  private throwRequestAbort(handle: ResponseHandle, error: unknown): void {
    if (handle.externalSignal?.aborted) throw new Error('任务已取消');
    if (handle.controller.signal.aborted) throw new Error(`API 请求超时（${handle.timeoutMs}ms）`);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
  }
}
