import { describe, expect, it, vi } from 'vitest';

import { createProvider, streamProviderSelection } from '../../src/background/provider-registry';
import type { Engine } from '../../src/shared/config';

const request = { sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'p1', text: 'Hello' }] };

describe('provider registry', () => {
  it.each([
    [{ id: 'google', kind: 'google', name: 'Google', enabled: true, order: 0 }, 'google'],
    [{ id: 'bing', kind: 'bing', name: 'Bing', enabled: true, order: 1 }, 'bing'],
  ] as const)('按 kind 路由内置 provider %#', (engine, identity) => {
    expect(createProvider(engine).cacheIdentity).toMatchObject({ engineId: identity });
  });

  it('自定义 AI 包装 OpenAiClient，并要求完整配置', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[{"id":"p1","text":"你好"}]}' } }] })));
    const engine: Engine = { id: 'custom-one', kind: 'custom-ai', name: 'One', enabled: true, order: 2, baseUrl: 'https://api.example.com/v1', model: 'gpt', apiKey: 'secret' };
    await expect(createProvider(engine, { fetch }).translate(request, new AbortController().signal)).resolves.toEqual([{ id: 'p1', text: '你好' }]);
    expect(() => createProvider({ ...engine, apiKey: '' })).toThrow('自定义 AI 配置不完整');
  });

  it('非流式 provider 的统一 selection 返回单 chunk', async () => {
    const provider = { translate: vi.fn().mockResolvedValue([{ id: 'selection', text: '你好' }]), testConnection: vi.fn(), capabilities: { streaming: false }, cacheIdentity: { engineId: 'fake', engineFingerprint: 'fake', adapterVersion: '1' } };
    const chunks: string[] = [];
    for await (const chunk of streamProviderSelection(provider, 'Hello', 'en', 'zh-Hans', undefined, undefined, new AbortController().signal)) chunks.push(chunk);
    expect(chunks).toEqual(['你好']);
    expect(provider.translate).toHaveBeenCalledWith(expect.not.objectContaining({ userInstruction: expect.anything() }), expect.any(AbortSignal));
  });

  it('内置 provider 的 selection 忽略自定义要求和有限上下文', async () => {
    const provider = { translate: vi.fn().mockResolvedValue([{ id: 'selection', text: '你好' }]), testConnection: vi.fn(), capabilities: { streaming: false }, cacheIdentity: { engineId: 'google', engineFingerprint: 'google', adapterVersion: '1' } };

    for await (const _chunk of streamProviderSelection(provider, 'Hello', 'en', 'zh-Hans', '使用正式语气', '附近文本', new AbortController().signal)) {
      // 消费统一流式接口。
    }

    expect(provider.translate).toHaveBeenCalledWith({
      sourceLanguage: 'en', targetLanguage: 'zh-Hans', segments: [{ id: 'selection', text: 'Hello' }],
    }, expect.any(AbortSignal));
  });
});
