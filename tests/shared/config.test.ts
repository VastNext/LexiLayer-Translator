import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  MAX_CUSTOM_ENGINES,
  exportSafeSettings,
  getPublicEngineSummaries,
  importSettings,
  migrateSettings,
  normalizeSettings,
  resolveEngine,
  validateEngine,
  validateSettings,
  type CustomAiEngine,
  type Settings,
} from '../../src/shared/config';

const customEngine: CustomAiEngine = {
  id: 'custom-work',
  kind: 'custom-ai',
  name: '工作接口',
  enabled: true,
  order: 2,
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-test',
  apiKey: 'sk-super-secret',
};

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  activeEngineId: customEngine.id,
  engines: [...DEFAULT_SETTINGS.engines, customEngine],
};

describe('v2 settings', () => {
  it('默认启用 Google，并保留全部阅读偏好', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      schemaVersion: 2,
      activeEngineId: 'google',
      readingPreferences: {
        targetLanguage: 'auto',
        displayMode: 'bilingual',
        userInstruction: '',
        translationPosition: 'after',
        scanScope: 'whole-page',
        selectionContext: true,
      },
    });
    expect(resolveEngine(DEFAULT_SETTINGS)).toMatchObject({ id: 'google', kind: 'google' });
  });

  it('接受多个稳定 ID 的自定义 AI 实例', () => {
    const second = { ...customEngine, id: 'custom-personal', name: '个人接口', order: 3 };
    expect(validateSettings({ ...settings, engines: [...settings.engines, second] })).toEqual([]);
  });

  it('拒绝没有 ready 引擎或 active 未 ready 的设置', () => {
    const disabledBuiltins = DEFAULT_SETTINGS.engines.map((engine) => ({ ...engine, enabled: false }));
    expect(validateSettings({ ...settings, engines: [...disabledBuiltins, customEngine] })).toEqual([]);
    expect(validateSettings({ ...settings, engines: [...disabledBuiltins, { ...customEngine, apiKey: '' }] }))
      .toContain('至少保留一个可用的翻译引擎');
    expect(validateSettings({ ...settings, activeEngineId: 'google', engines: [...disabledBuiltins, customEngine] }))
      .toContain('当前翻译引擎必须可用');
  });

  it('解析引擎时不会返回已启用但未就绪的 active custom', () => {
    const invalidActive = {
      ...settings,
      engines: settings.engines.map((engine) => engine.id === customEngine.id ? { ...engine, apiKey: '' } : engine),
    };

    expect(resolveEngine(invalidActive)).toMatchObject({ id: 'google' });
  });

  it.each(['google', 'bing', '__proto__', 'constructor', 'custom bad', 'ai-1'])('拒绝自定义实例 ID %s', (id) => {
    expect(validateEngine({ ...customEngine, id })).not.toEqual([]);
  });

  it('拒绝重复 ID、远程 HTTP 和超过上限的自定义实例', () => {
    expect(validateSettings({ ...settings, engines: [...settings.engines, { ...customEngine }] })).toContain('翻译引擎 ID 不能重复');
    expect(validateEngine({ ...customEngine, baseUrl: 'http://api.example.com/v1' })).toContain('Base URL 仅允许 HTTPS，HTTP 仅限本机回环地址');
    const customEngines = Array.from({ length: MAX_CUSTOM_ENGINES + 1 }, (_, index) => ({
      ...customEngine,
      id: `custom-${index}`,
      order: index + 2,
    }));
    expect(validateSettings({ ...DEFAULT_SETTINGS, engines: [...DEFAULT_SETTINGS.engines, ...customEngines] })).toContain(`自定义翻译引擎不能超过 ${MAX_CUSTOM_ENGINES} 个`);
  });

  it('公开摘要不泄露连接配置和密钥', () => {
    expect(getPublicEngineSummaries(settings)).toEqual([
      { id: 'google', kind: 'google', name: 'Google', enabled: true, order: 0 },
      { id: 'bing', kind: 'bing', name: 'Bing', enabled: true, order: 1 },
      { id: 'custom-work', kind: 'custom-ai', name: '工作接口', enabled: true, order: 2 },
    ]);
  });
});

describe('migration and normalization', () => {
  it('迁移 v1 TranslatorConfig，保留偏好和有效 AI 配置，但默认使用 Google', () => {
    const legacy = {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'legacy-secret',
      model: 'legacy-model',
      targetLanguage: 'zh-Hans',
      displayMode: 'translation',
      userInstruction: '保留术语',
      translationPosition: 'before',
      scanScope: 'whole-page',
      selectionContext: false,
    };

    expect(migrateSettings(legacy)).toEqual({
      schemaVersion: 2,
      mvpDefaultsVersion: 1,
      readingPreferences: {
        targetLanguage: 'zh-Hans', displayMode: 'translation', userInstruction: '保留术语',
        translationPosition: 'before', scanScope: 'whole-page', selectionContext: false,
      },
      engines: [
        DEFAULT_SETTINGS.engines[0],
        DEFAULT_SETTINGS.engines[1],
        { ...customEngine, id: 'custom-migrated', name: '迁移的自定义 AI', order: 2, baseUrl: legacy.baseUrl, model: legacy.model, apiKey: legacy.apiKey },
      ],
      activeEngineId: 'google',
    });
  });

  it('v2 normalize 幂等，并对损坏存储安全回退', () => {
    const normalized = normalizeSettings(settings);
    expect(normalizeSettings(normalized)).toEqual(normalized);
    expect(normalizeSettings({ schemaVersion: 2, engines: [{ id: '__proto__' }] })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('broken')).toEqual(DEFAULT_SETTINGS);
  });

  it('normalize 修复 disabled active，优先回退到 ready 引擎而不是重置全部偏好', () => {
    const value = {
      ...settings,
      activeEngineId: 'google',
      engines: [
        { ...DEFAULT_SETTINGS.engines[0], enabled: false },
        { ...DEFAULT_SETTINGS.engines[1], enabled: false },
        customEngine,
      ],
    };

    expect(normalizeSettings(value)).toMatchObject({
      activeEngineId: 'custom-work',
      readingPreferences: settings.readingPreferences,
    });
  });

  it('旧 AI 配置损坏时仍迁移合法阅读偏好', () => {
    expect(migrateSettings({
      baseUrl: 'http://remote.example.com/v1', apiKey: '', model: '',
      targetLanguage: 'zh-Hant', displayMode: 'translation', userInstruction: '保留专名',
      translationPosition: 'before', scanScope: 'whole-page', selectionContext: false,
    })).toMatchObject({
      activeEngineId: 'google',
      readingPreferences: { targetLanguage: 'zh-Hant', displayMode: 'translation', userInstruction: '保留专名', translationPosition: 'before', scanScope: 'whole-page', selectionContext: false },
      engines: DEFAULT_SETTINGS.engines,
    });
  });
});

describe('safe export and secure import', () => {
  it('递归删除所有 apiKey，包括未知嵌套对象', () => {
    const exported = exportSafeSettings({ ...settings, metadata: { apiKey: 'nested-secret', nested: [{ apiKey: 'deep-secret' }] } } as Settings);
    expect(JSON.stringify(exported)).not.toContain('apiKey');
    expect(JSON.stringify(exported)).not.toContain('secret');
  });

  it('同源导入继承本地密钥，endpoint origin 改变则不继承', () => {
    const safe = exportSafeSettings(settings);
    expect(importSettings(safe, settings).engines.find((engine) => engine.id === customEngine.id)).toMatchObject({ apiKey: customEngine.apiKey });

    const changed = structuredClone(safe);
    const importedCustom = changed.engines.find((engine) => engine.id === customEngine.id);
    if (importedCustom?.kind === 'custom-ai') importedCustom.baseUrl = 'https://other.example.com/v1';
    expect(importSettings(changed, settings).engines.find((engine) => engine.id === customEngine.id)).toMatchObject({ apiKey: '' });
  });

  it('拒绝导入任意层级秘密和危险 key', () => {
    expect(() => importSettings({ ...exportSafeSettings(settings), apiKey: 'injected' }, settings)).toThrow('导入配置不能包含 API Key');
    expect(() => importSettings(JSON.parse('{"schemaVersion":2,"__proto__":{"polluted":true}}'), settings)).toThrow('配置包含危险字段');
  });

  it('导入始终保留本地内置项，并拒绝用保留 ID 伪装自定义实例', () => {
    const safe = exportSafeSettings(settings);
    const customOnly = { ...safe, engines: safe.engines.filter((engine) => engine.kind === 'custom-ai') };
    expect(importSettings(customOnly, settings).engines.slice(0, 2)).toEqual(DEFAULT_SETTINGS.engines);

    const disguised = structuredClone(safe);
    disguised.engines = disguised.engines.filter((engine) => engine.id !== 'google');
    disguised.engines.push({
      id: 'google', kind: 'custom-ai', name: '伪装 Google', enabled: true, order: 0,
      baseUrl: 'https://evil.example/v1', model: 'steal',
    });
    expect(() => importSettings(disguised, settings)).toThrow(/保留|Google|ID/);
  });

  it('导入内置项的启停、排序和默认选择，但保留固定身份与名称', () => {
    const safe = exportSafeSettings(settings);
    safe.activeEngineId = 'bing';
    safe.engines = [
      { id: 'bing', kind: 'bing', name: '伪造名称', enabled: true, order: 0 },
      { id: 'google', kind: 'google', name: '另一个伪造名称', enabled: false, order: 1 },
      ...safe.engines.filter((engine) => engine.kind === 'custom-ai').map((engine) => ({ ...engine, order: 2 })),
    ];

    expect(importSettings(safe, settings)).toMatchObject({
      activeEngineId: 'bing',
      engines: [
        { id: 'bing', kind: 'bing', name: 'Bing', enabled: true, order: 0 },
        { id: 'google', kind: 'google', name: 'Google', enabled: false, order: 1 },
        { id: 'custom-work', kind: 'custom-ai', apiKey: customEngine.apiKey, order: 2 },
      ],
    });
  });

  it('拒绝导入重复的内置 ID，而不是静默忽略伪造项', () => {
    const safe = exportSafeSettings(settings);
    safe.engines.push({ id: 'google', kind: 'google', name: 'Google', enabled: true, order: safe.engines.length });

    expect(() => importSettings(safe, settings)).toThrow('翻译引擎 ID 不能重复');
  });

  it('导入后 active 必须指向已启用且就绪的实例，否则安全回退 Google', () => {
    const safe = exportSafeSettings(settings);
    const imported = structuredClone(safe);
    imported.activeEngineId = 'custom-work';
    const engine = imported.engines.find((candidate) => candidate.id === 'custom-work');
    if (engine) engine.enabled = false;
    expect(importSettings(imported, settings).activeEngineId).toBe('google');
  });

  it('Google/Bing 均停用且唯一 custom 无本地密钥时拒绝导入', () => {
    const safe = exportSafeSettings(settings);
    safe.engines = safe.engines.map((engine) => ({ ...engine, enabled: engine.kind === 'custom-ai' }));

    expect(() => importSettings(safe, DEFAULT_SETTINGS)).toThrow('至少保留一个可用的翻译引擎');
  });
});
