import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OptionsApp, type OptionsApi } from '../../src/options/OptionsApp';
import { DEFAULT_SETTINGS, type OptionsSettings } from '../../src/shared/config';

afterEach(cleanup);

const loaded: OptionsSettings = {
  ...DEFAULT_SETTINGS,
  engines: [
    ...DEFAULT_SETTINGS.engines.filter((engine): engine is Extract<typeof engine, { kind: 'google' | 'bing' }> => engine.kind !== 'custom-ai'),
    { id: 'custom-work', kind: 'custom-ai', name: '工作 AI', enabled: true, order: 2, baseUrl: 'https://work.example/v1', model: 'work-model', hasApiKey: true },
    { id: 'custom-home', kind: 'custom-ai', name: '个人 AI', enabled: false, order: 3, baseUrl: 'https://home.example/v1', model: 'home-model', hasApiKey: false },
  ],
};

function createApi(settings: OptionsSettings = loaded): OptionsApi {
  return {
    load: vi.fn(async () => structuredClone(settings)),
    savePreferences: vi.fn(async () => undefined),
    upsertEngine: vi.fn(async () => undefined),
    deleteEngine: vi.fn(async () => undefined),
    setActiveEngine: vi.fn(async () => undefined),
    setEngineEnabled: vi.fn(async () => undefined),
    reorderEngines: vi.fn(async () => undefined),
    testEngine: vi.fn(async () => undefined),
    clearEngineApiKey: vi.fn(async () => undefined),
    importSettings: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    saveTheme: vi.fn(async () => undefined),
    exportSettings: vi.fn(),
  };
}

function createStatefulApi(settings: OptionsSettings = loaded): OptionsApi {
  let current = structuredClone(settings);
  const api = createApi(current);
  vi.mocked(api.load).mockImplementation(async () => structuredClone(current));
  vi.mocked(api.setActiveEngine).mockImplementation(async (engineId) => { current.activeEngineId = engineId; });
  vi.mocked(api.setEngineEnabled).mockImplementation(async (engineId, enabled) => {
    current.engines = current.engines.map((engine) => engine.id === engineId ? { ...engine, enabled } : engine);
    if (!enabled && current.activeEngineId === engineId) current.activeEngineId = 'google';
  });
  vi.mocked(api.reorderEngines).mockImplementation(async (engineIds) => {
    current.engines = engineIds.map((id, order) => ({ ...current.engines.find((engine) => engine.id === id)!, order }));
  });
  vi.mocked(api.deleteEngine).mockImplementation(async (engineId) => { current.engines = current.engines.filter((engine) => engine.id !== engineId); });
  vi.mocked(api.clearEngineApiKey).mockImplementation(async (engineId) => {
    current.engines = current.engines.map((engine) => engine.id === engineId && engine.kind === 'custom-ai' ? { ...engine, hasApiKey: false } : engine);
  });
  return api;
}

describe('Options v2 多引擎设置', () => {
  it('提供五张外观主题卡，点击后立即保存并应用到根节点', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    expect(await screen.findByRole('main')).toHaveAttribute('data-theme', 'pearl-reader');
    const themeRegion = screen.getByRole('region', { name: '外观主题' });
    for (const name of ['Pearl Reader', 'Command Translator', 'Sage Global', 'Editorial Lingua', 'Precision Blue']) {
      expect(within(themeRegion).getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    }
    await userEvent.click(within(themeRegion).getByRole('button', { name: /Command Translator/ }));
    expect(api.saveTheme).toHaveBeenCalledWith('command-translator');
    expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'command-translator');
    expect(document.documentElement).toHaveAttribute('data-theme', 'command-translator');
  });

  it('使用左侧六项导航并提供独立划词翻译章节', async () => {
    render(<OptionsApp api={createApi()} />);
    const nav = await screen.findByRole('navigation', { name: '设置导航' });
    for (const name of ['翻译引擎', '自定义 AI', '阅读偏好', '划词翻译', '外观主题', '数据隐私']) {
      expect(within(nav).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('region', { name: '划词翻译' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增自定义 AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出配置' })).toBeInTheDocument();
  });

  it('reload 失败后结束加载、显示错误并允许重试成功', async () => {
    const api = createApi();
    vi.mocked(api.load)
      .mockRejectedValueOnce(new Error('设置加载失败'))
      .mockResolvedValueOnce(structuredClone(loaded));
    render(<OptionsApp api={api} />);

    expect(await screen.findByRole('status')).toHaveTextContent('设置加载失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('group', { name: '工作 AI' })).toBeInTheDocument();
    expect(api.load).toHaveBeenCalledTimes(2);
  });

  it('内置引擎只显示简洁的内置标识，不展示默认免费或备用说明', async () => {
    render(<OptionsApp api={createApi()} />);
    const builtins = await screen.findByRole('region', { name: '内置翻译引擎' });
    expect(within(builtins).getByText('Google')).toBeInTheDocument();
    expect(within(builtins).queryByText(/默认.*免费/)).not.toBeInTheDocument();
    expect(within(builtins).getByText('Bing')).toBeInTheDocument();
    expect(within(builtins).queryByText(/备用/)).not.toBeInTheDocument();
    expect(within(builtins).getAllByText('内置')).toHaveLength(2);
    expect(within(builtins).queryByLabelText(/Base URL/)).not.toBeInTheDocument();
    expect(within(builtins).queryByLabelText(/API Key/)).not.toBeInTheDocument();
  });

  it('保存划词悬浮按钮、内联快捷键，并解释有限上下文用途', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    const popup = await screen.findByRole('checkbox', { name: '显示划词悬浮按钮' });
    const modifier = screen.getByRole('combobox', { name: '选区内联翻译快捷键' });

    await userEvent.click(popup);
    await userEvent.selectOptions(modifier, 'Alt');
    await userEvent.click(screen.getByRole('button', { name: '保存阅读偏好' }));

    expect(api.savePreferences).toHaveBeenCalledWith(expect.objectContaining({
      selectionPopupEnabled: false,
      inlineSelectionModifier: 'Alt',
    }));
    expect(screen.getByText(/发送选区所在段落的有限文本帮助消歧，不翻译上下文本身/)).toBeInTheDocument();
  });

  it('测试连接立即显示测试中，成功失败均更新固定 Toast，按钮使用小号动作类', async () => {
    let resolveTest!: () => void;
    const api = createApi();
    vi.mocked(api.testEngine).mockReturnValue(new Promise<void>((resolve) => { resolveTest = resolve; }));
    render(<OptionsApp api={api} />);
    const builtins = await screen.findByRole('region', { name: '内置翻译引擎' });
    const button = within(builtins).getAllByRole('button', { name: '测试连接' })[0];
    expect(button).toHaveClass('compact-action');
    await userEvent.click(button);
    expect(screen.getByRole('status')).toHaveTextContent('正在测试连接');
    resolveTest();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接成功'));

    vi.mocked(api.testEngine).mockRejectedValueOnce(new Error('连接失败'));
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('连接失败'));
    expect(screen.getByRole('status')).toHaveClass('status-toast');
  });

  it('显示 0.3.0 版本', async () => {
    render(<OptionsApp api={createApi()} />);
    expect(await screen.findAllByText('v0.3.0')).toHaveLength(2);
  });

  it('展示多个独立 custom 表单及逐实例 hasApiKey，并保存指定实例', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    const work = await screen.findByRole('group', { name: '工作 AI' });
    const home = screen.getByRole('group', { name: '个人 AI' });
    expect(within(work).getByText(/已保存 API Key/)).toBeInTheDocument();
    expect(within(home).queryByText(/已保存 API Key/)).not.toBeInTheDocument();
    await userEvent.clear(within(home).getByLabelText('名称'));
    await userEvent.type(within(home).getByLabelText('名称'), '家庭 AI');
    await userEvent.type(within(home).getByLabelText('API Key'), 'home-secret');
    await userEvent.click(within(home).getByRole('button', { name: '保存实例' }));
    expect(api.upsertEngine).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-home', name: '家庭 AI', apiKey: 'home-secret' }));
    expect(api.upsertEngine).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-work' }));
  });

  it('同 origin 空 key 保留状态，修改 origin 后清除该实例 key 状态并要求重输', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    const work = await screen.findByRole('group', { name: '工作 AI' });
    await userEvent.clear(within(work).getByLabelText('Base URL'));
    await userEvent.type(within(work).getByLabelText('Base URL'), 'https://other.example/v1');
    expect(within(work).getByText(/来源已变化.*重新输入 API Key/)).toBeInTheDocument();
    await userEvent.click(within(work).getByRole('button', { name: '保存实例' }));
    expect(api.upsertEngine).not.toHaveBeenCalled();
  });

  it('支持新增、默认、启停、测试、清 key、删除确认和上下排序', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    await screen.findByRole('group', { name: '工作 AI' });
    await userEvent.click(screen.getByRole('button', { name: '新增自定义 AI' }));
    expect(screen.getAllByRole('group', { name: /自定义 AI/ })).toHaveLength(1);

    const work = screen.getByRole('group', { name: '工作 AI' });
    await userEvent.click(within(work).getByRole('button', { name: '设为默认' }));
    await userEvent.click(within(work).getByRole('checkbox', { name: '启用' }));
    await userEvent.click(within(work).getByRole('button', { name: '测试连接' }));
    await userEvent.click(within(work).getByRole('button', { name: '下移' }));
    await userEvent.click(within(screen.getByRole('group', { name: '个人 AI' })).getByRole('button', { name: '上移' }));
    await userEvent.click(within(work).getByRole('button', { name: '清除 API Key' }));
    await userEvent.click(within(work).getByRole('button', { name: '确认清除 API Key' }));
    await userEvent.click(within(work).getByRole('button', { name: '删除实例' }));
    expect(within(work).getByText(/再次点击确认删除/)).toBeInTheDocument();
    await userEvent.click(within(work).getByRole('button', { name: '确认删除实例' }));

    expect(api.setActiveEngine).toHaveBeenCalledWith('custom-work');
    expect(api.setEngineEnabled).toHaveBeenCalledWith('custom-work', false);
    expect(api.testEngine).toHaveBeenCalledWith('custom-work', expect.objectContaining({ id: 'custom-work', apiKey: '' }));
    expect(api.reorderEngines).toHaveBeenCalledTimes(2);
    expect(api.clearEngineApiKey).toHaveBeenCalledWith('custom-work');
    expect(api.deleteEngine).toHaveBeenCalledWith('custom-work');
  });

  it('成功默认、启停、排序、清 key 和删除后立即 reload 并同步 UI', async () => {
    const api = createStatefulApi();
    render(<OptionsApp api={api} />);
    const work = await screen.findByRole('group', { name: '工作 AI' });

    await userEvent.click(within(work).getByRole('button', { name: '设为默认' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: '工作 AI' })).getByText('当前默认')).toBeVisible());
    await userEvent.click(within(screen.getByRole('group', { name: '工作 AI' })).getByRole('checkbox', { name: '启用' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: '工作 AI' })).getByRole('checkbox', { name: '启用' })).not.toBeChecked());

    const home = screen.getByRole('group', { name: '个人 AI' });
    await userEvent.click(within(home).getByRole('button', { name: '上移' }));
    await waitFor(() => expect(screen.getAllByRole('group')[0]).toHaveAccessibleName('个人 AI'));

    const workAfterMove = screen.getByRole('group', { name: '工作 AI' });
    await userEvent.click(within(workAfterMove).getByRole('button', { name: '清除 API Key' }));
    await userEvent.click(within(workAfterMove).getByRole('button', { name: '确认清除 API Key' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: '工作 AI' })).queryByText(/已保存 API Key/)).not.toBeInTheDocument());

    const homeAfterClear = screen.getByRole('group', { name: '个人 AI' });
    await userEvent.click(within(homeAfterClear).getByRole('button', { name: '删除实例' }));
    await userEvent.click(within(homeAfterClear).getByRole('button', { name: '确认删除实例' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: '个人 AI' })).not.toBeInTheDocument());
    expect(api.load).toHaveBeenCalledTimes(6);
  });

  it('并发成功操作的旧 reload 响应不能覆盖较新的 settings', async () => {
    const api = createApi();
    let resolveOlder!: (settings: OptionsSettings) => void;
    vi.mocked(api.setActiveEngine).mockResolvedValue(undefined);
    vi.mocked(api.setEngineEnabled).mockResolvedValue(undefined);
    vi.mocked(api.load)
      .mockResolvedValueOnce(structuredClone(loaded))
      .mockReturnValueOnce(new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({
        ...structuredClone(loaded), activeEngineId: 'custom-work',
        engines: loaded.engines.map((engine) => engine.id === 'bing' ? { ...engine, enabled: false } : engine),
      });
    render(<OptionsApp api={api} />);
    await screen.findByRole('group', { name: '工作 AI' });

    await userEvent.click(within(screen.getByRole('group', { name: '工作 AI' })).getByRole('button', { name: '设为默认' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bing 启用' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Bing 启用' })).not.toBeChecked());
    resolveOlder(structuredClone(loaded));

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Bing 启用' })).not.toBeChecked());
    expect(within(screen.getByRole('group', { name: '工作 AI' })).getByText('当前默认')).toBeVisible();
  });

  it('达到 20 个 custom 时禁用新增，并明确 instruction 只适用于自定义 AI', async () => {
    const engines: OptionsSettings['engines'] = [...DEFAULT_SETTINGS.engines.filter((engine): engine is Extract<typeof engine, { kind: 'google' | 'bing' }> => engine.kind !== 'custom-ai'), ...Array.from({ length: 20 }, (_, index) => ({
      id: `custom-${index}`, kind: 'custom-ai' as const, name: `AI ${index}`, enabled: true, order: index + 2,
      baseUrl: `https://api${index}.example/v1`, model: 'model', hasApiKey: true,
    }))];
    render(<OptionsApp api={createApi({ ...DEFAULT_SETTINGS, engines })} />);
    expect(await screen.findByRole('button', { name: '新增自定义 AI' })).toBeDisabled();
    expect(screen.getByText(/自定义翻译要求仅对自定义 AI 生效/)).toBeInTheDocument();
  });

  it('v2 导出完整多实例但不含 key，导入交给后台安全合并', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    await screen.findByRole('group', { name: '工作 AI' });
    await userEvent.click(screen.getByRole('button', { name: '导出配置' }));
    const exported = vi.mocked(api.exportSettings).mock.calls[0][0];
    expect(exported.schemaVersion).toBe(2);
    expect(exported.engines).toHaveLength(4);
    expect(JSON.stringify(exported)).not.toMatch(/apiKey|hasApiKey|secret/);

    const imported = { ...DEFAULT_SETTINGS, activeEngineId: 'bing' };
    const file = new File([JSON.stringify(imported)], 'settings.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('导入配置'), file);
    await waitFor(() => expect(api.importSettings).toHaveBeenCalledWith(imported));
  });
});
