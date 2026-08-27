import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { PopupApp, type PopupApi } from '../../src/popup/PopupApp';
import { createPopupApi } from '../../src/popup/api';
import type { Translator } from '../../src/shared/i18n';

afterEach(cleanup);

describe('Popup', () => {
  it('真实订阅先确定当前 tab，并过滤其他 tab 与子 frame 的进度', async () => {
    let onMessage!: (message: unknown) => void;
    const chromeApi = {
      runtime: {
        sendMessage: vi.fn(async () => ({ data: undefined })),
        openOptionsPage: vi.fn(),
        onMessage: { addListener: vi.fn((listener) => { onMessage = listener; }), removeListener: vi.fn() },
      },
      tabs: { query: vi.fn(async () => [{ id: 12 }]), sendMessage: vi.fn() },
      i18n: { getMessage: vi.fn((key: string) => key) },
    };
    const api = createPopupApi(chromeApi);
    const listener = vi.fn();

    const unsubscribe = await api.subscribeProgress(listener);
    onMessage({ type: 'page-progress', tabId: 13, frameId: 0, progress: { status: 'complete', completed: 1, failed: 0, total: 1 } });
    onMessage({ type: 'page-progress', tabId: 12, frameId: 2, progress: { status: 'complete', completed: 1, failed: 0, total: 1 } });
    onMessage({ type: 'page-progress', tabId: 12, frameId: 0, progress: { status: 'complete', completed: 1, failed: 0, total: 1 } });

    expect(chromeApi.tabs.query).toHaveBeenCalledBefore(chromeApi.runtime.onMessage.addListener);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(chromeApi.runtime.onMessage.removeListener).toHaveBeenCalledWith(onMessage);
  });

  it('Popup 作为独立扩展页打开时订阅同窗口普通网页而非自身 tab', async () => {
    let onMessage!: (message: unknown) => void;
    const chromeApi = {
      runtime: {
        id: 'extension-id',
        sendMessage: vi.fn(async () => ({ data: undefined })), openOptionsPage: vi.fn(),
        onMessage: { addListener: vi.fn((listener) => { onMessage = listener; }), removeListener: vi.fn() },
      },
      tabs: {
        getCurrent: vi.fn(async () => ({ id: 20 })),
        query: vi.fn(async () => [
          { id: 20, active: true },
          { id: 12, active: false },
        ]),
        sendMessage: vi.fn(),
      },
      i18n: { getMessage: vi.fn((key: string) => key) },
    };
    const listener = vi.fn();

    await createPopupApi(chromeApi).subscribeProgress(listener);
    onMessage({ type: 'page-progress', tabId: 12, frameId: 0, progress: { status: 'complete', completed: 4, failed: 0, total: 4 } });

    expect(listener).toHaveBeenCalledWith({ status: 'complete', completed: 4, failed: 0, total: 4 });
  });
  it('支持完整英文核心操作文本', async () => {
    const t: Translator = (key) => ({ popupCurrentPage: 'Current page', actionTranslatePage: 'Translate page', actionRestore: 'Restore', actionRetry: 'Retry', actionSettings: 'Settings' }[key] ?? key);
    render(<PopupApp api={{ getConfig: vi.fn(async () => ({ targetLanguage: 'en', displayMode: 'bilingual' })), getProgress: vi.fn(async () => undefined), subscribeProgress: vi.fn(() => () => undefined), sendToPage: vi.fn(), openOptions: vi.fn() }} t={t} />);
    expect(await screen.findByText('Current page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Translate page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });
  it('提供完整 12 种语言选项和快捷键提示', async () => {
    const api: PopupApi = {
      getConfig: vi.fn(async () => ({ targetLanguage: 'en', displayMode: 'bilingual' })),
      getProgress: vi.fn(async () => undefined), subscribeProgress: vi.fn(() => () => undefined),
      sendToPage: vi.fn(), openOptions: vi.fn(),
    };
    render(<PopupApp api={api} />);
    const values = [...(await screen.findByLabelText('目标语言')).querySelectorAll('option')].map((option) => option.value);
    expect(values).toEqual(['auto', 'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'it', 'de', 'es', 'pt', 'ru', 'ar']);
    expect(screen.getByText((_text, element) => Boolean(element?.classList.contains('shortcut') && /Shift\s*\+\s*Alt\s*\+\s*A/.test(element.textContent ?? '')))).toBeInTheDocument();
  });

  it('使用可访问的品牌图形和状态语义', async () => {
    render(<PopupApp api={{
      getConfig: vi.fn(async () => ({ targetLanguage: 'en', displayMode: 'bilingual' })),
      getProgress: vi.fn(async () => undefined), subscribeProgress: vi.fn(() => () => undefined),
      sendToPage: vi.fn(), openOptions: vi.fn(),
    }} />);

    expect(await screen.findByRole('img', { name: 'Vast Translator' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('就绪');
  });

  it('在批准范围内发送翻译、恢复、模式、范围和语言动作', async () => {
    const api: PopupApi = {
      getConfig: vi.fn(async () => ({ targetLanguage: 'zh-Hans', displayMode: 'bilingual' })),
      getProgress: vi.fn(async () => ({ status: 'partial', completed: 2, failed: 1, total: 3 })),
      subscribeProgress: vi.fn(() => () => undefined),
      sendToPage: vi.fn(async () => undefined),
      openOptions: vi.fn(),
    };
    render(<PopupApp api={api} />);
    await waitFor(() => expect(screen.getByLabelText('目标语言')).toHaveValue('zh-Hans'));
    expect(await screen.findByText('已完成 2/3，失败 1')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('翻译范围'), 'whole-page');
    await userEvent.selectOptions(screen.getByLabelText('显示模式'), 'translation-only');
    await userEvent.selectOptions(screen.getByLabelText('目标语言'), 'ja');
    await userEvent.click(screen.getByRole('button', { name: '翻译当前页面' }));
    expect(api.sendToPage).toHaveBeenCalledWith({
      type: 'translate-page', scope: 'whole-page', mode: 'translation-only', targetLanguage: 'ja',
    });
    await userEvent.click(screen.getByRole('button', { name: '恢复原文' }));
    expect(api.sendToPage).toHaveBeenLastCalledWith({ type: 'restore-page' });
  });

  it('显示进度与失败并提供重试和设置入口', async () => {
    const api: PopupApi = {
      getConfig: vi.fn(async () => ({ targetLanguage: 'en', displayMode: 'bilingual' })),
      getProgress: vi.fn(async () => undefined),
      subscribeProgress: vi.fn(() => () => undefined),
      sendToPage: vi.fn(async (message) => {
        if ((message as { type: string }).type === 'translate-page') throw new Error('翻译失败');
      }),
      openOptions: vi.fn(),
    };
    render(<PopupApp api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '翻译当前页面' }));
    expect(await screen.findByText('翻译失败')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(api.sendToPage).toHaveBeenLastCalledWith({ type: 'retry-page-translation' });
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(api.openOptions).toHaveBeenCalledOnce();
  });

  it('翻译命令完成后回读页面最终进度而不是覆盖为已开始', async () => {
    const api: PopupApi = {
      getConfig: vi.fn(async () => ({ targetLanguage: 'en', displayMode: 'bilingual' })),
      getProgress: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ status: 'translating', completed: 0, failed: 0, total: 4 })
        .mockResolvedValueOnce({ status: 'complete', completed: 4, failed: 0, total: 4 }),
      subscribeProgress: vi.fn(() => () => undefined),
      sendToPage: vi.fn(async () => undefined),
      openOptions: vi.fn(),
    };
    render(<PopupApp api={api} />);

    await userEvent.click(await screen.findByRole('button', { name: '翻译当前页面' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已完成 4/4'));
    expect(api.getProgress).toHaveBeenCalledTimes(3);
  });
});
