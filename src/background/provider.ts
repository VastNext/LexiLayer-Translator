import type { TranslationRequest, TranslationResult } from '../shared/messages';

export interface ProviderCapabilities {
  streaming: boolean;
}

export interface ProviderCacheIdentity {
  engineId: string;
  engineFingerprint: string;
  adapterVersion: string;
}

export interface Provider {
  translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult[]>;
  streamSelection?(text: string, sourceLanguage: string, targetLanguage: string, userInstruction: string | undefined, context: string | undefined, signal?: AbortSignal): AsyncIterable<string>;
  testConnection(signal?: AbortSignal): Promise<void>;
  capabilities: ProviderCapabilities;
  cacheIdentity: ProviderCacheIdentity;
}

export interface ProviderClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
