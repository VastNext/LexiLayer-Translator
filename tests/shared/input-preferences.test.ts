import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, exportSafeSettings, importSettings, normalizeSettings, validateSettings } from '../../src/shared/config';

it('输入目标语言独立默认英语，旧配置读取和导入补齐且不改变原偏好', () => {
  const old = structuredClone(DEFAULT_SETTINGS);
  delete (old.readingPreferences as Partial<typeof old.readingPreferences>).inputTargetLanguage;
  delete old.readingPreferences.inputEngineId;
  old.readingPreferences.targetLanguage = 'zh-CN';
  for (const settings of [normalizeSettings(old), importSettings(exportSafeSettings(old))]) {
    expect(settings.readingPreferences.inputTargetLanguage).toBe('en');
    expect(settings.readingPreferences.inputEngineId).toBe('follow');
    expect(settings.readingPreferences.targetLanguage).toBe('zh-CN');
  }
});

it.each(['follow', 'google', 'bing', 'custom-input', 'custom-follow'])('输入引擎 %s 可安全导出导入且不改变页面引擎', (inputEngineId) => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.readingPreferences.inputEngineId = inputEngineId;
  for (const result of [normalizeSettings(settings), importSettings(exportSafeSettings(settings))]) {
    expect(result.readingPreferences.inputEngineId).toBe(inputEngineId);
    expect(result.activeEngineId).toBe('google');
  }
});

it.each(['', 'current-engine', '__proto__', 'custom-', 12, null, {}])('拒绝非法输入引擎偏好 %s', (inputEngineId) => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings.readingPreferences, { inputEngineId });
  expect(validateSettings(settings)).toContain('输入框翻译引擎无效');
  expect(() => importSettings(exportSafeSettings(settings))).toThrow('输入框翻译引擎无效');
});

it('输入目标语言保存和导出保留，非法值拒绝', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.readingPreferences.inputTargetLanguage = 'ja';
  expect(importSettings(exportSafeSettings(settings)).readingPreferences.inputTargetLanguage).toBe('ja');
  settings.readingPreferences.inputTargetLanguage = 'auto';
  expect(validateSettings(settings)).toContain('输入框目标语言无效');
});
