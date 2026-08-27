import { describe, expect, it, vi } from 'vitest';

import { createOptionsApi } from '../../src/options/api';
import { DEFAULT_SETTINGS, type CustomAiEngine } from '../../src/shared/config';

const custom: CustomAiEngine = {
  id: 'custom-work', kind: 'custom-ai', name: '工作接口', enabled: true, order: 2,
  baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'secret',
};

describe('Options v2 API', () => {
  it('load 返回逐实例 hasApiKey 的 safe settings，不恢复任何 key', async () => {
    const safe = { ...DEFAULT_SETTINGS, engines: [...DEFAULT_SETTINGS.engines, { ...custom, apiKey: undefined, hasApiKey: true }] };
    const sendMessage = vi.fn(async () => ({ ok: true, data: safe }));
    const loaded = await createOptionsApi({ runtime: { sendMessage } }).load();
    expect(loaded.engines).toContainEqual(expect.objectContaining({ id: custom.id, baseUrl: custom.baseUrl, model: custom.model, hasApiKey: true }));
    expect(JSON.stringify(loaded)).not.toContain('apiKey');
  });

  it('为多实例 CRUD、排序、启停、测试、清 key 与导入提供固定消息', async () => {
    const messages: unknown[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      messages.push(message);
      return (message as { type: string }).type === 'get-options-settings' ? { ok: true, data: DEFAULT_SETTINGS } : { ok: true };
    });
    const api = createOptionsApi({ runtime: { sendMessage } });
    await api.load();
    await api.upsertEngine(custom);
    await api.setActiveEngine(custom.id);
    await api.setEngineEnabled(custom.id, false);
    await api.reorderEngines(['google', 'bing', custom.id]);
    await api.testEngine(custom.id, { ...custom, apiKey: '' });
    await api.clearEngineApiKey(custom.id);
    await api.deleteEngine(custom.id);
    await api.importSettings(DEFAULT_SETTINGS);
    expect(messages.slice(1)).toEqual([
      { type: 'upsert-engine', engine: custom },
      { type: 'set-active-engine', engineId: custom.id },
      { type: 'set-engine-enabled', engineId: custom.id, enabled: false },
      { type: 'reorder-engines', engineIds: ['google', 'bing', custom.id] },
      { type: 'test-engine', engineId: custom.id, candidate: { ...custom, apiKey: '' } },
      { type: 'clear-engine-api-key', engineId: custom.id },
      { type: 'delete-engine', engineId: custom.id },
      { type: 'import-settings', settings: DEFAULT_SETTINGS },
    ]);
  });

  it('不再暴露可整体覆写含密钥设置的旧 saveSettings API', () => {
    const api = createOptionsApi({ runtime: { sendMessage: vi.fn() } });

    expect(api).not.toHaveProperty('saveSettings');
  });
});
