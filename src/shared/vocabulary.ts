export interface VocabularyEntry {
  id: string;
  word: string;
  sentence: string;
  translation?: string;
  sourceUrl: string;
  pageTitle?: string;
  sourceLanguage?: string;
  targetLanguage: string;
  createdAt: number;
  updatedAt: number;
}

export type VocabularyDraft = Omit<VocabularyEntry, 'id' | 'createdAt' | 'updatedAt'>;

const DRAFT_KEYS = new Set([
  'word', 'sentence', 'translation', 'sourceUrl', 'pageTitle', 'sourceLanguage', 'targetLanguage',
]);
const ENTRY_KEYS = new Set([...DRAFT_KEYS, 'id', 'createdAt', 'updatedAt']);
const LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const DANGEROUS_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const LATIN_CHARACTER = /\p{Script=Latin}/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

export function normalizeVocabularyWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return normalizeVocabularyWhitespace(value) || undefined;
}

function normalizeLanguage(value: string): string {
  return value.trim();
}

function isSafeLanguage(value: string): boolean {
  return value.length >= 1 && value.length <= 32 && LANGUAGE_PATTERN.test(value);
}

function validateSourceUrl(value: string): string | undefined {
  const sourceUrl = value.trim();
  if (sourceUrl.length === 0 || sourceUrl.length > 2048) return '出处 URL 长度无效';
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '出处 URL 必须使用 HTTP 或 HTTPS';
    if (url.username || url.password) return '出处 URL 不得包含用户名或密码';
  } catch {
    return '出处 URL 无效';
  }
  return undefined;
}

export function validateVocabularyDraft(value: unknown): string[] {
  if (!isRecord(value)) return ['生词草稿必须是对象'];
  const errors: string[] = [];
  if (!hasOnlyKeys(value, DRAFT_KEYS)) errors.push('生词草稿包含未允许字段');

  if (typeof value.word !== 'string') errors.push('单词必须是字符串');
  else {
    const word = normalizeVocabularyWhitespace(value.word);
    if (word.length < 1 || word.length > 120) errors.push('单词长度必须为 1 到 120 个字符');
  }

  if (typeof value.sentence !== 'string') errors.push('例句必须是字符串');
  else if (normalizeVocabularyWhitespace(value.sentence).length > 600) errors.push('例句不得超过 600 个字符');

  if (value.translation !== undefined) {
    if (typeof value.translation !== 'string') errors.push('译文必须是字符串');
    else if (normalizeVocabularyWhitespace(value.translation).length > 600) errors.push('译文不得超过 600 个字符');
  }

  if (value.pageTitle !== undefined) {
    if (typeof value.pageTitle !== 'string') errors.push('页面标题必须是字符串');
    else if (normalizeVocabularyWhitespace(value.pageTitle).length > 300) errors.push('页面标题不得超过 300 个字符');
  }

  if (typeof value.sourceUrl !== 'string') errors.push('出处 URL 必须是字符串');
  else {
    const error = validateSourceUrl(value.sourceUrl);
    if (error) errors.push(error);
  }

  if (value.sourceLanguage !== undefined && (typeof value.sourceLanguage !== 'string' || !isSafeLanguage(normalizeLanguage(value.sourceLanguage)))) errors.push('源语言无效');

  if (typeof value.targetLanguage !== 'string' || !isSafeLanguage(normalizeLanguage(value.targetLanguage))) errors.push('目标语言无效');
  return errors;
}

export function normalizeVocabularyDraft(value: unknown): VocabularyDraft {
  const errors = validateVocabularyDraft(value);
  if (errors.length) throw new Error(errors[0]);
  const draft = value as Record<string, unknown>;
  const translation = normalizeOptionalText(draft.translation);
  const pageTitle = normalizeOptionalText(draft.pageTitle);
  const sourceLanguage = normalizeOptionalText(draft.sourceLanguage);
  return {
    word: normalizeVocabularyWhitespace(draft.word as string),
    sentence: normalizeVocabularyWhitespace(draft.sentence as string),
    ...(translation ? { translation } : {}),
    sourceUrl: (draft.sourceUrl as string).trim(),
    ...(pageTitle ? { pageTitle } : {}),
    ...(sourceLanguage ? { sourceLanguage: normalizeLanguage(sourceLanguage) } : {}),
    targetLanguage: normalizeLanguage(draft.targetLanguage as string),
  };
}

function foldLatinCase(value: string): string {
  return value.replace(LATIN_CHARACTER, (character) => character.toLowerCase());
}

export function vocabularyDuplicateKey(value: Pick<VocabularyDraft, 'word' | 'sentence'>): string {
  return JSON.stringify([
    foldLatinCase(normalizeVocabularyWhitespace(value.word)),
    foldLatinCase(normalizeVocabularyWhitespace(value.sentence)),
  ]);
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 导出文件在浏览器下载目录下的相对路径；folder 为空表示直接放下载根目录。 */
export function vocabularyExportPath(folder: string, filename: string): string {
  const normalized = folder.trim().replace(/\/{2,}/gu, '/').replace(/^\/+|\/+$/gu, '');
  return normalized ? `${normalized}/${filename}` : filename;
}

export function createVocabularyId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

export function createVocabularyEntry(
  draft: VocabularyDraft,
  createId: () => string = createVocabularyId,
  now: () => number = Date.now,
): VocabularyEntry {
  const normalized = normalizeVocabularyDraft(draft);
  const timestamp = now();
  return { id: createId(), ...normalized, createdAt: timestamp, updatedAt: timestamp };
}

function draftFromEntry(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...DRAFT_KEYS].filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export function validateVocabularyEntry(value: unknown): string[] {
  if (!isRecord(value)) return ['生词条目必须是对象'];
  const errors = hasOnlyKeys(value, ENTRY_KEYS) ? [] : ['生词条目包含未允许字段'];
  errors.push(...validateVocabularyDraft(draftFromEntry(value)));
  if (typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 200 || value.id.trim() !== value.id || DANGEROUS_IDS.has(value.id)) errors.push('生词条目 ID 无效');
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) errors.push('生词创建时间无效');
  if (!Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < Number(value.createdAt)) errors.push('生词更新时间无效');
  return errors;
}

export function normalizeVocabularyEntry(value: unknown): VocabularyEntry {
  const errors = validateVocabularyEntry(value);
  if (errors.length) throw new Error(errors[0]);
  const entry = value as Record<string, unknown>;
  return {
    id: entry.id as string,
    ...normalizeVocabularyDraft(draftFromEntry(entry)),
    createdAt: entry.createdAt as number,
    updatedAt: entry.updatedAt as number,
  };
}
