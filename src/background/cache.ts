export interface CacheKeyInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  baseUrl: string;
  model: string;
  promptVersion: string;
  userInstruction: string;
}

export interface CacheEntry {
  key: string;
  value: string;
  createdAt: number;
  accessedAt: number;
}

export interface CacheStorage {
  get(key: string): Promise<CacheEntry | undefined>;
  set(entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  count(): Promise<number>;
  deleteOldest(count: number): Promise<void>;
}

export interface ClearableCacheStorage extends CacheStorage {
  clear(): Promise<void>;
}

export class IndexedDbCacheStorage implements ClearableCacheStorage {
  private readonly database: Promise<IDBDatabase>;

  constructor(databaseName = 'vast-translator-cache') {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        const store = request.result.objectStoreNames.contains('translations')
          ? request.transaction!.objectStore('translations')
          : request.result.createObjectStore('translations', { keyPath: 'key' });
        if (!store.indexNames.contains('accessedAt')) store.createIndex('accessedAt', 'accessedAt');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开翻译缓存'));
    });
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    return this.request<CacheEntry | undefined>('readonly', (store) => store.get(key));
  }

  async set(entry: CacheEntry): Promise<void> {
    await this.request('readwrite', (store) => store.put(entry));
  }

  async delete(key: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(key));
  }

  async clear(): Promise<void> {
    await this.request('readwrite', (store) => store.clear());
  }

  async count(): Promise<number> {
    return this.request<number>('readonly', (store) => store.count());
  }

  async deleteOldest(count: number): Promise<void> {
    if (count <= 0) return;
    await this.transaction('readwrite', (store) => {
      let deleted = 0;
      const cursor = store.index('accessedAt').openCursor();
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (!value || deleted >= count) return;
        value.delete();
        deleted += 1;
        value.continue();
      };
    });
  }

  private async request<T = void>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('translations', mode);
      const request = operation(transaction.objectStore('translations'));
      let result: T;
      request.onsuccess = () => { result = request.result as T; };
      request.onerror = () => reject(new Error('翻译缓存操作失败'));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(new Error('翻译缓存事务失败'));
      transaction.onerror = () => reject(new Error('翻译缓存事务失败'));
    });
  }

  private async transaction(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => void): Promise<void> {
    const database = await this.database;
    return new Promise((resolve, reject) => {
      try {
        const transaction = database.transaction('translations', mode);
        operation(transaction.objectStore('translations'));
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error('翻译缓存事务失败'));
        transaction.onerror = () => reject(new Error('翻译缓存事务失败'));
      } catch {
        reject(new Error('翻译缓存事务失败'));
      }
    });
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().replace(/[ \t]+/g, ' ');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export async function createCacheKey(input: CacheKeyInput): Promise<string> {
  const value = JSON.stringify([
    normalizeText(input.text),
    input.sourceLanguage,
    input.targetLanguage,
    normalizeBaseUrl(input.baseUrl),
    input.model,
    input.promptVersion,
    normalizeText(input.userInstruction),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class TranslationCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly storage: CacheStorage, options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 5000;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    const entry = await this.storage.get(key);
    if (!entry) return undefined;

    const now = this.now();
    if (now - entry.createdAt > this.ttlMs) {
      await this.storage.delete(key);
      return undefined;
    }

    await this.storage.set({ ...entry, accessedAt: now });
    return entry.value;
  }

  async set(key: string, value: string): Promise<void> {
    const now = this.now();
    await this.storage.set({ key, value, createdAt: now, accessedAt: now });

    const excess = await this.storage.count() - this.maxEntries;
    if (excess <= 0) return;
    await this.storage.deleteOldest(excess);
  }

}
