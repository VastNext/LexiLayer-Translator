import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp, type PopupApi } from '../../src/popup/PopupApp';

afterEach(cleanup);

const preferences = {
  targetLanguage: 'zh-Hans', displayMode: 'bilingual', scanScope: 'whole-page' as const,
  translationPosition: 'after' as const, userInstruction: '', selectionContext: true,
};

function createApi(overrides: Partial<PopupApi> = {}): PopupApi {
  return {
    getConfig: vi.fn(async () => ({
      preferences, activeEngineId: 'google', theme: 'pearl-reader' as const,
      availableEngines: [
        { id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } },
        { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } },
      ],
    })),
    savePreferences: vi.fn(async () => undefined),
    setActiveEngine: vi.fn(async () => undefined),
    savePopupState: vi.fn(async () => undefined),
    sendToPage: vi.fn(async () => undefined),
    openOptions: vi.fn(),
    getProgress: vi.fn(async () => undefined),
    subscribeProgress: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe('精简 Popup', () => {
  it('按正式结构展示品牌、同排语言、整行引擎、状态、模式主操作和设置', async () => {
    render(<PopupApp api={createApi()} />);
    expect(await screen.findByRole('main')).toHaveAttribute('data-theme', 'pearl-reader');
    expect(await screen.findByLabelText('翻译引擎')).toHaveValue('google');
    expect(screen.getByLabelText('源语言')).toHaveValue('auto');
    expect(screen.getByLabelText('目标语言')).toHaveValue('zh-Hans');
    expect(screen.getByRole('button', { name: '双语对照' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译 (Alt + A)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByLabelText('翻译范围')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(screen.queryByText('当前页面')).not.toBeInTheDocument();
    expect(screen.queryByText(/01 \/ READ/)).not.toBeInTheDocument();
    expect(screen.queryByText('Shift')).not.toBeInTheDocument();
  });

  it('更改引擎、语言和显示模式时立即保存', async () => {
    const api = createApi();
    render(<PopupApp api={api} />);
    await screen.findByLabelText('翻译引擎');
    await userEvent.selectOptions(screen.getByLabelText('翻译引擎'), 'bing');
    await userEvent.selectOptions(screen.getByLabelText('源语言'), 'en');
    await userEvent.selectOptions(screen.getByLabelText('目标语言'), 'ja');
    await userEvent.click(screen.getByRole('button', { name: '双语对照' }));
    expect(api.savePopupState).toHaveBeenLastCalledWith('bing', expect.objectContaining({ sourceLanguage: 'en', targetLanguage: 'ja', displayMode: 'translation', scanScope: 'whole-page' }));
  });

  it('翻译后主按钮切换为显示原文，再次点击恢复', async () => {
    let progressListener: ((progress: { status: string; completed: number; failed: number; total: number }) => void) | undefined;
    const api = createApi({ subscribeProgress: vi.fn((listener) => { progressListener = listener; return () => undefined; }) });
    render(<PopupApp api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '翻译 (Alt + A)' }));
    expect(api.sendToPage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-page', scope: 'whole-page', targetLanguage: 'zh-Hans' }));
    progressListener?.({ status: 'complete', completed: 1, failed: 0, total: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: '显示原文' })).toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: '显示原文' }));
    expect(api.sendToPage).toHaveBeenLastCalledWith({ type: 'restore-page' });
  });

  it('重新打开时使用后台保存的偏好', async () => {
    const api = createApi({ getConfig: vi.fn(async () => ({
      preferences: { ...preferences, targetLanguage: 'de', displayMode: 'translation' }, activeEngineId: 'bing', theme: 'command-translator' as const,
      availableEngines: [
        { id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } },
        { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } },
      ],
    })) });
    render(<PopupApp api={api} />);
    await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toHaveValue('bing'));
    expect(screen.getByLabelText('目标语言')).toHaveValue('de');
    expect(screen.getByRole('button', { name: '仅译文' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'command-translator');
    expect(document.documentElement).toHaveAttribute('data-theme', 'command-translator');
  });
});

describe('Popup 消息恢复', () => {
  it('接收端不存在时注入 content.js 并重试一次', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValueOnce({ ok: true });
    const executeScript = vi.fn(async () => undefined);
    const { createPopupApi } = await import('../../src/popup/api');
    const api = createPopupApi({
      runtime: { id: 'extension-id', sendMessage: vi.fn(), openOptionsPage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      tabs: { getCurrent: vi.fn(async () => undefined), query: vi.fn(async () => [{ id: 7, active: true, url: 'https://example.com' }]), sendMessage },
      scripting: { executeScript },
      i18n: { getMessage: vi.fn(() => '') },
    });

    await expect(api.sendToPage({ type: 'translate-page' })).resolves.toEqual({ ok: true });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.js'] });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
