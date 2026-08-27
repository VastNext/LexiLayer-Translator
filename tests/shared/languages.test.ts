import { describe, expect, it } from 'vitest';

import { chooseTargetLanguage, languageOptions, mapChromeUiLanguage, normalizeLanguage } from '../../src/shared/languages';

describe('mapChromeUiLanguage', () => {
  it.each([
    ['zh-CN', 'zh-Hans'],
    ['zh_TW', 'zh-Hant'],
    ['pt-BR', 'pt'],
    ['ja', 'ja'],
  ])('将 Chrome UI 语言 %s 映射为 %s', (input, expected) => {
    expect(mapChromeUiLanguage(input)).toBe(expected);
  });

  it('无法识别时回退英语', () => {
    expect(mapChromeUiLanguage('xx-ZZ')).toBe('en');
  });
});

describe('chooseTargetLanguage', () => {
  it('页面语言与目标语言相同时切换为英语', () => {
    expect(chooseTargetLanguage('ja', 'ja')).toBe('en');
  });

  it('英语冲突时切换为简体中文', () => {
    expect(chooseTargetLanguage('en-US', 'en')).toBe('zh-Hans');
  });
});

it('规范化页面声明语言时去除首尾空白', () => {
  expect(normalizeLanguage('  EN-us  ')).toBe('en');
});

it('目标语言列表包含意大利语且与支持集合一致', () => {
  expect(languageOptions.map(({ value }) => value)).toContain('it');
});
