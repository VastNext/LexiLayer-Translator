import {
  createVocabularyEntry,
  createVocabularyId,
  normalizeVocabularyDraft,
  normalizeVocabularyEntry,
  vocabularyDuplicateKey,
  type VocabularyEntry,
} from '../shared/vocabulary';

export const VOCABULARY_STORAGE_KEY = 'vocabularyBook';
export const VOCABULARY_SCHEMA_VERSION = 1;

export interface VocabularyBook {
  schemaVersion: 1;
  entries: VocabularyEntry[];
}

export interface VocabularyStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface VocabularyStorageOptions {
  createId?: () => string;
  now?: () => number;
}

export type VocabularyUpsertResult = {
  status: 'created' | 'duplicate';
  entry: VocabularyEntry;
};

function emptyBook(): VocabularyBook {
  return { schemaVersion: VOCABULARY_SCHEMA_VERSION, entries: [] };
}

export function parseVocabularyBook(value: unknown): VocabularyBook {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyBook();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== VOCABULARY_SCHEMA_VERSION || !Array.isArray(record.entries)) return emptyBook();
  // 单条损坏只剔除该条，避免一次坏数据让下一次写入吞掉整本有效生词。
  return {
    schemaVersion: VOCABULARY_SCHEMA_VERSION,
    entries: record.entries.flatMap((item) => {
      try { return [normalizeVocabularyEntry(item)]; } catch { return []; }
    }),
  };
}

export class VocabularyStorage {
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly storage: VocabularyStorageArea,
    options: VocabularyStorageOptions = {},
  ) {
    this.createId = options.createId ?? createVocabularyId;
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<VocabularyEntry[]> {
    try {
      const book = await this.read();
      return [...book.entries].sort((left, right) => right.createdAt - left.createdAt);
    } catch {
      return [];
    }
  }

  async upsert(value: unknown): Promise<VocabularyUpsertResult> {
    const draft = normalizeVocabularyDraft(value);
    const book = await this.read();
    const duplicateKey = vocabularyDuplicateKey(draft);
    const duplicateIndex = book.entries.findIndex((entry) => vocabularyDuplicateKey(entry) === duplicateKey);
    if (duplicateIndex >= 0) {
      const existing = book.entries[duplicateIndex];
      const entry: VocabularyEntry = {
        ...existing,
        ...(draft.translation ? { translation: draft.translation } : {}),
        ...(draft.pageTitle ? { pageTitle: draft.pageTitle } : {}),
        updatedAt: this.now(),
      };
      book.entries[duplicateIndex] = entry;
      await this.write(book);
      return { status: 'duplicate', entry };
    }

    const entry = createVocabularyEntry(draft, this.createId, this.now);
    book.entries.push(entry);
    await this.write(book);
    return { status: 'created', entry };
  }

  async delete(id: string): Promise<boolean> {
    const book = await this.read();
    const entries = book.entries.filter((entry) => entry.id !== id);
    if (entries.length === book.entries.length) return false;
    await this.write({ schemaVersion: VOCABULARY_SCHEMA_VERSION, entries });
    return true;
  }

  async clear(): Promise<void> {
    await this.write(emptyBook());
  }

  private async read(): Promise<VocabularyBook> {
    const stored = await this.storage.get(VOCABULARY_STORAGE_KEY);
    return parseVocabularyBook(stored[VOCABULARY_STORAGE_KEY]);
  }

  private async write(book: VocabularyBook): Promise<void> {
    await this.storage.set({ [VOCABULARY_STORAGE_KEY]: book });
  }
}
