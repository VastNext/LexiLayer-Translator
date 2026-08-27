import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, exportSafeConfig, validateConfig, type TranslatorConfig } from '../../src/shared/config';

const config: TranslatorConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-super-secret',
  model: 'gpt-test',
  targetLanguage: 'zh-Hans',
  displayMode: 'bilingual',
  userInstruction: '保持术语一致',
  translationPosition: 'after',
  scanScope: 'main-content',
  selectionContext: true,
};

describe('validateConfig', () => {
  it('接受完整配置', () => {
    expect(validateConfig(config)).toEqual([]);
  });

  it('报告缺失的 API 配置', () => {
    expect(validateConfig({ ...config, baseUrl: '', apiKey: '', model: '' })).toEqual([
      'Base URL 不能为空',
      'API Key 不能为空',
      '模型不能为空',
    ]);
  });

  it.each([null, [], 'config', 42])('拒绝非配置对象 %#', (value) => {
    expect(validateConfig(value)).toEqual(['配置必须是对象']);
  });

  it('完整校验 URL 和运行时字段', () => {
    expect(validateConfig({
      baseUrl: 'file:///tmp/api',
      apiKey: 123,
      model: null,
      targetLanguage: '',
      displayMode: 'invalid',
      userInstruction: 1,
    })).toEqual([
      'Base URL 必须使用 HTTP 或 HTTPS',
      'API Key 不能为空',
      '模型不能为空',
      '目标语言不能为空',
      '显示模式无效',
      '用户要求必须是字符串',
      '译文位置无效',
      '翻译范围无效',
      '有限上下文配置无效',
    ]);
  });

  it('拒绝缺少字段的不完整对象', () => {
    expect(validateConfig({})).toEqual([
      'Base URL 不能为空',
      'API Key 不能为空',
      '模型不能为空',
      '目标语言不能为空',
      '显示模式无效',
      '用户要求必须是字符串',
      '译文位置无效',
      '翻译范围无效',
      '有限上下文配置无效',
    ]);
  });

  it.each([
    'http://api.example.com/v1',
    'http://10.0.0.8/v1',
  ])('拒绝远程 HTTP Base URL %s', (baseUrl) => {
    expect(validateConfig({ ...config, baseUrl })).toContain('Base URL 仅允许 HTTPS，HTTP 仅限本机回环地址');
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
  ])('允许本机回环 HTTP Base URL %s', (baseUrl) => {
    expect(validateConfig({ ...config, baseUrl })).toEqual([]);
  });
});

describe('exportSafeConfig', () => {
  it('导出配置时排除 API Key', () => {
    const exported = exportSafeConfig(config);

    expect(exported).not.toHaveProperty('apiKey');
    expect(JSON.stringify(exported)).not.toContain(config.apiKey);
    expect(exported.model).toBe(config.model);
  });

  it('默认公开配置包含位置、范围和有限上下文偏好', () => {
    expect(DEFAULT_CONFIG).toMatchObject({ translationPosition: 'after', scanScope: 'main-content', selectionContext: true });
    expect(exportSafeConfig(DEFAULT_CONFIG)).toMatchObject({ translationPosition: 'after', scanScope: 'main-content', selectionContext: true });
  });
});
