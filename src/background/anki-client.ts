import {
  formatAnkiNote,
  normalizeAnkiEndpoint,
  normalizeAnkiPreferences,
  type AnkiConnectNote,
  type AnkiPreferences,
} from '../shared/anki';
import type { VocabularyEntry } from '../shared/vocabulary';

export type AnkiClientErrorCode = 'network' | 'timeout' | 'http' | 'cors' | 'auth' | 'protocol';

export class AnkiClientError extends Error {
  readonly name = 'AnkiClientError';

  constructor(
    public readonly code: AnkiClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AnkiClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface AnkiSyncResult {
  added: number;
  skipped: number;
  failed: number;
}

type AnkiAction = 'version' | 'deckNames' | 'createDeck' | 'addNotes';

interface AnkiEnvelope {
  result: unknown;
  error: unknown;
}

const PROTOCOL_VERSION = 6;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_NOTES_PER_BATCH = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError(): AnkiClientError {
  return new AnkiClientError('protocol', 'AnkiConnect 响应格式无效');
}

function isCorsError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'SecurityError') return true;
  return error instanceof Error && /\bcors\b|cross[- ]origin|\borigin\b/iu.test(error.message);
}

function classifyActionError(error: string): AnkiClientError {
  if (/auth(?:entication|orization)?|unauthori[sz]ed|forbidden|api[ _-]?key|valid key|key .{0,20}(?:provided|required|invalid)/iu.test(error)) {
    return new AnkiClientError('auth', 'AnkiConnect 认证失败，请检查 API Key');
  }
  return new AnkiClientError('protocol', 'AnkiConnect 操作失败');
}

export class AnkiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: AnkiClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async testConnection(endpoint: string, key?: string, signal?: AbortSignal): Promise<{ version: number }> {
    const normalizedEndpoint = normalizeAnkiEndpoint(endpoint);
    const version = await this.version(normalizedEndpoint, key, signal);
    return { version };
  }

  async sync(
    entries: VocabularyEntry[],
    preferences: AnkiPreferences,
    key?: string,
    signal?: AbortSignal,
  ): Promise<AnkiSyncResult> {
    const normalized = normalizeAnkiPreferences(preferences);
    const endpoint = normalizeAnkiEndpoint(normalized.endpoint);
    await this.version(endpoint, key, signal);

    const deckNames = await this.deckNames(endpoint, key, signal);
    if (!deckNames.includes(normalized.deck)) await this.createDeck(endpoint, normalized.deck, key, signal);

    const notes = entries.map((entry) => formatAnkiNote(entry, normalized));
    const result: AnkiSyncResult = { added: 0, skipped: 0, failed: 0 };
    for (let start = 0; start < notes.length; start += MAX_NOTES_PER_BATCH) {
      const batch = notes.slice(start, start + MAX_NOTES_PER_BATCH);
      const addedIds = await this.addNotes(endpoint, batch, key, signal);
      for (const addedId of addedIds) {
        if (addedId === null) result.skipped += 1;
        else result.added += 1;
      }
    }
    return result;
  }

  private async version(endpoint: string, key?: string, signal?: AbortSignal): Promise<number> {
    const result = await this.request(endpoint, 'version', undefined, key, signal);
    if (!Number.isInteger(result) || Number(result) < PROTOCOL_VERSION) throw protocolError();
    return result as number;
  }

  private async deckNames(endpoint: string, key?: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.request(endpoint, 'deckNames', undefined, key, signal);
    if (!Array.isArray(result) || !result.every((deck) => typeof deck === 'string')) throw protocolError();
    return result;
  }

  private async createDeck(endpoint: string, deck: string, key?: string, signal?: AbortSignal): Promise<void> {
    const result = await this.request(endpoint, 'createDeck', { deck }, key, signal);
    if (typeof result !== 'number' || !Number.isFinite(result)) throw protocolError();
  }

  private async addNotes(
    endpoint: string,
    notes: AnkiConnectNote[],
    key?: string,
    signal?: AbortSignal,
  ): Promise<Array<number | null>> {
    const result = await this.request(endpoint, 'addNotes', { notes }, key, signal);
    if (!Array.isArray(result) || result.length !== notes.length || !result.every((item) => (
      item === null || (typeof item === 'number' && Number.isFinite(item))
    ))) throw protocolError();
    return result as Array<number | null>;
  }

  private async request(
    endpoint: string,
    action: AnkiAction,
    params?: Record<string, unknown>,
    key?: string,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const url = normalizeAnkiEndpoint(endpoint);
    const controller = new AbortController();
    let timedOut = false;
    const abortFromOutside = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromOutside, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const trimmedKey = typeof key === 'string' ? key.trim() : '';
    const body: Record<string, unknown> = { action, version: PROTOCOL_VERSION };
    if (params !== undefined) body.params = params;
    if (trimmedKey) body.key = trimmedKey;

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AnkiClientError('auth', 'AnkiConnect 认证失败，请检查 API Key');
        }
        throw new AnkiClientError('http', `AnkiConnect 服务返回 HTTP ${response.status}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw protocolError();
      }

      if (!isRecord(payload)
        || !Object.hasOwn(payload, 'result')
        || !Object.hasOwn(payload, 'error')) throw protocolError();
      const envelope = payload as unknown as AnkiEnvelope;
      if (envelope.error !== null) {
        if (typeof envelope.error !== 'string' || !envelope.error) throw protocolError();
        throw classifyActionError(envelope.error);
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof AnkiClientError) throw error;
      if (timedOut) throw new AnkiClientError('timeout', `AnkiConnect 请求超时（${this.timeoutMs}ms）`);
      if (externalSignal?.aborted) throw new AnkiClientError('network', 'AnkiConnect 请求已取消');
      if (isCorsError(error)) {
        throw new AnkiClientError('cors', 'AnkiConnect 拒绝了扩展 Origin，请检查 webCorsOriginList');
      }
      throw new AnkiClientError('network', '无法连接 AnkiConnect 服务');
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromOutside);
    }
  }
}
