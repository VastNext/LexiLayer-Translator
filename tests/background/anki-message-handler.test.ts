import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnkiClientError, type AnkiClient, type AnkiSyncResult } from '../../src/background/anki-client';
import {
  createBackgroundController,
  type BackgroundChrome,
  type BackgroundDependencies,
} from '../../src/background/index';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/config';
import type { VocabularyEntry } from '../../src/shared/vocabulary';

const optionsSender: chrome.runtime.MessageSender = {
  id: 'extension-id',
  url: 'chrome-extension://extension-id/options.html?vocabulary=1#anki',
};

const vocabularyEntry: VocabularyEntry = {
  id: 'entry-1',
  word: 'hello',
  sentence: 'Hello from the article.',
  translation: '你好',
  sourceUrl: 'https://example.com/article',
  pageTitle: 'Example article',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  createdAt: 1,
  updatedAt: 1,
};

interface Harness {
  api: BackgroundChrome;
  local: Record<string, unknown>;
  ankiClient: Pick<AnkiClient, 'testConnection' | 'sync'>;
  controller: ReturnType<typeof createBackgroundController>;
}

function createHarness(settings: Settings = structuredClone(DEFAULT_SETTINGS), entries: VocabularyEntry[] = []): Harness {
  const local: Record<string, unknown> = {
    translatorSettings: structuredClone(settings),
    vocabularyBook: { schemaVersion: 1, entries: structuredClone(entries) },
  };
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
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
          const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(local);
          return Object.fromEntries(names.map((key) => [key, structuredClone(local[key])]));
        }),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(local, structuredClone(items)); }),
      } as unknown as BackgroundChrome['storage']['local'],
    },
    i18n: { getUILanguage: () => 'en-US' },
  };
  const ankiClient = {
    testConnection: vi.fn(async () => ({ version: 6 })),
    sync: vi.fn(async (): Promise<AnkiSyncResult> => ({ added: entries.length, skipped: 0, failed: 0 })),
  };
  const dependencies: BackgroundDependencies = {
    createProvider: vi.fn(() => { throw new Error('Anki messages must not create a translation provider'); }),
    clearCache: vi.fn(async () => undefined),
    ankiClient,
  };
  return { api, local, ankiClient, controller: createBackgroundController(api, dependencies) };
}

function configuredVocabulary(overrides: Partial<Settings['vocabulary']> = {}): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    vocabulary: {
      ankiEndpoint: 'https://anki.example.com/team/connect',
      ankiDeck: 'LexiLayer 生词本',
      ankiNoteType: 'basic',
      ankiApiKey: 'anki-secret',
      exportFolder: '',
      ...overrides,
    },
  };
}

describe('Anki 后台消息', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness(configuredVocabulary(), [vocabularyEntry]);
  });

  it.each([
    'get-anki-api-key',
    'clear-anki-api-key',
    'save-vocabulary-preferences',
    'test-anki-connection',
    'sync-vocabulary-anki',
  ])('%s 仅接受本扩展 Options sender', async (type) => {
    const message = type === 'save-vocabulary-preferences'
      ? { type, endpoint: 'https://anki.example.com/connect', deck: 'Deck', noteType: 'basic' }
      : type === 'test-anki-connection'
        ? { type, candidate: { endpoint: 'https://anki.example.com/connect' } }
        : { type };
    for (const sender of [
      { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' },
      { id: 'extension-id', url: 'chrome-extension://extension-id/options.html/extra' },
      { id: 'extension-id', url: 'https://example.com/options.html', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0, documentId: 'doc' },
      { id: 'other-extension', url: 'chrome-extension://extension-id/options.html' },
      { id: 'extension-id' },
    ]) {
      await expect(harness.controller.handle(message, sender)).resolves.toEqual({ ok: false, error: '消息来源无效' });
    }
  });

  it('get-options-settings 只暴露 hasAnkiApiKey，专用消息才回显密钥', async () => {
    const options = await harness.controller.handle({ type: 'get-options-settings' }, optionsSender);

    expect(options).toEqual({
      ok: true,
      data: expect.objectContaining({
        vocabulary: {
          ankiEndpoint: 'https://anki.example.com/team/connect',
          ankiDeck: 'LexiLayer 生词本',
          ankiNoteType: 'basic',
          hasAnkiApiKey: true,
          exportFolder: '',
        },
      }),
    });
    expect(JSON.stringify(options)).not.toContain('anki-secret');
    await expect(harness.controller.handle({ type: 'get-anki-api-key' }, optionsSender))
      .resolves.toEqual({ ok: true, data: { key: 'anki-secret' } });
  });

  it('保存偏好严格 only keys、规范化字段并保存可选 API Key', async () => {
    await expect(harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: ' https://remote.example.com/team/connect/ ',
      deck: '  Team Deck  ',
      noteType: 'cloze',
      apiKey: '  remote-secret  ',
    }, optionsSender)).resolves.toEqual({ ok: true });

    expect((harness.local.translatorSettings as Settings).vocabulary).toEqual({
      ankiEndpoint: 'https://remote.example.com/team/connect',
      ankiDeck: 'Team Deck',
      ankiNoteType: 'cloze',
      ankiApiKey: 'remote-secret',
      exportFolder: '',
    });

    await expect(harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: 'https://remote.example.com/connect',
      deck: 'Deck',
      noteType: 'basic',
      exportFolder: ' Backups/生词 ',
    }, optionsSender)).resolves.toEqual({ ok: true });
    expect((harness.local.translatorSettings as Settings).vocabulary.exportFolder).toBe('Backups/生词');

    await expect(harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: 'https://remote.example.com/connect',
      deck: 'Deck',
      noteType: 'basic',
      exportFolder: '../escape',
    }, optionsSender)).resolves.toEqual({ ok: false, error: '消息格式无效' });

    await expect(harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: 'https://remote.example.com/connect',
      deck: 'Deck',
      noteType: 'basic',
      action: 'version',
    }, optionsSender)).resolves.toEqual({ ok: false, error: '消息格式无效' });
  });

  it('未提供 key 时同一规范化 endpoint 保留 key，endpoint 变化则清除', async () => {
    await expect(harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: 'https://anki.example.com/team/connect/',
      deck: 'Renamed',
      noteType: 'cloze',
    }, optionsSender)).resolves.toEqual({ ok: true });
    expect((harness.local.translatorSettings as Settings).vocabulary.ankiApiKey).toBe('anki-secret');

    await expect(harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: 'https://anki.example.com/other',
      deck: 'Renamed',
      noteType: 'cloze',
    }, optionsSender)).resolves.toEqual({ ok: true });
    expect((harness.local.translatorSettings as Settings).vocabulary.ankiApiKey).toBe('');
  });

  it('可明确清除 Anki API Key', async () => {
    await expect(harness.controller.handle({ type: 'clear-anki-api-key' }, optionsSender)).resolves.toEqual({ ok: true });
    expect((harness.local.translatorSettings as Settings).vocabulary.ankiApiKey).toBe('');
  });

  it.each([
    ['https://remote.example.com/connect', 'remote-secret'],
    ['http://127.0.0.1:8765/', undefined],
  ] as const)('连接测试固定调用 AnkiClient.testConnection：%s', async (endpoint, apiKey) => {
    await expect(harness.controller.handle({
      type: 'test-anki-connection',
      candidate: { endpoint, ...(apiKey === undefined ? {} : { apiKey }) },
    }, optionsSender)).resolves.toEqual({ ok: true, data: { version: 6 } });

    expect(harness.ankiClient.testConnection).toHaveBeenCalledWith(endpoint.replace(/\/$/u, ''), apiKey, expect.any(AbortSignal));
  });

  it('连接测试拒绝远程 HTTP、额外 action/url 和过长 key，且不调用客户端', async () => {
    for (const message of [
      { type: 'test-anki-connection', candidate: { endpoint: 'http://remote.example.com/connect' } },
      { type: 'test-anki-connection', candidate: { endpoint: 'https://anki.example.com/connect', action: 'deckNames' } },
      { type: 'test-anki-connection', candidate: { endpoint: 'https://anki.example.com/connect', url: 'https://evil.example' } },
      { type: 'test-anki-connection', candidate: { endpoint: 'https://anki.example.com/connect', apiKey: 'x'.repeat(513) } },
    ]) {
      await expect(harness.controller.handle(message, optionsSender)).resolves.toEqual({ ok: false, error: '消息格式无效' });
    }
    expect(harness.ankiClient.testConnection).not.toHaveBeenCalled();
  });

  it('同步只读取已保存设置与 vocabularyStorage.list，并返回统计', async () => {
    const expected = { added: 1, skipped: 0, failed: 0 };
    vi.mocked(harness.ankiClient.sync).mockResolvedValueOnce(expected);

    await expect(harness.controller.handle({ type: 'sync-vocabulary-anki' }, optionsSender))
      .resolves.toEqual({ ok: true, data: expected });

    expect(harness.ankiClient.sync).toHaveBeenCalledWith(
      [vocabularyEntry],
      {
        endpoint: 'https://anki.example.com/team/connect',
        deck: 'LexiLayer 生词本',
        noteType: 'basic',
        hasApiKey: true,
      },
      'anki-secret',
      expect.any(AbortSignal),
    );
  });

  it('同步拒绝未配置端点、空条目和任意参数', async () => {
    const noEndpoint = createHarness(configuredVocabulary({ ankiEndpoint: '' }), [vocabularyEntry]);
    await expect(noEndpoint.controller.handle({ type: 'sync-vocabulary-anki' }, optionsSender))
      .resolves.toEqual({ ok: false, error: '请先配置 AnkiConnect 端点' });

    const empty = createHarness(configuredVocabulary(), []);
    await expect(empty.controller.handle({ type: 'sync-vocabulary-anki' }, optionsSender))
      .resolves.toEqual({ ok: false, error: '生词本为空，暂无可同步条目' });

    await expect(harness.controller.handle({ type: 'sync-vocabulary-anki', url: 'https://evil.example', action: 'version' }, optionsSender))
      .resolves.toEqual({ ok: false, error: '消息格式无效' });
    expect(harness.ankiClient.sync).not.toHaveBeenCalled();
  });

  it('配置保存与同步共用串行队列，后发同步读取最新持久配置', async () => {
    let releaseSave!: () => void;
    vi.mocked(harness.api.storage.local.set).mockImplementationOnce(async (items) => {
      await new Promise<void>((resolve) => { releaseSave = resolve; });
      Object.assign(harness.local, structuredClone(items));
    });

    const saving = harness.controller.handle({
      type: 'save-vocabulary-preferences',
      endpoint: 'https://new.example.com/connect',
      deck: 'New Deck',
      noteType: 'cloze',
      apiKey: 'new-secret',
    }, optionsSender);
    const syncing = harness.controller.handle({ type: 'sync-vocabulary-anki' }, optionsSender);
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf('function'));
    expect(harness.ankiClient.sync).not.toHaveBeenCalled();
    releaseSave();

    await expect(saving).resolves.toEqual({ ok: true });
    await expect(syncing).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, failed: 0 } });
    expect(harness.ankiClient.sync).toHaveBeenCalledWith(
      [vocabularyEntry],
      { endpoint: 'https://new.example.com/connect', deck: 'New Deck', noteType: 'cloze', hasApiKey: true },
      'new-secret',
      expect.any(AbortSignal),
    );
  });

  it('AnkiClientError 保留安全中文 message/code，普通错误脱敏 key 与 endpoint path', async () => {
    vi.mocked(harness.ankiClient.testConnection).mockRejectedValueOnce(
      new AnkiClientError('auth', 'AnkiConnect 认证失败，请检查 API Key'),
    );
    await expect(harness.controller.handle({
      type: 'test-anki-connection',
      candidate: { endpoint: 'https://anki.example.com/private/path', apiKey: 'candidate-secret' },
    }, optionsSender)).resolves.toEqual({
      ok: false,
      error: 'AnkiConnect 认证失败，请检查 API Key',
      code: 'auth',
    });

    vi.mocked(harness.ankiClient.sync).mockRejectedValueOnce(
      new Error('failed anki-secret https://anki.example.com/private/path'),
    );
    await expect(harness.controller.handle({ type: 'sync-vocabulary-anki' }, optionsSender))
      .resolves.toEqual({ ok: false, error: '请求处理失败，请检查配置或网络后重试' });
  });
});
