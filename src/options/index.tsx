import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp';
import { DEFAULT_CONFIG, type TranslatorConfig } from '../shared/config';
import '../ui.css';
import { createTranslator } from '../shared/i18n';

const api = {
  async load(): Promise<{ config: TranslatorConfig; hasApiKey: boolean }> {
    const response = await chrome.runtime.sendMessage({ type: 'get-options-config' }) as { data?: Partial<TranslatorConfig> & { hasApiKey?: boolean } };
    const data = response.data;
    return { config: {
      ...DEFAULT_CONFIG,
      ...(data && {
        baseUrl: data.baseUrl,
        model: data.model,
        targetLanguage: data.targetLanguage,
        displayMode: data.displayMode,
        userInstruction: data.userInstruction,
        translationPosition: data.translationPosition,
        scanScope: data.scanScope,
        selectionContext: data.selectionContext,
      }),
      apiKey: '',
    }, hasApiKey: Boolean(data?.hasApiKey) };
  },
  async save(config: TranslatorConfig) {
    const response = await chrome.runtime.sendMessage({ type: 'save-secret-config', config }) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error);
  },
  async testConnection(config: TranslatorConfig) {
    const response = await chrome.runtime.sendMessage({ type: 'test-connection', config }) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error);
  },
  async clearCache() { await chrome.runtime.sendMessage({ type: 'clear-cache' }); },
  async clearApiKey() { await chrome.runtime.sendMessage({ type: 'clear-api-key' }); },
  exportConfig(config: Omit<TranslatorConfig, 'apiKey'>) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vast-translator-config.json';
    anchor.click();
    URL.revokeObjectURL(url);
  },
};

createRoot(document.getElementById('root')!).render(<OptionsApp api={api} t={createTranslator(chrome.i18n.getMessage)} />);
