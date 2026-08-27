import type { TranslationRequest, TranslationResult } from '../shared/messages';
import type { Provider, ProviderClientOptions } from './provider';
import { fetchTranslation, mapBingLanguage } from './translate-http';

export class BingTranslateClient implements Provider {
  readonly capabilities = { streaming: false };
  readonly cacheIdentity = { engineId: 'bing', engineFingerprint: 'bing-public-v1', adapterVersion: 'bing-v1' };

  constructor(private readonly options: ProviderClientOptions = {}) {}

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult[]> {
    const parameters = new URLSearchParams({ to: mapBingLanguage(request.targetLanguage), isEnterpriseClient: 'false' });
    if (request.sourceLanguage !== 'auto') parameters.set('from', mapBingLanguage(request.sourceLanguage));
    const response = await fetchTranslation('Bing ', `https://edge.microsoft.com/translate/translatetext?${parameters}`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.segments.map(({ text }) => text)),
    }, this.options, signal);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('Bing 翻译响应不是有效 JSON'); }
    if (!Array.isArray(payload) || payload.length !== request.segments.length) throw new Error('Bing 翻译响应格式无效');
    return request.segments.map((segment, index) => {
      const item = payload[index];
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Bing 翻译响应格式无效');
      const translations = (item as Record<string, unknown>).translations;
      if (!Array.isArray(translations) || translations.length < 1) throw new Error('Bing 翻译响应格式无效');
      const translation = translations[0];
      if (typeof translation !== 'object' || translation === null || Array.isArray(translation) || typeof (translation as Record<string, unknown>).text !== 'string') throw new Error('Bing 翻译响应格式无效');
      return { id: segment.id, text: (translation as Record<string, string>).text };
    });
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.translate({ sourceLanguage: 'en', targetLanguage: 'en', segments: [{ id: 'test', text: 'test' }] }, signal);
  }
}
