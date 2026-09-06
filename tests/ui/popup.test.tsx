import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp, type PopupApi } from '../../src/popup/PopupApp';

afterEach(cleanup);

const preferences = {
  targetLanguage: 'zh-Hans', displayMode: 'bilingual', scanScope: 'whole-page' as const,
  translationPosition: 'after' as const, userInstruction: '', selectionContext: true,
  selectionPopupEnabled: true, inlineSelectionModifier: 'Control' as const, rendererMode: 'legacy' as const,
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
    setTranslationBadge: vi.fn(async () => undefined),
    openOptions: vi.fn(),
    getProgress: vi.fn(async () => undefined),
    subscribeProgress: vi.fn(() => () => undefined),
    ...overrides,
  };
}

// 配置加载门禁：交互前必须等保存控件解锁，避免与 getConfig 竞态。
async function renderAndAwaitLoaded(api: PopupApi): Promise<void> {
  render(<PopupApp api={api} />);
  await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toBeEnabled());
}

describe('精简 Popup', () => {
  it('选择 AI 引擎时展示已启用专家并保存 expertId', async () => {
    const api = createApi({
      getConfig: vi.fn(async () => ({ preferences, activeEngineId: 'custom-work', theme: 'pearl-reader' as const,
        availableEngines: [{ id: 'custom-work', kind: 'custom-ai', name: '工作 AI', ready: true, capabilities: { streaming: true } }],
        experts: [{ id: 'technology', name: '科技类翻译大师', description: '技术内容', enabled: true }, { id: 'medical', name: '医学翻译大师', description: '医学内容', enabled: true }],
        activeExpertByEngine: { 'custom-work': 'technology' },
      })),
    });
    render(<PopupApp api={api} />);
    const selector = await screen.findByLabelText('AI 专家');
    await userEvent.selectOptions(selector, 'medical');
    expect(api.savePopupState).toHaveBeenCalledWith('custom-work', preferences, 'medical');
  });

  it('自定义 AI 默认不选择任何专家，使用基础翻译提示词', async () => {
    const api = createApi({
      getConfig: vi.fn(async () => ({ preferences, activeEngineId: 'custom-work', theme: 'pearl-reader' as const,
        availableEngines: [{ id: 'custom-work', kind: 'custom-ai', name: '工作 AI', ready: true, capabilities: { streaming: true } }],
        experts: [{ id: 'technology', name: '科技类翻译大师', description: '技术内容', enabled: true }], activeExpertByEngine: {},
      })),
    });
    render(<PopupApp api={api} />);
    expect(await screen.findByLabelText('AI 专家')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: '翻译 (Alt + A)' }));
    expect(api.sendToPage).toHaveBeenCalledWith(expect.not.objectContaining({ expertId: expect.anything() }));
  });
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
    await renderAndAwaitLoaded(api);
    await userEvent.selectOptions(screen.getByLabelText('翻译引擎'), 'bing');
    await userEvent.selectOptions(screen.getByLabelText('源语言'), 'en');
    await userEvent.selectOptions(screen.getByLabelText('目标语言'), 'ja');
    await userEvent.click(screen.getByRole('button', { name: '双语对照' }));
    expect(api.savePopupState).toHaveBeenLastCalledWith('bing', expect.objectContaining({ sourceLanguage: 'en', targetLanguage: 'ja', displayMode: 'translation', scanScope: 'whole-page' }));
    expect(api.sendToPage).not.toHaveBeenCalled();
  });

  it('保存偏好时完整回传渲染器模式，不因局部修改丢失字段', async () => {
    const inlinePreferences = { ...preferences, rendererMode: 'inline' as const };
    const api = createApi();
    vi.mocked(api.getConfig).mockResolvedValue({
      preferences: inlinePreferences, activeEngineId: 'google', theme: 'pearl-reader' as const,
      availableEngines: [
        { id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } },
        { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } },
      ],
    });
    render(<PopupApp api={api} />);
    await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toBeEnabled());
    await userEvent.selectOptions(screen.getByLabelText('目标语言'), 'ja');
    await waitFor(() => expect(api.savePopupState).toHaveBeenCalled());
    expect(api.savePopupState).toHaveBeenLastCalledWith('google', expect.objectContaining({ rendererMode: 'inline', targetLanguage: 'ja' }));
  });

  it('getConfig 挂起时保存控件禁用且不发送保存，加载成功后解锁且字段不丢', async () => {
    let resolveConfig!: (value: Awaited<ReturnType<PopupApi['getConfig']>>) => void;
    const api = createApi({ getConfig: vi.fn(() => new Promise<Awaited<ReturnType<PopupApi['getConfig']>>>((resolve) => { resolveConfig = resolve; })) });
    render(<PopupApp api={api} />);

    const target = screen.getByLabelText('目标语言');
    expect(target).toBeDisabled();
    expect(screen.getByLabelText('源语言')).toBeDisabled();
    expect(screen.getByLabelText('翻译引擎')).toBeDisabled();
    expect(screen.getByRole('button', { name: '双语对照' })).toBeDisabled();
    // 主翻译按钮同样受配置加载门禁：getConfig 挂起时点击不得发送翻译/恢复命令。
    expect(screen.getByRole('button', { name: '翻译 (Alt + A)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '翻译 (Alt + A)' }));
    await waitFor(() => expect(api.sendToPage).not.toHaveBeenCalled());
    expect(api.setTranslationBadge).not.toHaveBeenCalled();

    // 门禁期间即便事件到达处理器也不得写入 fallback 默认值（含 rendererMode: 'legacy'）。
    fireEvent.change(target, { target: { value: 'ja' } });
    await waitFor(() => expect(api.savePopupState).not.toHaveBeenCalled());
    expect(api.savePreferences).not.toHaveBeenCalled();

    resolveConfig({
      preferences: { ...preferences, rendererMode: 'inline' as const },
      activeEngineId: 'google', theme: 'pearl-reader' as const,
      availableEngines: [
        { id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } },
        { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } },
      ],
    });
    await waitFor(() => expect(target).toBeEnabled());
    expect(screen.getByRole('button', { name: '翻译 (Alt + A)' })).toBeEnabled();
    await userEvent.selectOptions(target, 'ja');
    await waitFor(() => expect(api.savePopupState).toHaveBeenCalled());
    expect(api.savePopupState).toHaveBeenLastCalledWith('google', expect.objectContaining({ rendererMode: 'inline', targetLanguage: 'ja' }));
  });

  it('快速连续切换引擎、语言和模式时后续保存继续使用最新引擎', async () => {
    const calls: string[] = [];
    const api = createApi({ savePopupState: vi.fn(async (engineId) => { calls.push(engineId); }) });
    await renderAndAwaitLoaded(api);

    fireEvent.change(screen.getByLabelText('翻译引擎'), { target: { value: 'bing' } });
    fireEvent.change(screen.getByLabelText('目标语言'), { target: { value: 'ja' } });
    fireEvent.click(screen.getByRole('button', { name: '双语对照' }));

    await waitFor(() => expect(calls).toEqual(['bing', 'bing', 'bing']));
  });

  it('已翻译页面切换引擎后使用新引擎立即重译', async () => {
    const api = createApi({ getProgress: vi.fn(async () => ({ status: 'complete', completed: 2, failed: 0, total: 2 })) });
    render(<PopupApp api={api} />);
    await screen.findByRole('button', { name: '显示原文 (Alt + A)' });
    await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toBeEnabled());

    await userEvent.selectOptions(screen.getByLabelText('翻译引擎'), 'bing');

    await waitFor(() => expect(api.sendToPage).toHaveBeenCalledWith({
      type: 'translate-page', engineId: 'bing', scope: 'whole-page', sourceLanguage: 'auto', mode: 'bilingual', targetLanguage: 'zh-Hans',
    }));
    expect(api.savePopupState).toHaveBeenCalledWith('bing', expect.objectContaining({ displayMode: 'bilingual' }));
    expect(screen.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeInTheDocument();
  });

  it('translating 即使尚未扫描到段落也视为当前页面已翻译', async () => {
    const api = createApi({ getProgress: vi.fn(async () => ({ status: 'translating', completed: 0, failed: 0, total: 0 })) });
    render(<PopupApp api={api} />);

    expect(await screen.findByRole('button', { name: '显示原文 (Alt + A)' })).toBeInTheDocument();
  });

  it('已翻译页面切换显示模式后立即重译并保持显示原文按钮', async () => {
    const api = createApi({ getProgress: vi.fn(async () => ({ status: 'complete', completed: 2, failed: 0, total: 2 })) });
    render(<PopupApp api={api} />);
    await screen.findByRole('button', { name: '显示原文 (Alt + A)' });
    await waitFor(() => expect(screen.getByRole('button', { name: '双语对照' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '双语对照' }));

    await waitFor(() => expect(api.sendToPage).toHaveBeenCalledWith({
      type: 'translate-page', engineId: 'google', scope: 'whole-page', sourceLanguage: 'auto', mode: 'translation-only', targetLanguage: 'zh-Hans',
    }));
    expect(api.savePopupState).toHaveBeenCalledWith('google', expect.objectContaining({ displayMode: 'translation' }));
    expect(screen.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeInTheDocument();
  });

  it('翻译后主按钮切换为显示原文，再次点击恢复', async () => {
    let progressListener: ((progress: { status: string; completed: number; failed: number; total: number }) => void) | undefined;
    const api = createApi({ subscribeProgress: vi.fn((listener) => { progressListener = listener; return () => undefined; }) });
    render(<PopupApp api={api} />);
    const translateButton = await screen.findByRole('button', { name: '翻译 (Alt + A)' });
    await waitFor(() => expect(translateButton).toBeEnabled());
    await userEvent.click(translateButton);
    expect(api.setTranslationBadge).toHaveBeenCalledWith(true);
    expect(api.sendToPage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-page', scope: 'whole-page', targetLanguage: 'zh-Hans' }));
    progressListener?.({ status: 'complete', completed: 1, failed: 0, total: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: '显示原文 (Alt + A)' })).toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: '显示原文 (Alt + A)' }));
    expect(api.sendToPage).toHaveBeenLastCalledWith({ type: 'restore-page' });
    expect(api.setTranslationBadge).toHaveBeenLastCalledWith(false);
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
  it('接收端不存在时先注入两套样式再按 manifest 顺序注入三个脚本并重试一次', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValueOnce({ ok: true });
    const executeScript = vi.fn(async () => undefined);
    const insertCSS = vi.fn(async () => undefined);
    const { createPopupApi } = await import('../../src/popup/api');
    const api = createPopupApi({
      runtime: { id: 'extension-id', sendMessage: vi.fn(), openOptionsPage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      tabs: { getCurrent: vi.fn(async () => undefined), query: vi.fn(async () => [{ id: 7, active: true, url: 'https://example.com' }]), sendMessage },
      scripting: { executeScript, insertCSS },
      action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
      i18n: { getMessage: vi.fn(() => '') },
    });

    await expect(api.sendToPage({ type: 'translate-page' })).resolves.toEqual({ ok: true });
    // 样式必须先于脚本注入，且两套样式与三个脚本按 manifest 声明顺序补全。
    expect(insertCSS).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.css', 'content-inline.css'] });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.js', 'content-inline.js', 'content-main.js'] });
    expect(insertCSS.mock.invocationCallOrder[0]).toBeLessThan(executeScript.mock.invocationCallOrder[0]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('按当前标签页设置绿色勾 Badge，并可清除', async () => {
    const setBadgeText = vi.fn(async () => undefined);
    const setBadgeBackgroundColor = vi.fn(async () => undefined);
    const { createPopupApi } = await import('../../src/popup/api');
    const api = createPopupApi({
      runtime: { id: 'extension-id', sendMessage: vi.fn(), openOptionsPage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      tabs: { getCurrent: vi.fn(async () => undefined), query: vi.fn(async () => [{ id: 7, active: true, url: 'https://example.com' }]), sendMessage: vi.fn() },
      action: { setBadgeText, setBadgeBackgroundColor },
      i18n: { getMessage: vi.fn(() => '') },
    });

    await api.setTranslationBadge(true);
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 7, color: '#16a34a' });
    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: '✓' });

    await api.setTranslationBadge(false);
    expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 7, text: '' });
  });
});
