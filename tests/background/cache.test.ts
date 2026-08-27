import { describe, expect, it, vi } from 'vitest';

import { TranslationCache, createCacheKey, type CacheEntry, type CacheStorage } from '../../src/background/cache';

class MemoryStorage implements CacheStorage {
  readonly entries = new Map<string, CacheEntry>();

  async get(key: string) { return this.entries.get(key); }
  async set(entry: CacheEntry) { this.entries.set(entry.key, entry); }
  async delete(key: string) { this.entries.delete(key); }
  async count() { return this.entries.size; }
  async deleteOldest(count: number) {
    const oldest = [...this.entries.values()].sort((a, b) => a.accessedAt - b.accessedAt).slice(0, count);
    oldest.forEach((entry) => this.entries.delete(entry.key));
  }
}

const keyInput = {
  text: '  Hello\r\n   world  ',
  sourceLanguage: 'en',
  targetLanguage: 'zh-Hans',
  engineId: 'custom-work',
  engineFingerprint: 'custom-ai:https://api.example.com:gpt-test',
  adapterVersion: 'custom-ai-v1',
  promptVersion: 'v1',
  effectiveInstruction: '保持术语',
};

describe('createCacheKey', () => {
  it('对等价文本生成稳定键', async () => {
    const first = await createCacheKey(keyInput);
    const second = await createCacheKey({
      ...keyInput,
      text: 'Hello\n world',
    });

    expect(first).toBe(second);
  });

  it('提示词版本变化时隔离缓存', async () => {
    expect(await createCacheKey(keyInput)).not.toBe(await createCacheKey({ ...keyInput, promptVersion: 'v2' }));
  });

  it('划词有限上下文变化时隔离缓存', async () => {
    const first = await createCacheKey({ ...keyInput, effectiveInstruction: '以下邻近文本仅用于消歧，不要翻译或输出：first context' });
    const second = await createCacheKey({ ...keyInput, effectiveInstruction: '以下邻近文本仅用于消歧，不要翻译或输出：second context' });
    expect(first).not.toBe(second);
  });

  it('隔离 Google、Bing 和多个自定义实例', async () => {
    const google = await createCacheKey({ ...keyInput, engineId: 'google', engineFingerprint: 'google' });
    const bing = await createCacheKey({ ...keyInput, engineId: 'bing', engineFingerprint: 'bing' });
    const customOther = await createCacheKey({ ...keyInput, engineId: 'custom-other' });
    expect(new Set([google, bing, customOther]).size).toBe(3);
  });

  it('API Key 变化不影响缓存键', async () => {
    const first = await createCacheKey({ ...keyInput, apiKey: 'first-secret' } as typeof keyInput);
    const second = await createCacheKey({ ...keyInput, apiKey: 'second-secret' } as typeof keyInput);
    expect(first).toBe(second);
  });
});

describe('TranslationCache', () => {
  it('超过 TTL 后删除并视为未命中', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, { ttlMs: 1000, maxEntries: 5, now: () => 2000 });
    storage.entries.set('key', { key: 'key', value: '旧译文', createdAt: 999, accessedAt: 999 });

    await expect(cache.get('key')).resolves.toBeUndefined();
    expect(storage.entries.has('key')).toBe(false);
  });

  it('读取命中项时更新访问时间', async () => {
    const storage = new MemoryStorage();
    const cache = new TranslationCache(storage, { ttlMs: 1000, maxEntries: 5, now: () => 1500 });
    storage.entries.set('key', { key: 'key', value: '译文', createdAt: 1000, accessedAt: 1000 });

    await expect(cache.get('key')).resolves.toBe('译文');
    expect(storage.entries.get('key')?.accessedAt).toBe(1500);
  });

  it('超过容量时淘汰最久未访问项', async () => {
    const storage = new MemoryStorage();
    storage.entries.set('old', { key: 'old', value: '旧', createdAt: 1, accessedAt: 1 });
    storage.entries.set('recent', { key: 'recent', value: '新', createdAt: 2, accessedAt: 2 });
    const cache = new TranslationCache(storage, { ttlMs: 1000, maxEntries: 2, now: () => 3 });

    await cache.set('latest', '最新');

    expect([...storage.entries.keys()].sort()).toEqual(['latest', 'recent']);
  });

  it('正常 set 只读取 count，超限才调用索引式 deleteOldest', async () => {
    const storage = new MemoryStorage();
    const count = vi.spyOn(storage, 'count');
    const deleteOldest = vi.spyOn(storage, 'deleteOldest');
    const cache = new TranslationCache(storage, { maxEntries: 2, now: () => 3 });
    await cache.set('one', '1');
    await cache.set('two', '2');
    expect(count).toHaveBeenCalledTimes(2);
    expect(deleteOldest).not.toHaveBeenCalled();
    await cache.set('three', '3');
    expect(deleteOldest).toHaveBeenCalledWith(1);
  });

});
