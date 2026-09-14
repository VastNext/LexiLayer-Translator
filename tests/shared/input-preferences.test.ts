import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, exportSafeSettings, importSettings, normalizeSettings, validateSettings } from '../../src/shared/config';

it('输入目标语言独立默认英语，旧配置读取和导入补齐且不改变原偏好', () => {
  const old = structuredClone(DEFAULT_SETTINGS);
  delete (old.readingPreferences as Partial<typeof old.readingPreferences>).inputTargetLanguage;
  old.readingPreferences.targetLanguage = 'zh-CN';
  for (const settings of [normalizeSettings(old), importSettings(exportSafeSettings(old))]) {
    expect(settings.readingPreferences.inputTargetLanguage).toBe('en');
    expect(settings.readingPreferences.targetLanguage).toBe('zh-CN');
  }
});

it('输入目标语言保存和导出保留，非法值拒绝', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.readingPreferences.inputTargetLanguage = 'ja';
  expect(importSettings(exportSafeSettings(settings)).readingPreferences.inputTargetLanguage).toBe('ja');
  settings.readingPreferences.inputTargetLanguage = 'auto';
  expect(validateSettings(settings)).toContain('输入框目标语言无效');
});
