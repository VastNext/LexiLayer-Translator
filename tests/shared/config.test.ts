import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  MAX_CUSTOM_ENGINES,
  exportSafeSettings,
  exportSettingsWithApiKeys,
  getPublicEngineSummaries,
  importSettings,
  migrateSettings,
  normalizeSettings,
  resolveEngine,
  validateEngine,
  validateSettings,
  type CustomAiEngine,
  type SafeSettings,
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
      theme: 'pearl-reader',
      activeEngineId: 'google',
      readingPreferences: {
        targetLanguage: 'auto',
        displayMode: 'bilingual',
        userInstruction: '',
        translationPosition: 'after',
        scanScope: 'whole-page',
        selectionContext: true,
        selectionPopupEnabled: true,
        autoSiteTranslation: true,
        inlineSelectionModifier: 'Control',
        inlineSelectionTriggerCount: 2,
      },
      experts: expect.arrayContaining([expect.objectContaining({ id: 'technology', kind: 'builtin', enabled: false })]),
      activeExpertByEngine: {},
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

describe('autoSiteTranslation 偏好', () => {
  it('默认开启，旧配置与旧导入自动补齐', () => {
    expect(DEFAULT_SETTINGS.readingPreferences.autoSiteTranslation).toBe(true);
    const legacy = structuredClone(settings) as unknown as Record<string, unknown>;
    delete (legacy.readingPreferences as Record<string, unknown>).autoSiteTranslation;
    expect(normalizeSettings(legacy).readingPreferences.autoSiteTranslation).toBe(true);
    const imported = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    delete (imported.readingPreferences as Record<string, unknown>).autoSiteTranslation;
    delete (imported.vocabulary as Record<string, unknown>).ankiApiKey;
    expect(importSettings(imported, structuredClone(DEFAULT_SETTINGS)).readingPreferences.autoSiteTranslation).toBe(true);
  });

  it('非法值被拒绝', () => {
    const candidate = structuredClone(settings);
    (candidate.readingPreferences as unknown as Record<string, unknown>).autoSiteTranslation = 'yes';
    expect(validateSettings(candidate)).toContain('自动延续翻译配置无效');
  });
});

describe('migration and normalization', () => {
  it('默认加入可选 vocabulary 配置，旧 v2 设置规范化时补齐默认值', () => {
    expect(DEFAULT_SETTINGS.vocabulary).toEqual({
      ankiEndpoint: '',
      ankiDeck: 'LexiLayer 生词本',
      ankiNoteType: 'basic',
      ankiApiKey: '',
      exportFolder: 'LexiLayer',
    });

    const legacyV2 = structuredClone(settings) as Omit<Settings, 'vocabulary'> & { vocabulary?: Settings['vocabulary'] };
    delete legacyV2.vocabulary;

    expect(normalizeSettings(legacyV2)).toMatchObject({
      activeEngineId: 'custom-work',
      vocabulary: DEFAULT_SETTINGS.vocabulary,
    });
  });

  it('规范化合法 Anki 设置，并拒绝远程 HTTP、非法类型和过长 API Key', () => {
    const candidate = {
      ...settings,
      vocabulary: {
        ankiEndpoint: ' https://anki.example.com/team/connect/ ',
        ankiDeck: '  Team Deck  ',
        ankiNoteType: 'cloze' as const,
        ankiApiKey: '  anki-secret  ',
      },
    };

    expect(normalizeSettings(candidate).vocabulary).toEqual({
      ankiEndpoint: 'https://anki.example.com/team/connect',
      ankiDeck: 'Team Deck',
      ankiNoteType: 'cloze',
      ankiApiKey: 'anki-secret',
      exportFolder: '',
    });
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, ankiEndpoint: 'http://anki.example.com/connect' },
    })).toContain('远程 AnkiConnect 端点必须使用 HTTPS');
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, ankiEndpoint: 'http://127.0.0.1:8765/' },
    })).toEqual([]);
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, ankiNoteType: 'advanced' as never },
    })).toContain('Anki 笔记类型无效');
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, ankiApiKey: 'x'.repeat(513) },
    })).toContain('Anki API Key 不得超过 512 个字符');
  });

  it('导出目录只接受下载目录下的相对子路径，并规范化分隔符', () => {
    expect(normalizeSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, exportFolder: ' /LexiLayer/生词// ' },
    }).vocabulary.exportFolder).toBe('LexiLayer/生词');
    // 用户粘贴 /LexiLayer 时按子目录理解，宽容去掉前导斜杠。
    expect(normalizeSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, exportFolder: '/absolute/path' },
    }).vocabulary.exportFolder).toBe('absolute/path');
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, exportFolder: '' },
    })).toEqual([]);
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, exportFolder: 'LexiLayer/../..\/etc' },
    })).toContain('导出目录必须是下载目录下的相对子路径');
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, exportFolder: 'C:\\Users\\me' },
    })).toContain('导出目录必须是下载目录下的相对子路径');
    expect(validateSettings({
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, exportFolder: 'x'.repeat(201) },
    })).toContain('导出目录必须是下载目录下的相对子路径');
  });

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
      expertDefaultsVersion: 6,
      theme: 'pearl-reader',
      readingPreferences: {
        inputTargetLanguage: 'en',
        targetLanguage: 'zh-Hans', displayMode: 'translation', userInstruction: '保留术语',
        translationPosition: 'before', scanScope: 'whole-page', selectionContext: false,
         selectionPopupEnabled: true, autoSiteTranslation: true, inlineSelectionModifier: 'Control', inlineSelectionTriggerCount: 1, rendererMode: 'legacy',
      },
      engines: [
        DEFAULT_SETTINGS.engines[0],
        DEFAULT_SETTINGS.engines[1],
        { ...customEngine, id: 'custom-migrated', name: '迁移的自定义 AI', order: 2, baseUrl: legacy.baseUrl, model: legacy.model, apiKey: legacy.apiKey },
      ],
      activeEngineId: 'google',
      vocabulary: DEFAULT_SETTINGS.vocabulary,
    });
  });

  it('v2 normalize 幂等，并对损坏存储安全回退', () => {
    const normalized = normalizeSettings(settings);
    expect(normalizeSettings(normalized)).toEqual(normalized);
    expect(normalizeSettings({ schemaVersion: 2, engines: [{ id: '__proto__' }] })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('broken')).toEqual(DEFAULT_SETTINGS);
  });

  it('旧 v2 配置补齐划词悬浮按钮与内联快捷键默认值', () => {
    const legacyV2 = structuredClone(settings) as Omit<Settings, 'readingPreferences'> & { readingPreferences: Partial<Settings['readingPreferences']> };
    delete legacyV2.readingPreferences.selectionPopupEnabled;
    delete legacyV2.readingPreferences.inlineSelectionModifier;
    delete legacyV2.readingPreferences.inlineSelectionTriggerCount;

    expect(normalizeSettings(legacyV2).readingPreferences).toMatchObject({
      selectionPopupEnabled: true,
      inlineSelectionModifier: 'Control',
      inlineSelectionTriggerCount: 1,
    });
  });

  it.each([
    ['Alt', 1],
    ['Control', 2],
    ['Shift', 3],
    ['Off', 3],
  ] as const)('保留已保存的合法内联触发值 %s + %s', (inlineSelectionModifier, inlineSelectionTriggerCount) => {
    const saved = structuredClone(settings);
    saved.readingPreferences.inlineSelectionModifier = inlineSelectionModifier;
    saved.readingPreferences.inlineSelectionTriggerCount = inlineSelectionTriggerCount;

    expect(normalizeSettings(saved).readingPreferences).toMatchObject({ inlineSelectionModifier, inlineSelectionTriggerCount });
  });

  it('旧导入缺少触发次数时补单击，完整导入保留显式值', () => {
    const legacyImport = exportSafeSettings(settings) as Omit<SafeSettings, 'readingPreferences'> & { readingPreferences: Partial<Settings['readingPreferences']> };
    delete legacyImport.readingPreferences.inlineSelectionTriggerCount;
    expect(importSettings(legacyImport, settings).readingPreferences.inlineSelectionTriggerCount).toBe(1);

    const completeImport = exportSafeSettings(settings);
    completeImport.readingPreferences.inlineSelectionModifier = 'Off';
    completeImport.readingPreferences.inlineSelectionTriggerCount = 3;
    expect(importSettings(completeImport, settings).readingPreferences).toMatchObject({
      inlineSelectionModifier: 'Off',
      inlineSelectionTriggerCount: 3,
    });
  });

  it('新安装默认内联渲染器，旧配置与非法值受控回退兼容模式', () => {
    // 新安装（DEFAULT_SETTINGS）使用内联渲染器。
    expect(DEFAULT_SETTINGS.readingPreferences.rendererMode).toBe('inline');

    // 旧 v2 配置缺字段 → legacy，避免升级后行为突然变化。
    const legacyV2 = structuredClone(settings) as Settings;
    delete (legacyV2.readingPreferences as { rendererMode?: string }).rendererMode;
    expect(normalizeSettings(legacyV2).readingPreferences.rendererMode).toBe('legacy');

    // 非法值 → legacy，不重置整份设置。
    const corrupted = structuredClone(settings) as unknown as { readingPreferences: { rendererMode: string }; activeEngineId: string };
    corrupted.readingPreferences.rendererMode = 'experimental';
    expect(normalizeSettings(corrupted).readingPreferences.rendererMode).toBe('legacy');
    expect(normalizeSettings(corrupted).activeEngineId).toBe(settings.activeEngineId);

    // 已保存的 inline 合法值原样保留。
    const inline = structuredClone(settings);
    inline.readingPreferences.rendererMode = 'inline';
    expect(normalizeSettings(inline).readingPreferences.rendererMode).toBe('inline');
  });

  it('导入配置缺渲染器字段回退兼容模式，显式 inline 值保留', () => {
    const safe = exportSafeSettings(settings) as SafeSettings & { readingPreferences: { rendererMode?: string } };
    const legacyImport = structuredClone(safe);
    delete (legacyImport.readingPreferences as { rendererMode?: string }).rendererMode;
    expect(importSettings(legacyImport, settings).readingPreferences.rendererMode).toBe('legacy');

    const corruptedImport = structuredClone(safe);
    (corruptedImport.readingPreferences as { rendererMode: string }).rendererMode = 'auto';
    expect(importSettings(corruptedImport, settings).readingPreferences.rendererMode).toBe('legacy');

    const inlineImport = structuredClone(safe) as SafeSettings;
    inlineImport.readingPreferences.rendererMode = 'inline';
    expect(importSettings(inlineImport, settings).readingPreferences.rendererMode).toBe('inline');
  });

  it('校验渲染器模式枚举', () => {
    expect(validateSettings({ ...settings, readingPreferences: { ...settings.readingPreferences, rendererMode: 'canvas' as never } }))
      .toContain('渲染器模式无效');
    expect(validateSettings({ ...settings, readingPreferences: { ...settings.readingPreferences, rendererMode: 'legacy' } })).toEqual([]);
  });

  it('旧专家默认版本迁移到 VastNext ID，并保留启用状态与底座映射', () => {
    const legacy = structuredClone(settings) as Omit<Settings, 'expertDefaultsVersion'> & { expertDefaultsVersion?: number };
    legacy.expertDefaultsVersion = 1;
    legacy.experts = legacy.experts?.map((expert) => ({ ...expert, enabled: true }));
    legacy.activeExpertByEngine = { 'custom-work': 'tech' };

    const normalized = normalizeSettings(legacy);

    expect(normalized.expertDefaultsVersion).toBe(6);
    expect(normalized.experts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'technology', enabled: true })]));
    expect(normalized.activeExpertByEngine).toEqual({ 'custom-work': 'technology' });
  });

  it('导入旧专家 ID 时迁移到 VastNext 目录且保留选择', () => {
    const legacy = structuredClone(settings);
    legacy.expertDefaultsVersion = 2 as never;
    legacy.experts = [{ id: 'tech', kind: 'builtin', name: '科技类翻译大师', description: '旧技术专家', prompt: '', enabled: true, order: 0 }];
    legacy.activeExpertByEngine = { 'custom-work': 'tech' };

    const imported = importSettings(legacy, settings, true);

    expect(imported.expertDefaultsVersion).toBe(6);
    expect(imported.experts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'technology', enabled: true })]));
    expect(imported.activeExpertByEngine).toEqual({ 'custom-work': 'technology' });
  });

  it('旧专家目录损坏时安全回退，不因非法 ID 映射抛异常', () => {
    const legacy = structuredClone(settings) as unknown as Record<string, unknown>;
    legacy.expertDefaultsVersion = 2;
    legacy.experts = [null, { id: 42, kind: 'builtin' }, { id: 'tech', kind: 'builtin', enabled: true }];
    legacy.activeExpertByEngine = { 'custom-work': 42 };

    expect(() => normalizeSettings(legacy)).not.toThrow();
    expect(normalizeSettings(legacy)).toMatchObject({
      activeEngineId: 'custom-work',
      expertDefaultsVersion: 6,
      activeExpertByEngine: {},
      experts: expect.arrayContaining([expect.objectContaining({ id: 'technology', enabled: true })]),
    });
  });

  it('校验划词悬浮开关与内联快捷键枚举', () => {
    expect(validateSettings({ ...settings, readingPreferences: { ...settings.readingPreferences, selectionPopupEnabled: 'yes' } })).toContain('划词悬浮按钮配置无效');
    expect(validateSettings({ ...settings, readingPreferences: { ...settings.readingPreferences, inlineSelectionModifier: 'CapsLock' } })).toContain('选区内联翻译快捷键无效');
    expect(validateSettings({ ...settings, readingPreferences: { ...settings.readingPreferences, inlineSelectionTriggerCount: 4 } })).toContain('选区内联翻译触发次数无效');
  });

  it('为缺少主题的旧 v2 设置补 Pearl，并拒绝未知主题', () => {
    const legacyV2 = structuredClone(settings) as Omit<Settings, 'theme'> & { theme?: Settings['theme'] };
    delete legacyV2.theme;

    expect(normalizeSettings(legacyV2).theme).toBe('pearl-reader');
    expect(validateSettings({ ...settings, theme: 'neon-unknown' })).toContain('外观主题无效');
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
         selectionPopupEnabled: true, autoSiteTranslation: true, inlineSelectionModifier: 'Control', inlineSelectionTriggerCount: 1,
    })).toMatchObject({
      activeEngineId: 'google',
      readingPreferences: { targetLanguage: 'zh-Hant', displayMode: 'translation', userInstruction: '保留专名', translationPosition: 'before', scanScope: 'whole-page', selectionContext: false },
      engines: DEFAULT_SETTINGS.engines,
    });
  });
});

describe('safe export and secure import', () => {
  it('递归删除所有 apiKey，包括未知嵌套对象，并为 vocabulary 暴露密钥状态', () => {
    const configuredVocabulary = {
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, ankiEndpoint: 'https://anki.example.com/connect', ankiApiKey: 'anki-secret' },
      metadata: { apiKey: 'nested-secret', nested: [{ apiKey: 'deep-secret' }] },
    } as Settings;
    const exported = exportSafeSettings(configuredVocabulary);

    expect(exported.vocabulary).toEqual({
      ankiEndpoint: 'https://anki.example.com/connect',
      ankiDeck: 'LexiLayer 生词本',
      ankiNoteType: 'basic',
      hasAnkiApiKey: true,
      exportFolder: 'LexiLayer',
    });
    expect(JSON.stringify(exported)).not.toContain('anki-secret');
    expect(JSON.stringify(exported)).not.toContain('nested-secret');
    expect(JSON.stringify(exported)).not.toContain('deep-secret');
  });

  it('只有显式含密钥导出才包含 Anki API Key', () => {
    const configuredVocabulary = {
      ...settings,
      vocabulary: { ...DEFAULT_SETTINGS.vocabulary, ankiEndpoint: 'https://anki.example.com/connect', ankiApiKey: 'anki-secret' },
    };

    expect(JSON.stringify(exportSettingsWithApiKeys(configuredVocabulary, false))).not.toContain('anki-secret');
    expect(exportSettingsWithApiKeys(configuredVocabulary, true).vocabulary).toMatchObject({ ankiApiKey: 'anki-secret' });
  });

  it('不含 Anki key 的导入仅在 Origin 相同且规范化 endpoint 相同时保留本地 key', () => {
    const current: Settings = {
      ...settings,
      vocabulary: {
        ankiEndpoint: 'https://anki.example.com/team/connect',
        ankiDeck: 'Local Deck',
        ankiNoteType: 'basic',
        ankiApiKey: 'local-anki-secret',
        exportFolder: 'LexiLayer',
      },
    };
    const safe = exportSafeSettings(current);

    const equivalent = structuredClone(safe);
    equivalent.vocabulary.ankiEndpoint = ' https://anki.example.com/team/connect/ ';
    expect(importSettings(equivalent, current).vocabulary.ankiApiKey).toBe('local-anki-secret');

    const changedPath = structuredClone(safe);
    changedPath.vocabulary.ankiEndpoint = 'https://anki.example.com/other';
    expect(importSettings(changedPath, current).vocabulary.ankiApiKey).toBe('');

    const changedOrigin = structuredClone(safe);
    changedOrigin.vocabulary.ankiEndpoint = 'https://other.example.com/team/connect';
    expect(importSettings(changedOrigin, current).vocabulary.ankiApiKey).toBe('');
  });

  it('可信含密钥导入接受 Anki key，安全导入拒绝', () => {
    const withKey = structuredClone(settings) as Settings;
    withKey.vocabulary = {
      ankiEndpoint: 'https://anki.example.com/connect',
      ankiDeck: 'Imported Deck',
      ankiNoteType: 'cloze',
      ankiApiKey: 'imported-anki-secret',
      exportFolder: 'LexiLayer',
    };

    expect(() => importSettings(withKey, settings)).toThrow('导入配置不能包含 API Key');
    expect(importSettings(withKey, settings, true).vocabulary).toEqual(withKey.vocabulary);

    // 与引擎密钥同语义：显式空密钥且端点一致时沿用本地密钥，端点不同才清除。
    const clearKey = structuredClone(withKey);
    clearKey.vocabulary.ankiApiKey = '';
    expect(importSettings(clearKey, withKey, true).vocabulary.ankiApiKey).toBe('imported-anki-secret');
    const otherEndpoint = structuredClone(clearKey);
    otherEndpoint.vocabulary.ankiEndpoint = 'https://other.example/connect';
    expect(importSettings(otherEndpoint, withKey, true).vocabulary.ankiApiKey).toBe('');
  });

  it('同源导入继承本地密钥，endpoint origin 改变则不继承', () => {
    const safe = exportSafeSettings(settings);
    expect(importSettings(safe, settings).engines.find((engine) => engine.id === customEngine.id)).toMatchObject({ apiKey: customEngine.apiKey });

    const changed = structuredClone(safe);
    const importedCustom = changed.engines.find((engine) => engine.id === customEngine.id);
    if (importedCustom?.kind === 'custom-ai') importedCustom.baseUrl = 'https://other.example.com/v1';
    expect(importSettings(changed, settings).engines.find((engine) => engine.id === customEngine.id)).toMatchObject({ apiKey: '' });
  });

  it('导入导出保留主题，旧导入配置补默认主题', () => {
    expect(exportSafeSettings({ ...settings, theme: 'command-translator' }).theme).toBe('command-translator');
    const legacyImport = exportSafeSettings(settings) as Omit<SafeSettings, 'theme'> & { theme?: SafeSettings['theme'] };
    delete legacyImport.theme;
    expect(importSettings(legacyImport, settings).theme).toBe('pearl-reader');
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

  it('Anki 密钥导入为空且端点相同时沿用本地密钥，端点不同则清除', () => {
    const current = {
      ...structuredClone(DEFAULT_SETTINGS),
      vocabulary: { ankiEndpoint: 'https://anki.example', ankiDeck: 'D', ankiNoteType: 'basic' as const, ankiApiKey: 'keep-me', exportFolder: 'LexiLayer' },
    };
    const importedSame = importSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      vocabulary: { ankiEndpoint: 'https://anki.example/', ankiDeck: 'D', ankiNoteType: 'basic', ankiApiKey: '' },
    }, current, true);
    expect(importedSame.vocabulary.ankiApiKey).toBe('keep-me');

    const importedOther = importSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      vocabulary: { ankiEndpoint: 'https://other.example', ankiDeck: 'D', ankiNoteType: 'basic', ankiApiKey: '' },
    }, current, true);
    expect(importedOther.vocabulary.ankiApiKey).toBe('');
  });
});
