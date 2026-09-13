import { describe, expect, it, vi } from 'vitest';

import { createPopupApi } from '../../src/popup/api';

function createChromeApi(getAll: () => Promise<unknown[]>) {
  return {
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(),
      openOptionsPage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn() },
    commands: { getAll },
    i18n: { getMessage: vi.fn(() => '') },
  };
}

describe('Popup 快捷键 API', () => {
  it('与 Options 使用相同规则读取页面翻译快捷键', async () => {
    const api = createPopupApi(createChromeApi(vi.fn(async () => [
      { name: 'other', shortcut: 'Alt+A' },
      { name: 'translate_page', shortcut: '' },
    ])));

    await expect(api.getPageTranslationShortcut()).resolves.toEqual({ status: 'unassigned' });
  });

  it('commands.getAll reject 时返回不可用而不抛出', async () => {
    const api = createPopupApi(createChromeApi(vi.fn(async () => { throw new Error('commands unavailable'); })));

    await expect(api.getPageTranslationShortcut()).resolves.toEqual({ status: 'unavailable', reason: 'api-error' });
  });
});
