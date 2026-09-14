import { registerInputTranslation } from './input-translation';

const runtime = globalThis as typeof globalThis & { __vastInputTranslation?: boolean };
if (!runtime.__vastInputTranslation && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  runtime.__vastInputTranslation = true;
  registerInputTranslation({
    async getConfig() {
      const response = await chrome.runtime.sendMessage({ type: 'get-public-config' });
      if (!response?.ok || !response.data) throw new Error('无法读取翻译设置');
      return response.data;
    },
    async translate(text, engineId, targetLanguage) {
      const response = await chrome.runtime.sendMessage({ type: 'translate-selection-inline', text, engineId, targetLanguage });
      if (!response?.ok || typeof response.data?.text !== 'string') throw new Error('输入框翻译失败');
      return response.data.text;
    },
  });
}
