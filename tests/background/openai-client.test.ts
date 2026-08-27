import { describe, expect, it, vi } from 'vitest';

import { OpenAiClient } from '../../src/background/openai-client';

const request = {
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  segments: [{ id: 'p1', text: 'Hello' }],
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('OpenAiClient', () => {
  it('响应头返回后响应体永不结束时仍由请求超时中止', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    });
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch, timeoutMs: 25,
    });

    const translation = client.translate(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(24);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(translation).resolves.toMatchObject({ message: 'API 请求超时（25ms）' });
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('响应头返回后外部取消仍中止未完成的响应体消费', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    });
    const client = new OpenAiClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch });
    const controller = new AbortController();

    const translation = client.translate(request, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();

    await expect(translation).resolves.toMatchObject({ message: '任务已取消' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('流式响应头返回后外部取消会中止 reader 并释放响应句柄', async () => {
    let requestSignal: AbortSignal | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      responseBody = body;
      return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    });
    const client = new OpenAiClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch });
    const controller = new AbortController();
    const consume = (async () => {
      for await (const _chunk of client.streamText('Hello', 'en', 'zh-Hans', controller.signal)) { /* 等待取消。 */ }
    })().catch((error: unknown) => error);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    controller.abort();

    await expect(consume).resolves.toMatchObject({ message: '任务已取消' });
    expect(requestSignal?.aborted).toBe(true);
    expect((responseBody as ReadableStream<Uint8Array> | null)?.locked).toBe(false);
  });

  it('每次请求默认 45 秒超时并清理计时器', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    const translation = client.translate(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(translation).resolves.toMatchObject({ message: 'API 请求超时（45000ms）' });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('请求成功后清理超时计时器', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"translations":[{"id":"p1","text":"你好"}]}' } }],
    }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    await client.translate(request);

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('任务取消会中止正在进行的批量翻译请求', async () => {
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });
    const controller = new AbortController();
    const translation = client.translate(request, controller.signal).catch((error: unknown) => error);
    controller.abort();
    await expect(translation).resolves.toMatchObject({ message: '任务已取消' });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('将底层请求异常转换为不包含 API Key 的稳定错误', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('socket failed with sk-secret'));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    const error = await client.translate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'API 请求失败' });
    expect(String(error)).not.toContain('sk-secret');
  });

  it('请求 Chat Completions 并返回经过 ID 校验的译文', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify({ translations: [{ id: 'p1', text: '你好' }] }) } }],
    }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret',
      model: 'gpt-test',
      fetch,
    });

    await expect(client.translate(request)).resolves.toEqual([{ id: 'p1', text: '你好' }]);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-secret' }),
      }),
    );
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('服务拒绝 response_format 时不带该字段回退一次', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'response_format is not supported' } }, 400))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: '{"translations":[{"id":"p1","text":"你好"}]}' } }],
      }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    await expect(client.translate(request)).resolves.toEqual([{ id: 'p1', text: '你好' }]);
    expect(JSON.parse(fetch.mock.calls[1][1].body as string)).not.toHaveProperty('response_format');
  });

  it.each([
    'Unknown parameter: response_format',
    'Unrecognized request argument supplied: response_format',
    'Extra fields not permitted: response_format',
    'This model does not support response_format',
  ])('遇到典型兼容错误“%s”时回退一次', async (message) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message } }, 400))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: '{"translations":[{"id":"p1","text":"你好"}]}' } }],
      }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    await expect(client.translate(request)).resolves.toEqual([{ id: 'p1', text: '你好' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('response_format 回退后的失败正常报错且不再请求', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Unknown parameter: response_format' } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'sk-secret invalid request' } }, 400));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    const error = await client.translate(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 400, message: 'API 请求失败（400）' });
    expect(String(error)).not.toContain('sk-secret');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('拒绝缺失、重复或未知 ID 的响应', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{"translations":[{"id":"other","text":"你好"}]}' } }],
    }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    await expect(client.translate(request)).rejects.toThrow('翻译响应 ID 不匹配');
  });

  it.each([
    null,
    [],
    { choices: null },
    { choices: [{}] },
    { choices: [{ message: 'invalid' }] },
  ])('将异常 OpenAI 顶层 payload %# 转换为受控错误', async (payload) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(payload));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });

    await expect(client.translate(request)).rejects.toThrow('API 响应格式无效');
  });

  it('429 尊重 Retry-After、无真实等待并在第三次请求成功', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: '限流' } }, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(jsonResponse({ error: { message: '限流' } }, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: '{"translations":[{"id":"p1","text":"你好"}]}' } }],
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch, sleep,
    });

    await expect(client.translate(request)).resolves.toEqual([{ id: 'p1', text: '你好' }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000, undefined], [2000, undefined]]);
  });

  it('流式划词把自定义要求和有限上下文真正写入 system prompt', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/work/v1', apiKey: 'work-key', model: 'work-model', fetch,
    });

    const chunks: string[] = [];
    for await (const chunk of client.streamText('Hello', 'en', 'zh-Hans', undefined, '使用正式语气', '附近文本')) chunks.push(chunk);

    expect(chunks).toEqual(['你好']);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: expect.stringContaining('使用正式语气') },
      { role: 'user', content: 'Hello' },
    ]);
    expect(body.messages[0].content).toContain('附近文本');
  });

  it('畸形 SSE 必须向调用方传播错误以触发非流式回退', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('data: {invalid\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const client = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', fetch,
    });
    const consume = async () => {
      for await (const _chunk of client.streamText('Hello', 'en', 'zh-Hans')) { /* 消费完整流。 */ }
    };

    await expect(consume()).rejects.toThrow('流式响应格式无效');
  });
});
