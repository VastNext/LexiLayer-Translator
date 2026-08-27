import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OptionsApp, type OptionsApi } from '../../src/options/OptionsApp';
import { DEFAULT_CONFIG } from '../../src/shared/config';
import type { Translator } from '../../src/shared/i18n';

afterEach(cleanup);

function createApi(): OptionsApi {
  return {
    load: vi.fn(async () => ({ config: { ...DEFAULT_CONFIG, apiKey: '', targetLanguage: 'zh-Hans' }, hasApiKey: true })),
    save: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
    exportConfig: vi.fn(),
  };
}

describe('设置页', () => {
  it('支持完整英文核心设置文本', async () => {
    const t: Translator = (key) => ({ optionsApiConnection: 'API connection', optionsReadingPreferences: 'Reading preferences', optionsDataManagement: 'Data management', actionSaveSettings: 'Save settings', actionClearApiKey: 'Clear API key' }[key] ?? key);
    render(<OptionsApp api={createApi()} t={t} />);
    expect(await screen.findByText('API connection')).toBeInTheDocument();
    expect(screen.getByText('Reading preferences')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeInTheDocument();
  });
  it('展示完整语言、连接目的和密钥与文本发送风险说明', async () => {
    render(<OptionsApp api={createApi()} />);
    await waitFor(() => expect(screen.getByLabelText('API Key')).toBeEnabled());
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByText(/已保存 API Key/)).toBeInTheDocument();
    const values = [...screen.getByLabelText('目标语言').querySelectorAll('option')].map((option) => option.value);
    expect(values).toEqual(['auto', 'zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'it', 'de', 'es', 'pt', 'ru', 'ar']);
    expect(screen.getByText((_text, element) => element?.tagName === 'SMALL' && /连接目的.*api\.openai\.com/i.test(element.textContent ?? ''))).toBeInTheDocument();
    expect(screen.getByText(/HTTP.*localhost.*127\.0\.0\.1/i)).toBeInTheDocument();
    expect(screen.getByText(/API Key.*浏览器本地/i)).toBeInTheDocument();
    expect(screen.getByText(/选中的文本.*API 服务/i)).toBeInTheDocument();
  });

  it('使用原生可聚焦控件导入配置并提供状态语义', async () => {
    render(<OptionsApp api={createApi()} />);
    await screen.findByText(/已保存 API Key/);

    expect(screen.getByRole('button', { name: '导入配置' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('设置尚未修改');
  });

  it('已有密钥时空输入可保存偏好且显式按钮单独清除密钥', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    const key = screen.getByLabelText('API Key') as HTMLInputElement;
    await waitFor(() => expect(key).toBeEnabled());
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(screen.getByLabelText('译文位置')).toHaveValue('after');
    expect(screen.getByLabelText('有限上下文')).toBeChecked();
    await userEvent.clear(screen.getByLabelText('模型'));
    await userEvent.type(screen.getByLabelText('模型'), 'gpt-custom');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-custom', apiKey: '' }));
    await userEvent.click(screen.getByRole('button', { name: '清除 API Key' }));
    expect(api.clearApiKey).not.toHaveBeenCalled();
    expect(screen.getByText('再次点击确认清除密钥')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认清除 API Key' }));
    expect(api.clearApiKey).toHaveBeenCalledOnce();
  });

  it('首次没有密钥时必须输入 API Key 才能保存', async () => {
    const api = createApi();
    vi.mocked(api.load).mockResolvedValue({ config: { ...DEFAULT_CONFIG, apiKey: '' }, hasApiKey: false });
    render(<OptionsApp api={api} />);
    await waitFor(() => expect(screen.getByLabelText('API Key')).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/API Key/);
  });

  it('首次保存 key 后转为已保存状态并清空表单，随后空 key 可保存偏好，clear 后恢复无 key', async () => {
    const api = createApi();
    vi.mocked(api.load).mockResolvedValue({ config: { ...DEFAULT_CONFIG, apiKey: '' }, hasApiKey: false });
    render(<OptionsApp api={api} />);
    const key = await screen.findByLabelText('API Key');
    await waitFor(() => expect(key).toBeEnabled());

    await userEvent.type(key, 'sk-new-secret');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(api.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ apiKey: 'sk-new-secret' }));
    expect(key).toHaveValue('');
    expect(screen.getByText(/已保存 API Key/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('模型'));
    await userEvent.type(screen.getByLabelText('模型'), 'next-model');
    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(api.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ apiKey: '', model: 'next-model' }));

    await userEvent.click(screen.getByRole('button', { name: '清除 API Key' }));
    await userEvent.click(screen.getByRole('button', { name: '确认清除 API Key' }));
    await waitFor(() => expect(screen.queryByText(/已保存 API Key/)).not.toBeInTheDocument());
  });

  it('导出配置不含 key，导入也不能覆盖现有 key', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    await screen.findByText(/已保存 API Key/);
    await userEvent.click(screen.getByRole('button', { name: '导出配置' }));
    expect(api.exportConfig).toHaveBeenCalledWith(expect.not.objectContaining({ apiKey: expect.anything() }));

    const file = new File([JSON.stringify({ model: 'imported' })], 'config.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('导入配置'), file);
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('imported'));
  });

  it('导入配置的 Base URL origin 变化时清空 key 并明确提示重新输入', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    await screen.findByText(/已保存 API Key/);

    const file = new File([JSON.stringify({ baseUrl: 'https://other.example/v1' })], 'config.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('导入配置'), file);

    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue(''));
    expect(screen.getByText(/Base URL.*重新输入 API Key/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/API Key/);
  });

  it('拒绝包含未知字段的导入配置', async () => {
    render(<OptionsApp api={createApi()} />);
    await screen.findByText(/已保存 API Key/);

    const file = new File([JSON.stringify({ model: 'imported', apiKey: 'stolen', unexpected: true })], 'config.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('导入配置'), file);

    await waitFor(() => expect(screen.getByText(/未知字段/)).toBeInTheDocument());
    expect(screen.getByLabelText('模型')).toHaveValue(DEFAULT_CONFIG.model);
    expect(screen.getByLabelText('API Key')).toHaveValue('');
  });

  it('保存前校验配置并显示错误，不调用保存 API', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    await screen.findByText(/已保存 API Key/);
    await userEvent.clear(screen.getByLabelText('Base URL'));
    await userEvent.type(screen.getByLabelText('Base URL'), 'http://api.example.com/v1');

    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByText(/Base URL 仅允许 HTTPS/)).toBeInTheDocument();
  });

  it('清理缓存需要确认后调用固定 API', async () => {
    const api = createApi();
    render(<OptionsApp api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '清理缓存' }));
    expect(screen.getByText('再次点击确认清理')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '确认清理' }));
    expect(api.clearCache).toHaveBeenCalledOnce();
  });
});
