import type { CustomAiEngine } from '../shared/config';
import type { TranslationRequest, TranslationResult } from '../shared/messages';
import { OpenAiClient } from './openai-client';
import type { Provider, ProviderClientOptions } from './provider';

export class CustomAiAdapter implements Provider {
  readonly capabilities = { streaming: true };
  readonly cacheIdentity;
  private readonly client: OpenAiClient;

  constructor(engine: CustomAiEngine, options: ProviderClientOptions = {}) {
    this.client = new OpenAiClient({ ...engine, ...options });
    const url = new URL(engine.baseUrl);
    this.cacheIdentity = {
      engineId: engine.id,
      engineFingerprint: `custom-ai:${url.origin}${url.pathname.replace(/\/+$/, '')}:${engine.model}`,
      adapterVersion: 'custom-ai-v1',
    };
  }

  translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult[]> {
    return this.client.translate(request, signal);
  }

  streamSelection(text: string, sourceLanguage: string, targetLanguage: string, userInstruction: string | undefined, context: string | undefined, signal?: AbortSignal): AsyncIterable<string> {
    return this.client.streamText(text, sourceLanguage, targetLanguage, signal, userInstruction, context);
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.translate({ sourceLanguage: 'en', targetLanguage: 'en', segments: [{ id: 'test', text: 'test' }] }, signal);
  }
}
