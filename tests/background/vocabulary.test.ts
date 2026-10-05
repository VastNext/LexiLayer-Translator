import { describe, expect, it, vi } from 'vitest';

import { createBackgroundController, type BackgroundChrome, type BackgroundDependencies } from '../../src/background/index';
import {
  VocabularyStorage,
  type VocabularyStorageArea,
} from '../../src/background/vocabulary-storage';
import {
  createVocabularyEntry,
  normalizeVocabularyDraft,
  validateVocabularyDraft,
  vocabularyDuplicateKey,
  vocabularyExportPath,
  type VocabularyDraft,
} from '../../src/shared/vocabulary';

const draft: VocabularyDraft = {
  word: 'Hello',
  sentence: 'Hello from the article.',
  translation: '你好',
  sourceUrl: 'https://example.com/article?id=1',
  pageTitle: 'Example article',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
};

function sequence<T>(...values: T[]): () => T {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

class MemoryVocabularyStorage implements VocabularyStorageArea {
  readonly data: Record<string, unknown>;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: structuredClone(this.data[key]) };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(items));
  }
}

describe('生词模型', () => {
  it('规范化空白并用注入的 id/clock 创建条目', () => {
    const normalized = normalizeVocabularyDraft({
      ...draft,
      word: '  Hello\n\tworld  ',
      sentence: '  A   hello\nworld sentence.  ',
      translation: '  你  好  ',
      pageTitle: '  Example\n article  ',
      sourceUrl: '  https://example.com/article?id=1  ',
    });

    expect(normalized).toEqual({
      ...draft,
      word: 'Hello world',
      sentence: 'A hello world sentence.',
      translation: '你 好',
      pageTitle: 'Example article',
    });
    expect(createVocabularyEntry(normalized, () => 'entry-1', () => 1234)).toEqual({
      ...normalized,
      id: 'entry-1',
      createdAt: 1234,
      updatedAt: 1234,
    });
  });

  it('Latin 单词和句子的去重 key 大小写不敏感', () => {
    const left = normalizeVocabularyDraft({ ...draft, word: 'ÉCOLE', sentence: 'A Mixed CASE sentence.' });
    const right = normalizeVocabularyDraft({ ...draft, word: 'école', sentence: 'a mixed case sentence.' });

    expect(vocabularyDuplicateKey(left)).toBe(vocabularyDuplicateKey(right));
  });

  it.each([
    ['空单词', { ...draft, word: '   ' }],
    ['超长单词', { ...draft, word: 'x'.repeat(121) }],
    ['超长句子', { ...draft, sentence: 'x'.repeat(601) }],
    ['超长译文', { ...draft, translation: 'x'.repeat(601) }],
    ['超长页面标题', { ...draft, pageTitle: 'x'.repeat(301) }],
    ['非 HTTP URL', { ...draft, sourceUrl: 'javascript:alert(1)' }],
    ['带凭据 URL', { ...draft, sourceUrl: 'https://user:secret@example.com/article' }],
    ['超长 URL', { ...draft, sourceUrl: `https://example.com/${'x'.repeat(2049)}` }],
    ['危险源语言', { ...draft, sourceLanguage: '<script>' }],
    ['非字符串源语言', { ...draft, sourceLanguage: 123 }],
    ['空源语言', { ...draft, sourceLanguage: '   ' }],
    ['空目标语言', { ...draft, targetLanguage: '   ' }],
    ['超长目标语言', { ...draft, targetLanguage: 'x'.repeat(33) }],
    ['多余字段', { ...draft, apiKey: 'must-not-be-accepted' }],
  ])('拒绝%s', (_label, value) => {
    expect(validateVocabularyDraft(value)).not.toEqual([]);
    expect(() => normalizeVocabularyDraft(value)).toThrow();
  });
});

describe('生词本本地存储', () => {
  it('创建条目并按 createdAt 倒序列出', async () => {
    const storage = new MemoryVocabularyStorage();
    const book = new VocabularyStorage(storage, {
      createId: sequence('entry-1', 'entry-2'),
      now: sequence(100, 200),
    });

    await expect(book.upsert(draft)).resolves.toEqual({
      status: 'created',
      entry: { ...draft, id: 'entry-1', createdAt: 100, updatedAt: 100 },
    });
    await book.upsert({ ...draft, word: 'World', sentence: 'A different sentence.' });

    await expect(book.list()).resolves.toEqual([
      expect.objectContaining({ id: 'entry-2', word: 'World', createdAt: 200 }),
      expect.objectContaining({ id: 'entry-1', word: 'Hello', createdAt: 100 }),
    ]);
    expect(storage.data.vocabularyBook).toEqual({
      schemaVersion: 1,
      entries: expect.arrayContaining([
        expect.objectContaining({ id: 'entry-1' }),
        expect.objectContaining({ id: 'entry-2' }),
      ]),
    });
  });

  it('同词同句 duplicate 刷新 updatedAt、保留身份并用非空译文和标题更新', async () => {
    const storage = new MemoryVocabularyStorage();
    const book = new VocabularyStorage(storage, {
      createId: sequence('entry-original', 'entry-unused'),
      now: sequence(100, 250),
    });
    const created = await book.upsert(draft);

    const duplicate = await book.upsert({
      ...draft,
      word: '  hELLo ',
      sentence: ' hello FROM the ARTICLE. ',
      translation: '您好',
      pageTitle: 'Updated title',
      sourceUrl: 'https://another.example/context',
    });

    expect(created.status).toBe('created');
    expect(duplicate).toEqual({
      status: 'duplicate',
      entry: {
        ...draft,
        translation: '您好',
        pageTitle: 'Updated title',
        id: 'entry-original',
        createdAt: 100,
        updatedAt: 250,
      },
    });
    await expect(book.list()).resolves.toHaveLength(1);
  });

  it('duplicate 的空译文和空标题不覆盖原有非空值', async () => {
    const storage = new MemoryVocabularyStorage();
    const book = new VocabularyStorage(storage, {
      createId: () => 'entry-original',
      now: sequence(100, 250),
    });
    await book.upsert(draft);

    await expect(book.upsert({ ...draft, translation: '  ', pageTitle: '' })).resolves.toEqual({
      status: 'duplicate',
      entry: expect.objectContaining({
        id: 'entry-original',
        translation: '你好',
        pageTitle: 'Example article',
        createdAt: 100,
        updatedAt: 250,
      }),
    });
  });

  it('同词不同句允许新增', async () => {
    const storage = new MemoryVocabularyStorage();
    const book = new VocabularyStorage(storage, {
      createId: sequence('entry-1', 'entry-2'),
      now: sequence(100, 200),
    });

    await book.upsert(draft);
    await expect(book.upsert({ ...draft, sentence: 'Hello in another context.' })).resolves.toEqual({
      status: 'created',
      entry: expect.objectContaining({ id: 'entry-2', sentence: 'Hello in another context.' }),
    });
    await expect(book.list()).resolves.toHaveLength(2);
  });

  it.each([
    undefined,
    null,
    { schemaVersion: 2, entries: [] },
    { schemaVersion: 1, entries: 'not-an-array' },
    { schemaVersion: 1, entries: [{ id: 'broken' }] },
  ])('损坏存储 %# 安全回退为空', async (vocabularyBook) => {
    const storage = new MemoryVocabularyStorage({ vocabularyBook });
    const book = new VocabularyStorage(storage);

    await expect(book.list()).resolves.toEqual([]);
  });

  it.each([
    ['LexiLayer', 'lexilayer-vocabulary.json', 'LexiLayer/lexilayer-vocabulary.json'],
    ['', 'a.csv', 'a.csv'],
    ['Backups/生词', 'a.tsv', 'Backups/生词/a.tsv'],
  ])('导出路径 %# 拼接下载目录相对子路径', (folder, filename, expected) => {
    expect(vocabularyExportPath(folder, filename)).toBe(expected);
  });

  it('单条损坏只剔除该条，其余有效条目保留且可继续写入', async () => {
    const valid = { id: 'entry-ok', word: 'keep', sentence: 'Keep this one.', sourceUrl: 'https://a.example/', targetLanguage: 'en', createdAt: 5, updatedAt: 5 };
    const storage = new MemoryVocabularyStorage({ vocabularyBook: { schemaVersion: 1, entries: [valid, { id: 'broken' }] } });
    const book = new VocabularyStorage(storage);

    await expect(book.list()).resolves.toEqual([valid]);
    await book.upsert(draft);
    await expect(book.list()).resolves.toHaveLength(2);
  });

  it('存储读取失败时不把未知状态当空书覆盖', async () => {
    const set = vi.fn(async () => undefined);
    const book = new VocabularyStorage({
      get: vi.fn(async () => { throw new Error('storage unavailable'); }),
      set,
    });

    await expect(book.upsert(draft)).rejects.toThrow('storage unavailable');
    expect(set).not.toHaveBeenCalled();
  });

  it('删除单条并清空生词本', async () => {
    const storage = new MemoryVocabularyStorage();
    const book = new VocabularyStorage(storage, {
      createId: sequence('entry-1', 'entry-2'),
      now: sequence(100, 200),
    });
    await book.upsert(draft);
    await book.upsert({ ...draft, word: 'World', sentence: 'World sentence.' });

    await expect(book.delete('entry-1')).resolves.toBe(true);
    await expect(book.delete('missing')).resolves.toBe(false);
    await expect(book.list()).resolves.toEqual([expect.objectContaining({ id: 'entry-2' })]);

    await book.clear();
    await expect(book.list()).resolves.toEqual([]);
    expect(storage.data.vocabularyBook).toEqual({ schemaVersion: 1, entries: [] });
  });
});

interface BackgroundHarness {
  api: BackgroundChrome;
  local: Record<string, unknown>;
  controller: ReturnType<typeof createBackgroundController>;
}

function createBackgroundHarness(initialBook?: unknown, delayFirstVocabularyWrite = false): BackgroundHarness {
  const local: Record<string, unknown> = {
    vocabularyBook: initialBook,
  };
  let vocabularyWriteCount = 0;
  const get = vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(local);
    return Object.fromEntries(names.map((key) => [key, structuredClone(local[key])]));
  });
  const set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    if (Object.hasOwn(items, 'vocabularyBook') && delayFirstVocabularyWrite && vocabularyWriteCount++ === 0) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    Object.assign(local, structuredClone(items));
  });
  const api: BackgroundChrome = {
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
    },
    commandsApi: { onCommand: { addListener: vi.fn() } },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: { addListener: vi.fn() } },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
    storage: {
      local: { get, set } as unknown as BackgroundChrome['storage']['local'],
    },
    i18n: { getUILanguage: () => 'en-US' },
  };
  const dependencies: BackgroundDependencies = {
    createProvider: vi.fn(() => { throw new Error('vocabulary messages must not create a provider'); }),
    clearCache: vi.fn(async () => undefined),
  };
  return { api, local, controller: createBackgroundController(api, dependencies) };
}

const contentSender: chrome.runtime.MessageSender = {
  id: 'extension-id',
  url: 'https://example.com/article',
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  documentId: 'document-1',
};
const optionsSender: chrome.runtime.MessageSender = {
  id: 'extension-id',
  url: 'chrome-extension://extension-id/options.html?vocabulary=1#book',
};

describe('生词本后台消息', () => {
  it('content 可保存，只有本扩展 Options 可读取、删除和清空', async () => {
    const { controller } = createBackgroundHarness();

    const saved = await controller.handle({ type: 'save-vocabulary-entry', draft }, contentSender);
    expect(saved).toEqual({
      ok: true,
      data: { status: 'created', entry: expect.objectContaining({ word: 'Hello' }) },
    });
    const id = (saved as { data: { entry: { id: string } } }).data.entry.id;

    await expect(controller.handle({ type: 'get-vocabulary-entries' }, contentSender))
      .resolves.toEqual({ ok: false, error: '消息来源无效' });
    await expect(controller.handle({ type: 'delete-vocabulary-entry', id }, contentSender))
      .resolves.toEqual({ ok: false, error: '消息来源无效' });
    await expect(controller.handle({ type: 'clear-vocabulary' }, { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' }))
      .resolves.toEqual({ ok: false, error: '消息来源无效' });

    await expect(controller.handle({ type: 'get-vocabulary-entries' }, optionsSender)).resolves.toEqual({
      ok: true,
      data: [expect.objectContaining({ id, word: 'Hello' })],
    });
    await expect(controller.handle({ type: 'delete-vocabulary-entry', id }, optionsSender))
      .resolves.toEqual({ ok: true, data: { deleted: true } });
    await expect(controller.handle({ type: 'clear-vocabulary' }, optionsSender))
      .resolves.toEqual({ ok: true });
  });

  it('save 消息拒绝缺失页面身份或非网页 content sender', async () => {
    const { controller } = createBackgroundHarness();
    for (const sender of [
      { id: 'extension-id', url: 'https://example.com/article' },
      { id: 'extension-id', url: 'https://example.com/article', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 },
      { id: 'extension-id', url: 'chrome-extension://extension-id/options.html', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' },
      { id: 'extension-id', url: 'file:///private.txt', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' },
    ]) {
      await expect(controller.handle({ type: 'save-vocabulary-entry', draft }, sender))
        .resolves.toEqual({ ok: false, error: '消息来源无效' });
    }
  });

  it('严格校验消息和 draft，错误不回显 draft 或出处 URL', async () => {
    const { controller, api } = createBackgroundHarness();
    const secretUrl = 'javascript:alert("private-source-url")';

    for (const message of [
      { type: 'save-vocabulary-entry', draft, unexpected: true },
      { type: 'save-vocabulary-entry', draft: { ...draft, unexpected: true } },
      { type: 'save-vocabulary-entry', draft: { ...draft, sourceUrl: secretUrl } },
      { type: 'get-vocabulary-entries', unexpected: true },
      { type: 'delete-vocabulary-entry', id: '__proto__' },
      { type: 'clear-vocabulary', unexpected: true },
    ]) {
      const sender = message.type === 'save-vocabulary-entry' ? contentSender : optionsSender;
      const response = await controller.handle(message, sender);
      expect(response).toEqual({ ok: false, error: '消息格式无效' });
      expect(JSON.stringify(response)).not.toContain('private-source-url');
    }
    expect(api.storage.local.set).not.toHaveBeenCalled();
  });

  it('损坏存储通过消息读取时回退为空而不抛出', async () => {
    const { controller } = createBackgroundHarness({ schemaVersion: 1, entries: [{ sourceUrl: 'javascript:bad' }] });

    await expect(controller.handle({ type: 'get-vocabulary-entries' }, optionsSender))
      .resolves.toEqual({ ok: true, data: [] });
  });

  it('两个并发 create 经串行写队列后都保留', async () => {
    const { controller } = createBackgroundHarness(undefined, true);

    const [first, second] = await Promise.all([
      controller.handle({ type: 'save-vocabulary-entry', draft: { ...draft, word: 'First', sentence: 'First sentence.' } }, contentSender),
      controller.handle({ type: 'save-vocabulary-entry', draft: { ...draft, word: 'Second', sentence: 'Second sentence.' } }, contentSender),
    ]);

    expect(first).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ status: 'created' }) }));
    expect(second).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ status: 'created' }) }));
    const listed = await controller.handle({ type: 'get-vocabulary-entries' }, optionsSender);
    expect(listed).toEqual({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({ word: 'First' }),
        expect.objectContaining({ word: 'Second' }),
      ]),
    });
    expect((listed as { data: unknown[] }).data).toHaveLength(2);
  });
});
