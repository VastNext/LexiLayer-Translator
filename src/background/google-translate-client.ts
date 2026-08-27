import type { TranslationRequest, TranslationResult } from '../shared/messages';
import type { Provider, ProviderClientOptions } from './provider';
import { fetchTranslation, mapGoogleLanguage } from './translate-http';

function readGoogleText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  if (typeof value[0] === 'string') return value[0];
  const fragments = Array.isArray(value[0]) && value[0].every((item) => Array.isArray(item)) ? value[0] : value;
  if (!fragments.every((item) => Array.isArray(item) && typeof item[0] === 'string')) return undefined;
  return fragments.map((item) => item[0] as string).join('');
}

export class GoogleTranslateClient implements Provider {
  readonly capabilities = { streaming: false };
  readonly cacheIdentity = { engineId: 'google', engineFingerprint: 'google-public-v1', adapterVersion: 'google-v1' };

  constructor(private readonly options: ProviderClientOptions = {}) {}

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult[]> {
    const parameters = new URLSearchParams({ client: 'gtx', dt: 't', sl: request.sourceLanguage === 'auto' ? 'auto' : mapGoogleLanguage(request.sourceLanguage), tl: mapGoogleLanguage(request.targetLanguage) });
    const body = new URLSearchParams();
    request.segments.forEach((segment) => body.append('q', segment.text));
    const response = await fetchTranslation('Google ', `https://translate.googleapis.com/translate_a/t?${parameters}`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body.toString(),
    }, this.options, signal);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('Google 翻译响应不是有效 JSON'); }
    if (!Array.isArray(payload) || payload.length !== request.segments.length) throw new Error('Google 翻译响应格式无效');
    return request.segments.map((segment, index) => {
      const text = readGoogleText(payload[index]);
      if (text === undefined) throw new Error('Google 翻译响应格式无效');
      return { id: segment.id, text };
    });
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.translate({ sourceLanguage: 'en', targetLanguage: 'en', segments: [{ id: 'test', text: 'test' }] }, signal);
  }
}
