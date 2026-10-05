import type { VocabularyEntry } from './vocabulary';

export type AnkiNoteType = 'basic' | 'cloze';

export interface AnkiPreferences {
  endpoint: string;
  deck: string;
  noteType: AnkiNoteType;
  hasApiKey: boolean;
}

export interface AnkiConnectNote {
  deckName: string;
  modelName: 'Basic' | 'Cloze';
  fields: Record<string, string>;
  options: {
    allowDuplicate: false;
    duplicateScope: 'deck';
  };
}

export const DEFAULT_ANKI_PREFERENCES: AnkiPreferences = {
  endpoint: '',
  deck: 'LexiLayer 生词本',
  noteType: 'basic',
  hasApiKey: false,
};

const PREFERENCE_KEYS = new Set(['endpoint', 'deck', 'noteType', 'hasApiKey']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LATIN_CHARACTER = /\p{Script=Latin}/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseAnkiEndpoint(value: unknown): { input: string; url: URL } {
  if (typeof value !== 'string') throw new Error('AnkiConnect 端点必须是字符串');
  const input = value.trim();
  if (!input || input.length > 2048) throw new Error('AnkiConnect 端点长度必须为 1 到 2048 个字符');
  if (input.includes('?')) throw new Error('AnkiConnect 端点不得包含查询参数');
  if (input.includes('#')) throw new Error('AnkiConnect 端点不得包含片段');

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('AnkiConnect 端点无效');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AnkiConnect 端点必须使用 HTTP 或 HTTPS');
  }
  if (url.username || url.password) throw new Error('AnkiConnect 端点不得包含用户名或密码');
  if (url.protocol === 'http:' && !isCanonicalLoopback(input, url.hostname)) {
    throw new Error('远程 AnkiConnect 端点必须使用 HTTPS');
  }
  return { input, url };
}

function isCanonicalLoopback(input: string, parsedHostname: string): boolean {
  if (!LOOPBACK_HOSTS.has(parsedHostname)) return false;
  const authorityStart = input.indexOf('://') + 3;
  const authorityEnd = input.slice(authorityStart).search(/[/?#]/u);
  const authority = input.slice(authorityStart, authorityEnd < 0 ? undefined : authorityStart + authorityEnd);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const rawHostname = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : hostPort.split(':', 1)[0];
  return rawHostname.toLowerCase() === parsedHostname;
}

export function validateAnkiEndpoint(value: unknown): string[] {
  try {
    parseAnkiEndpoint(value);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : 'AnkiConnect 端点无效'];
  }
}

export function normalizeAnkiEndpoint(value: unknown): string {
  const { url } = parseAnkiEndpoint(value);
  const pathname = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${pathname}`;
}

export function validateAnkiPreferences(value: unknown): string[] {
  if (!isRecord(value)) return ['Anki 偏好必须是对象'];
  const errors: string[] = [];
  if (Object.keys(value).some((key) => !PREFERENCE_KEYS.has(key))) errors.push('Anki 偏好包含未允许字段');

  if (typeof value.endpoint !== 'string') errors.push('AnkiConnect 端点必须是字符串');
  else if (value.endpoint.trim()) errors.push(...validateAnkiEndpoint(value.endpoint));

  if (typeof value.deck !== 'string') errors.push('Anki deck 必须是字符串');
  else {
    const deck = value.deck.trim();
    if (deck.length < 1 || deck.length > 120) errors.push('Anki deck 长度必须为 1 到 120 个字符');
  }

  if (value.noteType !== 'basic' && value.noteType !== 'cloze') errors.push('Anki 笔记类型无效');
  if (typeof value.hasApiKey !== 'boolean') errors.push('Anki API Key 状态无效');
  return errors;
}

export function normalizeAnkiPreferences(value: unknown): AnkiPreferences {
  const errors = validateAnkiPreferences(value);
  if (errors.length) throw new Error(errors[0]);
  const preferences = value as Record<string, unknown>;
  const endpoint = (preferences.endpoint as string).trim();
  return {
    endpoint: endpoint ? normalizeAnkiEndpoint(endpoint) : '',
    deck: (preferences.deck as string).trim(),
    noteType: preferences.noteType as AnkiNoteType,
    hasApiKey: preferences.hasApiKey as boolean,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function sourceLink(entry: VocabularyEntry): string {
  const label = entry.pageTitle || entry.sourceUrl;
  return `<a href="${escapeHtml(entry.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function extraHtml(entry: VocabularyEntry): string {
  return [
    entry.translation ? `<div>${escapeHtml(entry.translation)}</div>` : '',
    `<div>${sourceLink(entry)}</div>`,
  ].filter(Boolean).join('');
}

function clozeText(entry: VocabularyEntry): string {
  const flags = LATIN_CHARACTER.test(entry.word) ? 'iu' : 'u';
  const pattern = new RegExp(entry.word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), flags);
  const match = pattern.exec(entry.sentence);
  if (!match) return `{{c1::${escapeHtml(entry.word)}}}<br>${escapeHtml(entry.sentence)}`;
  return `${escapeHtml(entry.sentence.slice(0, match.index))}{{c1::${escapeHtml(match[0])}}}${escapeHtml(entry.sentence.slice(match.index + match[0].length))}`;
}

export function formatAnkiNote(entry: VocabularyEntry, preferences: AnkiPreferences): AnkiConnectNote {
  const normalized = normalizeAnkiPreferences(preferences);
  const options = { allowDuplicate: false, duplicateScope: 'deck' } as const;
  if (normalized.noteType === 'cloze') {
    return {
      deckName: normalized.deck,
      modelName: 'Cloze',
      fields: { Text: clozeText(entry), Extra: extraHtml(entry) },
      options,
    };
  }

  return {
    deckName: normalized.deck,
    modelName: 'Basic',
    fields: {
      Front: escapeHtml(entry.word),
      Back: `<div>${escapeHtml(entry.sentence)}</div>${extraHtml(entry)}`,
    },
    options,
  };
}
