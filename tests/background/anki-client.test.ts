import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnkiClient,
  AnkiClientError,
  type AnkiSyncResult,
} from '../../src/background/anki-client';
import type { AnkiPreferences } from '../../src/shared/anki';
import type { VocabularyEntry } from '../../src/shared/vocabulary';

const preferences: AnkiPreferences = {
  endpoint: 'https://anki.example.com/team/connect/',
  deck: 'LexiLayer 生词本',
  noteType: 'basic',
  hasApiKey: true,
};

const entry: VocabularyEntry = {
  id: 'entry-1',
  word: 'hello',
  sentence: 'Hello from the article.',
  translation: '你好',
  sourceUrl: 'https://example.com/article',
  pageTitle: 'Example article',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  createdAt: 1,
  updatedAt: 1,
};

function ankiResponse(result: unknown, error: unknown = null, status = 200): Response {
  return new Response(JSON.stringify({ result, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBody(fetch: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return JSON.parse(fetch.mock.calls[callIndex][1].body as string) as Record<string, unknown>;
}

function entries(count: number): VocabularyEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...entry,
    id: `entry-${index + 1}`,
    word: `word-${index + 1}`,
    sentence: `Sentence ${index + 1}.`,
  }));
}

function expectClientError(error: unknown, code: AnkiClientError['code']): void {
  expect(error).toBeInstanceOf(AnkiClientError);
  expect(error).toMatchObject({ code });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AnkiClient 连接测试', () => {
  it('远程 HTTPS 请求把 trim 后的 API Key 放在 JSON body，而不是 header', async () => {
    const fetch = vi.fn().mockResolvedValue(ankiResponse(6));
    const client = new AnkiClient({ fetch });

    await expect(client.testConnection(' https://anki.example.com/team/connect/ ', '  anki-secret  '))
      .resolves.toEqual({ version: 6 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://anki.example.com/team/connect');
    expect(fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    }));
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect(requestBody(fetch)).toEqual({ action: 'version', version: 6, key: 'anki-secret' });
  });

  it.each([
    'http://127.0.0.1:8765/',
    'http://localhost:8765/anki/',
    'http://[::1]:8765/connect/',
  ])('允许本机 HTTP 端点 %s', async (endpoint) => {
    const fetch = vi.fn().mockResolvedValue(ankiResponse(6));
    const client = new AnkiClient({ fetch });

    await expect(client.testConnection(endpoint)).resolves.toEqual({ version: 6 });
    expect(requestBody(fetch)).toEqual({ action: 'version', version: 6 });
  });

  it('在发出请求前拒绝远程 HTTP 端点', async () => {
    const fetch = vi.fn();
    const client = new AnkiClient({ fetch });

    await expect(client.testConnection('http://anki.example.com/team/connect')).rejects.toThrow('HTTPS');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('默认 10 秒超时，并以 timeout 分类', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = new AnkiClient({ fetch });

    const pending = client.testConnection('https://anki.example.com/connect', 'timeout-secret').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999);
    expect((fetch.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await pending;
    expectClientError(error, 'timeout');
    expect(String(error)).not.toContain('timeout-secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('外部 signal 可中止请求并清理内部计时器', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = new AnkiClient({ fetch });
    const controller = new AbortController();

    const pending = client.testConnection('https://anki.example.com/connect', undefined, controller.signal)
      .catch((error: unknown) => error);
    controller.abort();

    const error = await pending;
    expectClientError(error, 'network');
    expect(error).toMatchObject({ message: 'AnkiConnect 请求已取消' });
    expect((fetch.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('网络错误不泄漏 endpoint、API Key 或底层错误原文', async () => {
    const endpoint = 'https://anki.example.com/private/secret-path';
    const key = 'network-secret';
    const fetch = vi.fn().mockRejectedValue(new Error(`socket failed ${endpoint} ${key}`));
    const client = new AnkiClient({ fetch });

    const error = await client.testConnection(endpoint, key).catch((caught: unknown) => caught);

    expectClientError(error, 'network');
    expect(String(error)).not.toContain(endpoint);
    expect(String(error)).not.toContain('secret-path');
    expect(String(error)).not.toContain(key);
    expect(String(error)).not.toContain('socket failed');
  });

  it('可识别 CORS/Origin 拒绝并给出 webCorsOriginList 提示', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Blocked by CORS policy: origin is not allowed'));
    const client = new AnkiClient({ fetch });

    const error = await client.testConnection('https://anki.example.com/connect').catch((caught: unknown) => caught);

    expectClientError(error, 'cors');
    expect(error).toMatchObject({ message: expect.stringContaining('webCorsOriginList') });
    expect(String(error)).not.toContain('origin is not allowed');
  });

  it('HTTP 错误只暴露状态码，不暴露响应原文或密钥', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('server leaked http-secret and /private/path', { status: 503 }));
    const client = new AnkiClient({ fetch });

    const error = await client.testConnection('https://anki.example.com/private/path', 'http-secret')
      .catch((caught: unknown) => caught);

    expectClientError(error, 'http');
    expect(error).toMatchObject({ message: 'AnkiConnect 服务返回 HTTP 503' });
    expect(String(error)).not.toContain('http-secret');
    expect(String(error)).not.toContain('/private/path');
    expect(String(error)).not.toContain('server leaked');
  });

  it.each([401, 403])('HTTP %s 归类为 auth', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response('auth-secret invalid', { status }));
    const client = new AnkiClient({ fetch });

    const error = await client.testConnection('https://anki.example.com/connect', 'auth-secret')
      .catch((caught: unknown) => caught);

    expectClientError(error, 'auth');
    expect(String(error)).not.toContain('auth-secret');
  });

  it('AnkiConnect action 认证错误归类为 auth 且不回显原文', async () => {
    const fetch = vi.fn().mockResolvedValue(ankiResponse(null, 'valid api key auth-secret must be provided'));
    const client = new AnkiClient({ fetch });

    const error = await client.testConnection('https://anki.example.com/connect', 'auth-secret')
      .catch((caught: unknown) => caught);

    expectClientError(error, 'auth');
    expect(String(error)).not.toContain('auth-secret');
    expect(String(error)).not.toContain('must be provided');
  });

  it.each([
    new Response('not-json'),
    new Response(JSON.stringify({ result: 6 })),
    ankiResponse('6'),
    ankiResponse(5),
  ])('异常协议响应 %# 归类为 protocol', async (response) => {
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new AnkiClient({ fetch });

    const error = await client.testConnection('https://anki.example.com/connect', 'protocol-secret')
      .catch((caught: unknown) => caught);

    expectClientError(error, 'protocol');
    expect(String(error)).not.toContain('protocol-secret');
    expect(String(error)).not.toContain('not-json');
  });
});

describe('AnkiClient 同步', () => {
  it('目标 deck 不存在时先创建，再用固定去重选项 addNotes', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ankiResponse(6))
      .mockResolvedValueOnce(ankiResponse(['Default']))
      .mockResolvedValueOnce(ankiResponse(12345))
      .mockResolvedValueOnce(ankiResponse([9001, null]));
    const client = new AnkiClient({ fetch });

    const expected: AnkiSyncResult = { added: 1, skipped: 1, failed: 0 };
    await expect(client.sync([entry, { ...entry, id: 'entry-2', word: 'world' }], preferences, ' sync-secret '))
      .resolves.toEqual(expected);

    expect(fetch.mock.calls.map((_call, index) => requestBody(fetch, index).action))
      .toEqual(['version', 'deckNames', 'createDeck', 'addNotes']);
    expect(requestBody(fetch, 2)).toEqual({
      action: 'createDeck',
      version: 6,
      params: { deck: 'LexiLayer 生词本' },
      key: 'sync-secret',
    });
    const addNotesBody = requestBody(fetch, 3);
    expect(addNotesBody).toEqual(expect.objectContaining({ action: 'addNotes', version: 6, key: 'sync-secret' }));
    expect(addNotesBody.params).toEqual({
      notes: [
        expect.objectContaining({
          deckName: 'LexiLayer 生词本',
          modelName: 'Basic',
          fields: expect.objectContaining({ Front: 'hello' }),
          options: { allowDuplicate: false, duplicateScope: 'deck' },
        }),
        expect.objectContaining({
          options: { allowDuplicate: false, duplicateScope: 'deck' },
        }),
      ],
    });
  });

  it('目标 deck 已存在时不调用 createDeck', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ankiResponse(6))
      .mockResolvedValueOnce(ankiResponse(['Default', 'LexiLayer 生词本']))
      .mockResolvedValueOnce(ankiResponse([9001]));
    const client = new AnkiClient({ fetch });

    await expect(client.sync([entry], preferences)).resolves.toEqual({ added: 1, skipped: 0, failed: 0 });
    expect(fetch.mock.calls.map((_call, index) => requestBody(fetch, index).action))
      .toEqual(['version', 'deckNames', 'addNotes']);
  });

  it('每批最多发送 50 条 note', async () => {
    const batchSizes: number[] = [];
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        action: string;
        params?: { notes?: unknown[] };
      };
      if (body.action === 'version') return Promise.resolve(ankiResponse(6));
      if (body.action === 'deckNames') return Promise.resolve(ankiResponse(['LexiLayer 生词本']));
      const size = body.params?.notes?.length ?? 0;
      batchSizes.push(size);
      return Promise.resolve(ankiResponse(Array.from({ length: size }, (_, index) => index + 1)));
    });
    const client = new AnkiClient({ fetch });

    await expect(client.sync(entries(101), preferences)).resolves.toEqual({ added: 101, skipped: 0, failed: 0 });
    expect(batchSizes).toEqual([50, 50, 1]);
  });

  it('addNotes 的 number/null 分别统计为 added/skipped', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ankiResponse(6))
      .mockResolvedValueOnce(ankiResponse(['LexiLayer 生词本']))
      .mockResolvedValueOnce(ankiResponse([101, null, null, 102]));
    const client = new AnkiClient({ fetch });

    await expect(client.sync(entries(4), preferences)).resolves.toEqual({ added: 2, skipped: 2, failed: 0 });
  });

  it('整个 addNotes action 返回 error 时直接抛出，不伪造逐条统计', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(ankiResponse(6))
      .mockResolvedValueOnce(ankiResponse(['LexiLayer 生词本']))
      .mockResolvedValueOnce(ankiResponse(null, 'database failed with action-secret'));
    const client = new AnkiClient({ fetch });

    const error = await client.sync([entry], preferences, 'action-secret').catch((caught: unknown) => caught);

    expectClientError(error, 'protocol');
    expect(String(error)).not.toContain('database failed');
    expect(String(error)).not.toContain('action-secret');
  });

  it.each([
    ['deckNames', ankiResponse([1, 2])],
    ['createDeck', ankiResponse('deck-id')],
    ['addNotes length', ankiResponse([])],
    ['addNotes item', ankiResponse(['note-id'])],
  ])('拒绝非法 %s 协议结果', async (kind, invalidResponse) => {
    const responses = kind === 'deckNames'
      ? [ankiResponse(6), invalidResponse]
      : kind === 'createDeck'
        ? [ankiResponse(6), ankiResponse([]), invalidResponse]
        : [ankiResponse(6), ankiResponse(['LexiLayer 生词本']), invalidResponse];
    const fetch = vi.fn();
    responses.forEach((response) => fetch.mockResolvedValueOnce(response));
    const client = new AnkiClient({ fetch });

    const error = await client.sync([entry], preferences).catch((caught: unknown) => caught);
    expectClientError(error, 'protocol');
  });
});
