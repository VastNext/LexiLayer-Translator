import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupApp, type PopupApi } from '../../src/popup/PopupApp';

afterEach(cleanup);

const preferences = {
  targetLanguage: 'zh-Hans', displayMode: 'bilingual', scanScope: 'whole-page' as const,
  translationPosition: 'after' as const, userInstruction: '', selectionContext: true,
  selectionPopupEnabled: true, inlineSelectionModifier: 'Control' as const, inlineSelectionTriggerCount: 1 as const, rendererMode: 'legacy' as const,
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
    getPageTranslationShortcut: vi.fn(async () => ({ status: 'assigned' as const, shortcut: 'Alt+A', displayShortcut: 'Alt + A' })),
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
    await userEvent.click(screen.getByRole('button', { name: '翻译当前页面' }));
    expect(api.sendToPage).toHaveBeenCalledWith(expect.not.objectContaining({ expertId: expect.anything() }));
  });

  it('按正式结构展示品牌、同排语言、整行引擎、状态、模式主操作和设置', async () => {
    render(<PopupApp api={createApi()} />);
    expect(await screen.findByRole('main')).toHaveAttribute('data-theme', 'pearl-reader');
    expect(await screen.findByLabelText('翻译引擎')).toHaveValue('google');
    expect(screen.getByLabelText('源语言')).toHaveValue('auto');
    expect(screen.getByLabelText('目标语言')).toHaveValue('zh-Hans');
    expect(screen.getByRole('button', { name: '双语对照' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeInTheDocument();
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
    const inlinePreferences = { ...preferences, inlineSelectionTriggerCount: 3 as const, rendererMode: 'inline' as const };
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
    expect(api.savePopupState).toHaveBeenLastCalledWith('google', expect.objectContaining({ inlineSelectionTriggerCount: 3, rendererMode: 'inline', targetLanguage: 'ja' }));

    await userEvent.click(screen.getByRole('button', { name: '双语对照' }));
    await waitFor(() => expect(api.savePopupState).toHaveBeenLastCalledWith('google', expect.objectContaining({
      displayMode: 'translation',
      inlineSelectionTriggerCount: 3,
      rendererMode: 'inline',
    })));
  });

  it('配置未返回偏好时 fallback 保存仍携带历史单击触发次数', async () => {
    const api = createApi({ getConfig: vi.fn(async () => ({ activeEngineId: 'google', theme: 'pearl-reader' as const })) });
    await renderAndAwaitLoaded(api);

    await userEvent.selectOptions(screen.getByLabelText('目标语言'), 'ja');
    await waitFor(() => expect(api.savePopupState).toHaveBeenCalled());
    expect(api.savePopupState).toHaveBeenLastCalledWith('google', expect.objectContaining({
      targetLanguage: 'ja',
      inlineSelectionModifier: 'Control',
      inlineSelectionTriggerCount: 1,
    }));
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
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '翻译当前页面' }));
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
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeEnabled();
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
    const api = createApi({
      subscribeProgress: vi.fn((listener) => {
        listener({ status: 'complete', completed: 2, failed: 0, total: 2 });
        return () => undefined;
      }),
    });
    render(<PopupApp api={api} />);
    await screen.findByRole('button', { name: '显示当前页面原文' });
    await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toBeEnabled());

    await userEvent.selectOptions(screen.getByLabelText('翻译引擎'), 'bing');

    await waitFor(() => expect(api.sendToPage).toHaveBeenCalledWith({
      type: 'translate-page', engineId: 'bing', scope: 'whole-page', sourceLanguage: 'auto', mode: 'bilingual', targetLanguage: 'zh-Hans',
    }));
    expect(api.savePopupState).toHaveBeenCalledWith('bing', expect.objectContaining({ displayMode: 'bilingual' }));
    expect(screen.getByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument();
  });

  it('translating 即使尚未扫描到段落也视为当前页面已翻译', async () => {
    const api = createApi({
      subscribeProgress: vi.fn((listener) => {
        listener({ status: 'translating', completed: 0, failed: 0, total: 0 });
        return () => undefined;
      }),
    });
    render(<PopupApp api={api} />);

    expect(await screen.findByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument();
  });

  it('fatal error 或空页面完成时保持翻译按钮，非空错误仍可恢复原文', async () => {
    let progressListener: ((progress: { status: string; completed: number; failed: number; total: number }) => void) | undefined;
    const api = createApi({ subscribeProgress: vi.fn((listener) => { progressListener = listener; return () => undefined; }) });
    render(<PopupApp api={api} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeEnabled());

    progressListener?.({ status: 'error', completed: 0, failed: 0, total: 0 });
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeInTheDocument();
    progressListener?.({ status: 'complete', completed: 0, failed: 0, total: 0 });
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeInTheDocument();
    progressListener?.({ status: 'error', completed: 0, failed: 2, total: 2 });
    await waitFor(() => expect(screen.getByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument());
  });

  it('已翻译页面切换显示模式后立即重译并保持显示原文按钮', async () => {
    const api = createApi({
      subscribeProgress: vi.fn((listener) => {
        listener({ status: 'complete', completed: 2, failed: 0, total: 2 });
        return () => undefined;
      }),
    });
    render(<PopupApp api={api} />);
    await screen.findByRole('button', { name: '显示当前页面原文' });
    await waitFor(() => expect(screen.getByRole('button', { name: '双语对照' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '双语对照' }));

    await waitFor(() => expect(api.sendToPage).toHaveBeenCalledWith({
      type: 'translate-page', engineId: 'google', scope: 'whole-page', sourceLanguage: 'auto', mode: 'translation-only', targetLanguage: 'zh-Hans',
    }));
    expect(api.savePopupState).toHaveBeenCalledWith('google', expect.objectContaining({ displayMode: 'translation' }));
    expect(screen.getByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument();
  });

  it('翻译后主按钮切换为显示当前页面原文，再次点击恢复', async () => {
    let progressListener: ((progress: { status: string; completed: number; failed: number; total: number }) => void) | undefined;
    const api = createApi({ subscribeProgress: vi.fn((listener) => { progressListener = listener; return () => undefined; }) });
    render(<PopupApp api={api} />);
    const translateButton = await screen.findByRole('button', { name: '翻译当前页面' });
    await waitFor(() => expect(translateButton).toBeEnabled());
    await userEvent.click(translateButton);
    expect(api.setTranslationBadge).toHaveBeenCalledWith(true);
    expect(api.sendToPage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-page', scope: 'whole-page', targetLanguage: 'zh-Hans' }));
    progressListener?.({ status: 'complete', completed: 1, failed: 0, total: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument());
    await userEvent.click(await screen.findByRole('button', { name: '显示当前页面原文' }));
    expect(api.sendToPage).toHaveBeenLastCalledWith({ type: 'restore-page' });
    expect(api.setTranslationBadge).toHaveBeenLastCalledWith(false);
  });

  it('翻译命令确认后立即解除 busy，页面活动状态等待进度事件', async () => {
    let progressListener: ((progress: { status: string; completed: number; failed: number; total: number }) => void) | undefined;
    const api = createApi({
      sendToPage: vi.fn(async () => ({ accepted: true })),
      subscribeProgress: vi.fn((listener) => { progressListener = listener; return () => undefined; }),
    });
    await renderAndAwaitLoaded(api);

    const button = screen.getByRole('button', { name: '翻译当前页面' });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeInTheDocument();
    progressListener?.({ status: 'translating', completed: 0, failed: 0, total: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument());
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

  it('用户绑定自定义快捷键时展示实际绑定 kbd，且不影响按钮 accessible name', async () => {
    const api = createApi({
      getPageTranslationShortcut: vi.fn(async () => ({
        status: 'assigned' as const,
        shortcut: 'Ctrl+Shift+Y',
        displayShortcut: 'Ctrl + Shift + Y',
      })),
    });
    render(<PopupApp api={api} />);
    const button = await screen.findByRole('button', { name: '翻译当前页面' });
    expect(button).toBeInTheDocument();
    expect(screen.getByText('Ctrl + Shift + Y', { selector: 'kbd' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-describedby');
    expect(document.getElementById(button.getAttribute('aria-describedby')!)).toHaveTextContent('Ctrl + Shift + Y');
    expect(screen.queryByText(/Alt\s*\+\s*A/i)).not.toBeInTheDocument();
  });

  it('快捷键未分配时展示弱提示，主按钮仍可用且不回退默认快捷键', async () => {
    const api = createApi({
      getPageTranslationShortcut: vi.fn(async () => ({ status: 'unassigned' as const })),
    });
    render(<PopupApp api={api} />);
    const button = await screen.findByRole('button', { name: '翻译当前页面' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(api.sendToPage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-page' }));
    expect(await screen.findByText('未设置页面快捷键，仍可点击按钮翻译')).toBeInTheDocument();
    expect(screen.queryByText(/Alt\s*\+\s*A/i)).not.toBeInTheDocument();
  });

  it('快捷键不可用时展示暂不可读弱提示，主按钮仍可用', async () => {
    const api = createApi({
      getPageTranslationShortcut: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'api-error' })),
    });
    render(<PopupApp api={api} />);
    const button = await screen.findByRole('button', { name: '翻译当前页面' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(api.sendToPage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-page' }));
    expect(await screen.findByText('暂时无法读取页面快捷键，按钮仍可使用')).toBeInTheDocument();
  });

  it('命令读取挂起或失败不阻塞配置加载和主翻译按钮', async () => {
    const api = createApi({
      getPageTranslationShortcut: vi.fn(() => new Promise<never>(() => {})),
    });
    render(<PopupApp api={api} />);
    await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toBeEnabled());
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeEnabled();
  });

  it('配置加载失败但命令读取成功时保持配置门禁，设置入口仍可用', async () => {
    const api = createApi({
      getConfig: vi.fn(async () => { throw new Error('配置读取失败'); }),
      getPageTranslationShortcut: vi.fn(async () => ({ status: 'assigned' as const, shortcut: 'Alt+A', displayShortcut: 'Alt + A' })),
    });
    render(<PopupApp api={api} />);
    expect(await screen.findByText('配置读取失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '设置' })).toBeEnabled();
  });

  it('Popup 初始化仅通过 subscribeProgress 订阅进度，不调用 getProgress', async () => {
    const getProgressSpy = vi.fn(async () => undefined);
    const subscribeProgressSpy = vi.fn(() => () => undefined);
    const api = createApi({
      subscribeProgress: subscribeProgressSpy,
      ...( { getProgress: getProgressSpy } as Record<string, unknown> ),
    });
    render(<PopupApp api={api} />);
    await waitFor(() => expect(subscribeProgressSpy).toHaveBeenCalledTimes(1));
    expect(getProgressSpy).not.toHaveBeenCalled();
  });

  it('配置挂起时展示“正在加载设置”弱提示，控件禁用且设置入口可用', async () => {
    const api = createApi({
      getConfig: vi.fn(() => new Promise<never>(() => {})),
    });
    render(<PopupApp api={api} />);
    expect(await screen.findByText('正在加载设置')).toBeInTheDocument();
    expect(screen.getByLabelText('源语言')).toBeDisabled();
    expect(screen.getByLabelText('目标语言')).toBeDisabled();
    expect(screen.getByLabelText('翻译引擎')).toBeDisabled();
    expect(screen.getByRole('button', { name: '双语对照' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '设置' })).toBeEnabled();
  });

  it('配置加载失败时展示错误提示与重试按钮，重试成功后恢复就绪且不执行 fallback 保存', async () => {
    let callCount = 0;
    const api = createApi({
      getConfig: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('网络超时');
        return {
          preferences: { ...preferences, rendererMode: 'inline' as const, targetLanguage: 'ja' },
          activeEngineId: 'bing',
          theme: 'pearl-reader' as const,
          availableEngines: [
            { id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } },
            { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } },
          ],
        };
      }),
    });
    render(<PopupApp api={api} />);
    expect(await screen.findByText('网络超时')).toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: '重试' });
    expect(retryButton).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译当前页面' })).toBeDisabled();

    await userEvent.click(retryButton);

    await waitFor(() => expect(screen.getByLabelText('翻译引擎')).toBeEnabled());
    expect(screen.getByLabelText('翻译引擎')).toHaveValue('bing');
    expect(screen.getByLabelText('目标语言')).toHaveValue('ja');
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(api.savePopupState).not.toHaveBeenCalled();
    expect(api.savePreferences).not.toHaveBeenCalled();
  });

  it('实时 translating 先到、旧快照后到时 UI 保持显示原文不倒退', async () => {
    let progressListener!: (p: { status: string; completed: number; failed: number; total: number }) => void;
    const api = createApi({
      subscribeProgress: vi.fn((listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    });
    render(<PopupApp api={api} />);
    await waitFor(() => expect(progressListener).toBeDefined());

    // 实时 translating 先到
    progressListener({ status: 'translating', completed: 1, failed: 0, total: 5 });
    await waitFor(() => expect(screen.getByRole('button', { name: '显示当前页面原文' })).toBeInTheDocument());
    expect(screen.getByText('翻译中 1/5')).toBeInTheDocument();
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
    expect(executeScript).toHaveBeenNthCalledWith(1, { target: { tabId: 7, allFrames: true }, files: ['input-translation.js'] });
    expect(executeScript).toHaveBeenNthCalledWith(2, { target: { tabId: 7 }, files: ['content.js', 'content-inline.js', 'content-main.js'] });
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
