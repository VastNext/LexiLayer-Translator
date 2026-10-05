import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANKI_PREFERENCES,
  formatAnkiNote,
  normalizeAnkiEndpoint,
  normalizeAnkiPreferences,
  validateAnkiEndpoint,
  validateAnkiPreferences,
  type AnkiPreferences,
} from '../../src/shared/anki';
import type { VocabularyEntry } from '../../src/shared/vocabulary';

const entry: VocabularyEntry = {
  id: 'entry-1',
  word: 'hello',
  sentence: 'Hello from the article.',
  translation: '你好',
  sourceUrl: 'https://example.com/article?a=1&b=2',
  pageTitle: 'Example article',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  createdAt: 1,
  updatedAt: 1,
};

const preferences: AnkiPreferences = {
  endpoint: 'https://anki.example.com/connect',
  deck: 'LexiLayer 生词本',
  noteType: 'basic',
  hasApiKey: true,
};

describe('AnkiConnect 端点', () => {
  it('提供不强推 localhost 的安全默认值', () => {
    expect(DEFAULT_ANKI_PREFERENCES).toEqual({
      endpoint: '',
      deck: 'LexiLayer 生词本',
      noteType: 'basic',
      hasApiKey: false,
    });
    expect(validateAnkiPreferences(DEFAULT_ANKI_PREFERENCES)).toEqual([]);
  });

  it.each([
    [' http://127.0.0.1:8765/anki/// ', 'http://127.0.0.1:8765/anki'],
    ['http://localhost:8765/', 'http://localhost:8765'],
    ['http://[::1]:8765/connect/', 'http://[::1]:8765/connect'],
    ['https://anki.example.com/team/connect/', 'https://anki.example.com/team/connect'],
  ])('允许并规范化端点 %s', (value, expected) => {
    expect(validateAnkiEndpoint(value)).toEqual([]);
    expect(normalizeAnkiEndpoint(value)).toBe(expected);
  });

  it.each([
    'http://anki.example.com',
    'http://192.168.1.8:8765',
    'http://127.0.0.1.example.com',
    'http://localhost.example.com',
    'http://2130706433',
    'http://0177.0.0.1',
    'http://127.1',
    'http://[::ffff:127.0.0.1]',
  ])('拒绝远程 HTTP 或伪回环地址 %s', (value) => {
    expect(validateAnkiEndpoint(value)).not.toEqual([]);
    expect(() => normalizeAnkiEndpoint(value)).toThrow();
  });

  it.each([
    'https://user:password@anki.example.com/connect',
    'https://anki.example.com/connect?token=secret',
    'https://anki.example.com/connect#fragment',
    'ftp://anki.example.com/connect',
    'not a url',
    '',
  ])('拒绝不安全或含歧义的端点 %s', (value) => {
    expect(validateAnkiEndpoint(value)).not.toEqual([]);
    expect(() => normalizeAnkiEndpoint(value)).toThrow();
  });

  it('拒绝超过 2048 个字符的端点', () => {
    const value = `https://anki.example.com/${'a'.repeat(2049)}`;
    expect(validateAnkiEndpoint(value)).not.toEqual([]);
    expect(() => normalizeAnkiEndpoint(value)).toThrow();
  });
});

describe('Anki 偏好', () => {
  it('规范化端点与 deck 空白，同时保留安全的密钥状态', () => {
    expect(normalizeAnkiPreferences({
      endpoint: ' https://anki.example.com/connect/ ',
      deck: '  LexiLayer 生词本  ',
      noteType: 'cloze',
      hasApiKey: true,
    })).toEqual({
      endpoint: 'https://anki.example.com/connect',
      deck: 'LexiLayer 生词本',
      noteType: 'cloze',
      hasApiKey: true,
    });
  });

  it.each([
    { ...preferences, deck: '' },
    { ...preferences, deck: 'x'.repeat(121) },
    { ...preferences, noteType: 'reverse' },
    { ...preferences, hasApiKey: 'yes' },
    { ...preferences, endpoint: 'http://anki.example.com' },
    { ...preferences, apiKey: 'must-not-be-safe-preferences' },
  ])('拒绝非法偏好 %#', (value) => {
    expect(validateAnkiPreferences(value)).not.toEqual([]);
    expect(() => normalizeAnkiPreferences(value)).toThrow();
  });
});

describe('Anki note 格式化', () => {
  it('生成 Basic Front/Back，并转义所有用户数据与安全链接属性', () => {
    const note = formatAnkiNote({
      ...entry,
      word: '<hello & "world">',
      sentence: 'Use <hello> & stay safe.',
      translation: '译文 <img src=x onerror=alert(1)> & more',
      pageTitle: 'Page <One> & "Two"',
    }, preferences);

    expect(note).toEqual({
      deckName: 'LexiLayer 生词本',
      modelName: 'Basic',
      fields: {
        Front: '&lt;hello &amp; &quot;world&quot;&gt;',
        Back: expect.any(String),
      },
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    });
    expect(note.fields.Back).toContain('Use &lt;hello&gt; &amp; stay safe.');
    expect(note.fields.Back).toContain('译文 &lt;img src=x onerror=alert(1)&gt; &amp; more');
    expect(note.fields.Back).toContain('Page &lt;One&gt; &amp; &quot;Two&quot;');
    expect(note.fields.Back).toContain('href="https://example.com/article?a=1&amp;b=2"');
    expect(note.fields.Back).toContain('target="_blank"');
    expect(note.fields.Back).toContain('rel="noopener noreferrer"');
    expect(note.fields.Back).not.toContain('<img');
  });

  it('生成 Cloze Text/Extra，并仅大小写不敏感替换首个 Latin 匹配', () => {
    const note = formatAnkiNote({
      ...entry,
      sentence: 'HELLO & hello <again>.',
      translation: '你好 & 再见',
      pageTitle: 'A <page>',
    }, { ...preferences, noteType: 'cloze' });

    expect(note.modelName).toBe('Cloze');
    expect(note.fields).toEqual({
      Text: '{{c1::HELLO}} &amp; hello &lt;again&gt;.',
      Extra: expect.any(String),
    });
    expect(note.fields.Extra).toContain('你好 &amp; 再见');
    expect(note.fields.Extra).toContain('A &lt;page&gt;');
    expect(note.options).toEqual({ allowDuplicate: false, duplicateScope: 'deck' });
  });

  it('Cloze 找不到单词时把独立挖空词放在句子前', () => {
    const note = formatAnkiNote({ ...entry, word: 'missing', sentence: 'Nothing here.' }, {
      ...preferences,
      noteType: 'cloze',
    });

    expect(note.fields).toEqual(expect.objectContaining({
      Text: '{{c1::missing}}<br>Nothing here.',
    }));
  });
});
