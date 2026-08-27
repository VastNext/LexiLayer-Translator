import { describe, expect, it, vi } from 'vitest';

import { BingTranslateClient } from '../../src/background/bing-translate-client';
import { GoogleTranslateClient } from '../../src/background/google-translate-client';

const request = {
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  segments: [{ id: 'one', text: 'Hello' }, { id: 'two', text: 'World' }],
};

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('GoogleTranslateClient', () => {
  it('自动检测源语言时发送 sl=auto，且使用实际批量端点形状', async () => {
    const fetch = vi.fn().mockResolvedValue(response([['你好'], ['世界']]));

    await new GoogleTranslateClient({ fetch }).translate({ ...request, sourceLanguage: 'auto' });

    const url = new URL(fetch.mock.calls[0][0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://translate.googleapis.com/translate_a/t');
    expect(url.searchParams.get('sl')).toBe('auto');
    expect(url.searchParams.get('client')).toBe('gtx');
    expect(url.searchParams.get('dt')).toBe('t');
  });

  it('发送匿名表单 POST、多 q 参数并映射语言', async () => {
    const fetch = vi.fn().mockResolvedValue(response([['你好'], ['世界']]));
    const client = new GoogleTranslateClient({ fetch });
    await expect(client.translate(request)).resolves.toEqual([{ id: 'one', text: '你好' }, { id: 'two', text: '世界' }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=en&tl=zh-CN');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
    expect(new URLSearchParams(init.body).getAll('q')).toEqual(['Hello', 'World']);
  });

  it('解析常见嵌套数组响应', async () => {
    const fetch = vi.fn().mockResolvedValue(response([[['你', 'You']], [['好', 'good']]]));
    await expect(new GoogleTranslateClient({ fetch }).translate(request)).resolves.toEqual([{ id: 'one', text: '你' }, { id: 'two', text: '好' }]);
  });

  it('按协议拼接同一输入的多个翻译片段，不混入原文和元数据', async () => {
    const fetch = vi.fn().mockResolvedValue(response([
      [[['你', 'You', null, null], ['好', 'are good', null, null]], 'en', { confidence: 1 }],
    ]));

    await expect(new GoogleTranslateClient({ fetch }).translate({ ...request, segments: [{ id: 'one', text: 'You are good' }] }))
      .resolves.toEqual([{ id: 'one', text: '你好' }]);
  });

  it('429 最多重试两次并给出明确脱敏错误', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ error: 'secret endpoint detail' }, 429));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(new GoogleTranslateClient({ fetch, sleep }).translate(request)).rejects.toThrow('Google 翻译请求过于频繁（429）');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('支持外部取消', async () => {
    const fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const controller = new AbortController();
    const result = new GoogleTranslateClient({ fetch }).translate(request, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow('任务已取消');
  });
});

describe('BingTranslateClient', () => {
  it('发送匿名 JSON 字符串数组并映射语言', async () => {
    const fetch = vi.fn().mockResolvedValue(response([{ translations: [{ text: '你好' }] }, { translations: [{ text: '世界' }] }]));
    const client = new BingTranslateClient({ fetch });
    await expect(client.translate({ ...request, sourceLanguage: 'auto', targetLanguage: 'zh-Hant' })).resolves.toEqual([{ id: 'one', text: '你好' }, { id: 'two', text: '世界' }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://edge.microsoft.com/translate/translatetext?to=zh-Hant&isEnterpriseClient=false');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual(['Hello', 'World']);
  });

  it('严格拒绝响应数量或结构不匹配', async () => {
    const fetch = vi.fn().mockResolvedValue(response([{ translations: [{ text: '只有一个' }] }]));
    await expect(new BingTranslateClient({ fetch }).translate(request)).rejects.toThrow('Bing 翻译响应格式无效');
  });

  it('映射 pt 并保留显式源语言', async () => {
    const fetch = vi.fn().mockResolvedValue(response([{ translations: [{ text: 'a' }] }, { translations: [{ text: 'b' }] }]));
    await new BingTranslateClient({ fetch }).translate({ ...request, targetLanguage: 'pt' });
    expect(fetch.mock.calls[0][0]).toContain('?to=pt-pt&isEnterpriseClient=false&from=en');
  });
});
