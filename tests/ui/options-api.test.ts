import { describe, expect, it, vi } from 'vitest';

import { browserIdentityFromNavigator, createOptionsApi } from '../../src/options/api';
import { DEFAULT_SETTINGS, type CustomAiEngine } from '../../src/shared/config';

const custom: CustomAiEngine = {
  id: 'custom-work', kind: 'custom-ai', name: '工作接口', enabled: true, order: 2,
  baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'secret',
};

describe('Options v2 API', () => {
  it('从 Navigator 提取生产入口使用的浏览器身份', () => {
    expect(browserIdentityFromNavigator({
      userAgent: 'Mozilla/5.0 Edg/140',
      userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] },
    })).toEqual({
      brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }],
      userAgent: 'Mozilla/5.0 Edg/140',
    });
  });

  it('load 返回逐实例 hasApiKey 的 safe settings，不恢复任何 key', async () => {
    const safe = { ...DEFAULT_SETTINGS, engines: [...DEFAULT_SETTINGS.engines, { ...custom, apiKey: undefined, hasApiKey: true }] };
    const sendMessage = vi.fn(async () => ({ ok: true, data: safe }));
    const loaded = await createOptionsApi({ runtime: { sendMessage } }).load();
    expect(loaded.engines).toContainEqual(expect.objectContaining({ id: custom.id, baseUrl: custom.baseUrl, model: custom.model, hasApiKey: true }));
    expect(JSON.stringify(loaded)).not.toContain('apiKey');
  });

  it('为多实例 CRUD、排序、启停、主题、测试、清 key 与导入提供固定消息', async () => {
    const messages: unknown[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      messages.push(message);
      return (message as { type: string }).type === 'get-options-settings' ? { ok: true, data: DEFAULT_SETTINGS } : { ok: true };
    });
    const api = createOptionsApi({ runtime: { sendMessage } });
    await api.load();
    await api.getEngineApiKey(custom.id);
    await api.upsertEngine(custom);
    await api.setActiveEngine(custom.id);
    await api.setEngineEnabled(custom.id, false);
    await api.saveTheme('sage-global');
    await api.reorderEngines(['google', 'bing', custom.id]);
    await api.testEngine(custom.id, { ...custom, apiKey: '' });
    await api.clearEngineApiKey(custom.id);
    await api.deleteEngine(custom.id);
    await api.importSettings(DEFAULT_SETTINGS);
    expect(messages.slice(1)).toEqual([
      { type: 'get-engine-api-key', engineId: custom.id },
      { type: 'upsert-engine', engine: custom },
      { type: 'set-active-engine', engineId: custom.id },
      { type: 'set-engine-enabled', engineId: custom.id, enabled: false },
      { type: 'save-theme', theme: 'sage-global' },
      { type: 'reorder-engines', engineIds: ['google', 'bing', custom.id] },
      { type: 'test-engine', engineId: custom.id, candidate: { ...custom, apiKey: '' } },
      { type: 'clear-engine-api-key', engineId: custom.id },
      { type: 'delete-engine', engineId: custom.id },
      { type: 'import-settings', settings: DEFAULT_SETTINGS },
    ]);
  });

  it('只从专用消息响应读取 API Key', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, data: { key: 'secret-value' } }));
    await expect(createOptionsApi({ runtime: { sendMessage } }).getEngineApiKey('custom-work')).resolves.toBe('secret-value');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'get-engine-api-key', engineId: 'custom-work' });
  });

  it('不再暴露可整体覆写含密钥设置的旧 saveSettings API', () => {
    const api = createOptionsApi({ runtime: { sendMessage: vi.fn() } });

    expect(api).not.toHaveProperty('saveSettings');
  });

  it('导入 API Key 只有显式允许时才附带 allowApiKeys', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const api = createOptionsApi({ runtime: { sendMessage } });

    await api.importSettings({ schemaVersion: 2 });
    await api.importSettings({ schemaVersion: 2 }, true);

    expect(sendMessage).toHaveBeenNthCalledWith(1, { type: 'import-settings', settings: { schemaVersion: 2 } });
    expect(sendMessage).toHaveBeenNthCalledWith(2, { type: 'import-settings', settings: { schemaVersion: 2 }, allowApiKeys: true });
  });

  it('读取页面翻译快捷键，并把 API reject 隔离为不可用状态', async () => {
    const getAll = vi.fn()
      .mockResolvedValueOnce([{ name: 'translate_page', shortcut: 'Ctrl+Shift+Y' }])
      .mockRejectedValueOnce(new Error('commands unavailable'));
    const api = createOptionsApi({
      runtime: { sendMessage: vi.fn() },
      commands: { getAll },
      tabs: { create: vi.fn() },
    });

    await expect(api.getPageTranslationShortcut()).resolves.toEqual({
      status: 'assigned', shortcut: 'Ctrl+Shift+Y', displayShortcut: 'Ctrl + Shift + Y',
    });
    await expect(api.getPageTranslationShortcut()).resolves.toEqual({ status: 'unavailable', reason: 'api-error' });
  });

  it.each([
    ['Edge 品牌', { brands: [{ brand: 'Microsoft Edge' }], userAgent: 'Chrome/140' }, 'edge://extensions/shortcuts'],
    ['Edge userAgent', { brands: [{ brand: 'Chromium' }], userAgent: 'Edg/140' }, 'edge://extensions/shortcuts'],
    ['Chrome', { brands: [{ brand: 'Google Chrome' }], userAgent: 'Chrome/140' }, 'chrome://extensions/shortcuts'],
    ['未知 Chromium', { brands: [{ brand: 'Custom Chromium' }], userAgent: 'Custom/1' }, 'chrome://extensions/shortcuts'],
    ['无品牌信息', undefined, 'chrome://extensions/shortcuts'],
  ])('%s 使用正确的快捷键管理页', async (_name, browserIdentity, expectedUrl) => {
    const create = vi.fn(async () => ({ id: 1 }));
    const api = createOptionsApi({
      runtime: { sendMessage: vi.fn() },
      commands: { getAll: vi.fn() },
      tabs: { create },
    }, browserIdentity);

    await expect(api.openShortcutSettings()).resolves.toEqual({ ok: true, manualUrl: expectedUrl });
    expect(create).toHaveBeenCalledWith({ url: expectedUrl });
  });

  it('打开管理页失败时只返回结构化失败和手动地址', async () => {
    const api = createOptionsApi({
      runtime: { sendMessage: vi.fn() },
      commands: { getAll: vi.fn() },
      tabs: { create: vi.fn(async () => { throw new Error('browser-specific failure'); }) },
    }, { brands: [{ brand: 'Microsoft Edge' }], userAgent: 'Edg/140' });

    await expect(api.openShortcutSettings()).resolves.toEqual({
      ok: false,
      manualUrl: 'edge://extensions/shortcuts',
    });
  });
});
