import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { IndexedDbCacheStorage } from '../../src/background/cache';

describe('IndexedDB 持久缓存适配', () => {
  it('跨适配器实例持久读写、删除和清空', async () => {
    const name = 'vast-translator-persistence';
    const first = new IndexedDbCacheStorage(name);
    await first.set({ key: 'a', value: '译文', createdAt: 1, accessedAt: 2 });

    const second = new IndexedDbCacheStorage(name);
    await expect(second.get('a')).resolves.toEqual({ key: 'a', value: '译文', createdAt: 1, accessedAt: 2 });
    await expect(second.count()).resolves.toBe(1);
    await second.delete('a');
    await expect(second.get('a')).resolves.toBeUndefined();
    await second.set({ key: 'b', value: '值', createdAt: 3, accessedAt: 3 });
    await second.clear();
    await expect(second.count()).resolves.toBe(0);
  });

  it('支持 count 和按 accessedAt 索引淘汰最旧项', async () => {
    const storage = new IndexedDbCacheStorage('vast-translator-index');
    await storage.set({ key: 'old', value: '旧', createdAt: 1, accessedAt: 1 });
    await storage.set({ key: 'new', value: '新', createdAt: 2, accessedAt: 2 });
    await expect(storage.count()).resolves.toBe(2);
    await storage.deleteOldest(1);
    await expect(storage.get('old')).resolves.toBeUndefined();
    await expect(storage.get('new')).resolves.toBeDefined();
  });

  it('事务 abort 时写入 Promise reject 且数据不落盘', async () => {
    const storage = new IndexedDbCacheStorage('vast-translator-abort');
    const request = {} as IDBRequest;
    const transaction = {
      objectStore: () => ({ put: () => request }),
    } as unknown as IDBTransaction;
    const database = { transaction: () => transaction } as unknown as IDBDatabase;
    (storage as unknown as { database: Promise<IDBDatabase> }).database = Promise.resolve(database);
    const pending = storage.set({ key: 'x', value: 'x', createdAt: 1, accessedAt: 1 });
    await Promise.resolve();
    request.onsuccess?.(new Event('success'));
    transaction.onabort?.(new Event('abort'));
    await expect(pending).rejects.toThrow('翻译缓存事务失败');
  });
});
