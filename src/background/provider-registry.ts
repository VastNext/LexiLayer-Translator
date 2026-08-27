import { validateEngine, type Engine } from '../shared/config';
import type { TranslationRequest } from '../shared/messages';
import { BingTranslateClient } from './bing-translate-client';
import { CustomAiAdapter } from './custom-ai-adapter';
import { GoogleTranslateClient } from './google-translate-client';
import type { Provider, ProviderClientOptions } from './provider';

export function createProvider(engine: Engine, options: ProviderClientOptions = {}): Provider {
  const errors = validateEngine(engine);
  if (errors.length) throw new Error(errors[0]);
  if (engine.kind === 'google') return new GoogleTranslateClient(options);
  if (engine.kind === 'bing') return new BingTranslateClient(options);
  if (!engine.baseUrl.trim() || !engine.model.trim() || !engine.apiKey.trim()) throw new Error('自定义 AI 配置不完整');
  return new CustomAiAdapter(engine, options);
}

export async function* streamProviderSelection(
  provider: Provider,
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
  userInstruction: string | undefined,
  context: string | undefined,
  signal?: AbortSignal,
): AsyncIterable<string> {
  if (provider.streamSelection) {
    yield* provider.streamSelection(text, sourceLanguage, targetLanguage, userInstruction, context, signal);
    return;
  }
  const request: TranslationRequest = {
    sourceLanguage,
    targetLanguage,
    segments: [{ id: 'selection', text }],
  };
  const [result] = await provider.translate(request, signal);
  if (!result) throw new Error('翻译响应格式无效');
  yield result.text;
}
