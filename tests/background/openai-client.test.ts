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
    expect(sleep.mock.calls).toEqual([[2000], [2000]]);
  });
});
