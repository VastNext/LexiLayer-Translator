import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../shared/i18n';
import { createSpeechController } from '../shared/speech';
import { validateAnkiEndpoint } from '../shared/anki';
import type { VocabularyEntry } from '../shared/vocabulary';
import type { AnkiCandidateInput, AnkiNoteTypeInput, AnkiSyncResult, VocabularyPreferencesInput } from './api';

export interface VocabularyApi {
  getVocabularyEntries(): Promise<VocabularyEntry[]>;
  deleteVocabularyEntry(id: string): Promise<boolean>;
  clearVocabulary(): Promise<void>;
  saveVocabularyPreferences(preferences: VocabularyPreferencesInput): Promise<void>;
  getAnkiApiKey(): Promise<string>;
  clearAnkiApiKey(): Promise<void>;
  testAnkiConnection(candidate: AnkiCandidateInput): Promise<unknown>;
  syncVocabularyAnki(): Promise<AnkiSyncResult>;
}

/** get-options-settings 返回的 vocabulary 安全视图（不含真实 Key）。 */
export interface VocabularySettingsView {
  ankiEndpoint: string;
  ankiDeck: string;
  ankiNoteType: AnkiNoteTypeInput;
  hasAnkiApiKey: boolean;
}

export type DownloadFile = (filename: string, content: string, mimeType: string) => void;

export interface VocabularySectionProps {
  api: VocabularyApi;
  t: Translator;
  vocabulary?: VocabularySettingsView;
  onStatus?: (message: string) => void;
  downloadFile?: DownloadFile;
}

interface VocabularyAnkiState {
  endpoint: string;
  deck: string;
  noteType: AnkiNoteTypeInput;
}

const DEFAULT_ANKI_VIEW: VocabularySettingsView = { ankiEndpoint: '', ankiDeck: 'LexiLayer 生词本', ankiNoteType: 'basic', hasAnkiApiKey: false };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SENTENCE_EXCERPT_LENGTH = 80;

function isRemoteEndpoint(endpoint: string): boolean {
  try {
    return !LOOPBACK_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function sentenceExcerpt(sentence: string): string {
  return sentence.length > SENTENCE_EXCERPT_LENGTH ? `${sentence.slice(0, SENTENCE_EXCERPT_LENGTH - 1)}…` : sentence;
}

function csvField(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function tsvField(value: string): string {
  return value.replaceAll('\t', ' ').replaceAll(/\r?\n/gu, ' ');
}

function downloadViaBlob(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function sourceLabel(entry: VocabularyEntry): string {
  return entry.pageTitle || entry.sourceUrl;
}

const CSV_COLUMNS = ['word', 'sentence', 'translation', 'sourceUrl', 'pageTitle'] as const;

function vocabularyRow(entry: VocabularyEntry, separator: 'csv' | 'tsv'): string {
  const fields = [
    entry.word,
    entry.sentence,
    entry.translation ?? '',
    entry.sourceUrl,
    entry.pageTitle ?? '',
  ];
  return separator === 'csv'
    ? fields.map(csvField).join(',')
    : fields.map(tsvField).join('\t');
}

export function VocabularySection({ api, t, vocabulary, onStatus, downloadFile }: VocabularySectionProps) {
  const [entries, setEntries] = useState<VocabularyEntry[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [jsonExportChoice, setJsonExportChoice] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const savedView = vocabulary ?? DEFAULT_ANKI_VIEW;
  const [anki, setAnki] = useState<VocabularyAnkiState>(() => ({
    endpoint: savedView.ankiEndpoint, deck: savedView.ankiDeck, noteType: savedView.ankiNoteType,
  }));
  const [savedKey, setSavedKey] = useState('');
  const [ankiKey, setAnkiKey] = useState('');
  const [showAnkiKey, setShowAnkiKey] = useState(false);
  const [remoteConfirmed, setRemoteConfirmed] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  const [syncConfirm, setSyncConfirm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<AnkiSyncResult>();
  const speech = useRef(createSpeechController());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, key] = await Promise.all([api.getVocabularyEntries(), api.getAnkiApiKey()]);
        if (cancelled) return;
        setEntries(list);
        setSavedKey(key);
        setAnkiKey(key);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // 配置异步加载完成后同步 Anki 表单，避免用挂载时的默认值覆盖真实配置。
  useEffect(() => {
    const view = vocabulary ?? DEFAULT_ANKI_VIEW;
    setAnki({ endpoint: view.ankiEndpoint, deck: view.ankiDeck, noteType: view.ankiNoteType });
  }, [vocabulary]);

  const endpoint = anki.endpoint.trim();
  const endpointErrors = endpoint ? validateAnkiEndpoint(endpoint) : [];
  const endpointReady = Boolean(endpoint) && endpointErrors.length === 0;
  const hasAnkiKey = Boolean(savedKey) || Boolean(ankiKey.trim());
  const remoteWithoutKey = endpointReady && isRemoteEndpoint(endpoint) && !hasAnkiKey;
  const canSaveAnki = endpointErrors.length === 0 && (!remoteWithoutKey || remoteConfirmed);
  const query = search.trim().toLowerCase();
  const filteredEntries = query
    ? entries.filter((entry) => entry.word.toLowerCase().includes(query) || entry.sentence.toLowerCase().includes(query))
    : entries;
  const reviewEntry = entries.length ? entries[Math.min(reviewIndex, entries.length - 1)] : undefined;
  const syncTarget = (() => {
    try { return new URL(endpoint).origin; } catch { return endpoint; }
  })();
  const candidateKey = ankiKey.trim() || savedKey;
  const download = downloadFile ?? downloadViaBlob;

  function speak(text: string): void {
    speech.current.speak(text);
  }

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      onStatus?.(error instanceof Error ? error.message : fallback);
    }
  }

  async function removeEntry(id: string): Promise<void> {
    setConfirmDeleteId(undefined);
    await run(async () => {
      await api.deleteVocabularyEntry(id);
      setEntries((current) => current.filter((entry) => entry.id !== id));
      onStatus?.(t('vocabularyStatusDeleted'));
    }, t('statusSaveFailed'));
  }

  async function clearAll(): Promise<void> {
    setConfirmClear(false);
    await run(async () => {
      await api.clearVocabulary();
      setEntries([]);
      setReviewing(false);
      onStatus?.(t('vocabularyStatusCleared'));
    }, t('statusSaveFailed'));
  }

  function exportJson(): void {
    download('lexilayer-vocabulary.json', JSON.stringify(entries, null, 2), 'application/json');
    setJsonExportChoice(false);
  }

  function exportDelimited(format: 'csv' | 'tsv'): void {
    const header = CSV_COLUMNS.join(format === 'csv' ? ',' : '\t');
    const content = [header, ...entries.map((entry) => vocabularyRow(entry, format))].join('\n') + '\n';
    download(
      `lexilayer-vocabulary.${format}`,
      content,
      format === 'csv' ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8',
    );
  }

  async function saveAnki(): Promise<void> {
    if (endpointErrors.length) return onStatus?.(endpointErrors.join('；'));
    const apiKey = ankiKey.trim();
    await run(async () => {
      await api.saveVocabularyPreferences({
        endpoint, deck: anki.deck.trim(), noteType: anki.noteType, ...(apiKey ? { apiKey } : {}),
      });
      const stored = await api.getAnkiApiKey();
      setSavedKey(stored);
      setAnkiKey(stored);
      setRemoteConfirmed(false);
      onStatus?.(t('ankiStatusSaved'));
    }, t('statusSaveFailed'));
  }

  async function testAnki(): Promise<void> {
    if (endpointErrors.length) return onStatus?.(endpointErrors.join('；'));
    onStatus?.(t('statusConnectionTesting'));
    try {
      await api.testAnkiConnection({ endpoint, ...(candidateKey ? { apiKey: candidateKey } : {}) });
      onStatus?.(t('statusConnectionSuccess'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('statusConnectionFailed');
      const code = (error as { code?: string }).code;
      onStatus?.(code ? t('ankiTestCodeHint', [message, String(code)]) : message);
    }
  }

  async function clearAnkiKey(): Promise<void> {
    setConfirmClearKey(false);
    await run(async () => {
      await api.clearAnkiApiKey();
      setSavedKey('');
      setAnkiKey('');
      onStatus?.(t('statusKeyCleared'));
    }, t('statusSaveFailed'));
  }

  async function runSync(): Promise<void> {
    setSyncConfirm(false);
    setSyncing(true);
    await run(async () => {
      setSyncResult(await api.syncVocabularyAnki());
    }, t('statusSaveFailed'));
    setSyncing(false);
  }

  function startReview(): void {
    setReviewIndex(0);
    setReviewOpen(false);
    setReviewing(true);
  }

  return <section id="vocabulary-book" className="section" aria-label={t('vocabularyBook')}>
    <div className="section-header"><div><h2>{t('vocabularyBook')}</h2><p className="section-copy">{t('vocabularyBookDescription')}</p></div><span className="section-index">VOCAB</span></div>
    {loadFailed && <p className="note">{t('vocabularyLoadFailed')}</p>}
    {reviewing && reviewEntry ? <div role="group" aria-label={t('vocabularyReviewMode')} className="vocabulary-review">
      <p className="vocabulary-review-progress">{t('vocabularyReviewProgress', [String(Math.min(reviewIndex, entries.length - 1) + 1), String(entries.length)])}</p>
      <p className="vocabulary-review-word">{reviewEntry.word}</p>
      {reviewOpen ? <div className="vocabulary-review-detail">
        <p>{reviewEntry.sentence}</p>
        {reviewEntry.translation && <p>{reviewEntry.translation}</p>}
        <p><a href={reviewEntry.sourceUrl} target="_blank" rel="noopener noreferrer">{sourceLabel(reviewEntry)}</a></p>
        <div className="actions">
          <button type="button" className="secondary options-action" aria-label={`${t('vocabularySpeakWord')} ${reviewEntry.word}`} onClick={() => speak(reviewEntry.word)}>{t('vocabularySpeakWord')}</button>
          <button type="button" className="secondary options-action" onClick={() => setReviewOpen(false)}>{t('vocabularyReviewHideSentence')}</button>
        </div>
      </div> : <div className="actions"><button type="button" className="primary options-action" onClick={() => setReviewOpen(true)}>{t('vocabularyReviewShowSentence')}</button></div>}
      <div className="actions">
        <button type="button" className="secondary options-action" disabled={reviewIndex <= 0} onClick={() => { setReviewIndex((index) => Math.max(0, index - 1)); setReviewOpen(false); }}>{t('vocabularyReviewPrev')}</button>
        <button type="button" className="secondary options-action" disabled={reviewIndex >= entries.length - 1} onClick={() => { setReviewIndex((index) => Math.min(entries.length - 1, index + 1)); setReviewOpen(false); }}>{t('vocabularyReviewNext')}</button>
        <button type="button" className="secondary options-action" onClick={() => setReviewing(false)}>{t('vocabularyReviewExit')}</button>
      </div>
    </div> : <div>
      <div className="actions vocabulary-toolbar">
        <label className="field">{t('vocabularySearch')}<input aria-label={t('vocabularySearch')} type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <span className="badge">{t('vocabularyEntryCount', String(entries.length))}</span>
        <button type="button" className="primary options-action" disabled={!entries.length} onClick={startReview}>{t('vocabularyReview')}</button>
        {!jsonExportChoice ? <button type="button" className="secondary options-action" disabled={!entries.length} onClick={() => setJsonExportChoice(true)}>{t('vocabularyExportJson')}</button>
          : <span className="export-choice"><span className="help">{t('vocabularyExportConfirm')}</span><button type="button" className="primary options-action" onClick={exportJson}>{t('vocabularyExportConfirmAction')}</button><button type="button" className="secondary options-action" onClick={() => setJsonExportChoice(false)}>{t('vocabularyExportCancel')}</button></span>}
        <button type="button" className="secondary options-action" disabled={!entries.length} onClick={() => exportDelimited('csv')}>{t('vocabularyExportCsv')}</button>
        <button type="button" className="secondary options-action" disabled={!entries.length} onClick={() => exportDelimited('tsv')}>{t('vocabularyExportTsv')}</button>
        {!confirmClear ? <button type="button" className="danger options-action" disabled={!entries.length} onClick={() => setConfirmClear(true)}>{t('vocabularyClear')}</button>
          : <><span className="help">{t('vocabularyConfirmClear')}</span><button type="button" className="danger options-action" onClick={() => void clearAll()}>{t('vocabularyConfirmClearAction')}</button></>}
      </div>
      {entries.length === 0 ? <p className="note">{t('vocabularyEmpty')}</p>
        : filteredEntries.length === 0 ? <p className="note">{t('vocabularySearchEmpty')}</p>
          : <div className="vocabulary-list">{filteredEntries.map((entry) => <article className="vocabulary-item" aria-label={entry.word} key={entry.id}>
            <div className="vocabulary-item-main">
              <h3>{entry.word}</h3>
              <p className="vocabulary-sentence" title={entry.sentence}>{sentenceExcerpt(entry.sentence)}</p>
            </div>
            <div className="vocabulary-item-meta">
              <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{sourceLabel(entry)}</a>
              <span className="vocabulary-date">{formatDate(entry.createdAt)}</span>
              <div className="actions vocabulary-item-actions">
                <button type="button" className="secondary options-action" aria-label={`${t('vocabularySpeakWord')} ${entry.word}`} onClick={() => speak(entry.word)}>{t('vocabularySpeakWord')}</button>
                {confirmDeleteId === entry.id ? <><span className="help">{t('vocabularyConfirmDelete')}</span><button type="button" className="danger options-action" onClick={() => void removeEntry(entry.id)}>{t('vocabularyConfirmDeleteAction')}</button></>
                  : <button type="button" className="danger options-action" onClick={() => setConfirmDeleteId(entry.id)}>{t('vocabularyDelete')}</button>}
              </div>
            </div>
          </article>)}</div>}
    </div>}

    <section aria-label={t('ankiSettings')} className="shortcut-card vocabulary-anki">
      <h3>{t('ankiSettings')}</h3>
      <div className="grid">
        <label className="field field--wide">{t('ankiEndpointLabel')}
          <input aria-label={t('ankiEndpointLabel')} value={anki.endpoint} placeholder="http://127.0.0.1:8765" onChange={(event) => setAnki((current) => ({ ...current, endpoint: event.target.value }))} />
          <small>{endpointErrors.length ? endpointErrors.join('；') : t('ankiEndpointHelp')}</small>
        </label>
        <label className="field">{t('ankiDeckLabel')}<input aria-label={t('ankiDeckLabel')} value={anki.deck} onChange={(event) => setAnki((current) => ({ ...current, deck: event.target.value }))} /></label>
        <label className="field">{t('ankiNoteTypeLabel')}
          <select aria-label={t('ankiNoteTypeLabel')} value={anki.noteType} onChange={(event) => setAnki((current) => ({ ...current, noteType: event.target.value as AnkiNoteTypeInput }))}>
            <option value="basic">{t('ankiNoteTypeBasic')}</option>
            <option value="cloze">{t('ankiNoteTypeCloze')}</option>
          </select>
        </label>
        <label className="field field--wide">{t('ankiApiKeyLabel')}
          <span className="input-wrapper">
            <input aria-label={t('ankiApiKeyLabel')} type={showAnkiKey ? 'text' : 'password'} autoComplete="off" value={ankiKey} onChange={(event) => setAnkiKey(event.target.value)} />
            <button type="button" className="input-icon-button" aria-label={showAnkiKey ? t('hideApiKey') : t('showApiKey')} onClick={() => setShowAnkiKey((current) => !current)}>{showAnkiKey ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 5.1 9 8a8.7 8.7 0 0 1-2.1 3.8M6.2 6.2C4.2 7.6 3 10 3 12c0 2.9 3.5 8 9 8 1.2 0 2.3-.2 3.2-.6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12c0-2.9 3.5-8 9-8s9 5.1 9 8-3.5 8-9 8-9-5.1-9-8Z" /><circle cx="12" cy="12" r="3" /></svg>}</button>
          </span>
          <small>{t('ankiApiKeyHelp')}</small>
        </label>
      </div>
      {remoteWithoutKey && <div className="note" role="note">
        <p>{t('ankiRemoteWarning')}</p>
        <label className="field check-field"><input type="checkbox" aria-label={t('ankiRemoteConfirm')} checked={remoteConfirmed} onChange={(event) => setRemoteConfirmed(event.target.checked)} /> {t('ankiRemoteConfirm')}</label>
      </div>}
      <div className="actions">
        <button type="button" className="primary options-action" disabled={!canSaveAnki} onClick={() => void saveAnki()}>{t('ankiSave')}</button>
        <button type="button" className="secondary options-action" disabled={!endpointReady} onClick={() => void testAnki()}>{t('actionTestConnection')}</button>
        {!syncConfirm ? <button type="button" className="secondary options-action" disabled={!endpointReady || !entries.length || syncing} onClick={() => setSyncConfirm(true)}>{t('ankiSync')}</button>
          : <span className="export-choice"><span className="help">{t('ankiSyncConfirm', [String(entries.length), syncTarget])}</span><button type="button" className="primary options-action" disabled={syncing} onClick={() => void runSync()}>{t('ankiSyncConfirmAction')}</button><button type="button" className="secondary options-action" disabled={syncing} onClick={() => setSyncConfirm(false)}>{t('ankiSyncCancel')}</button></span>}
        {savedKey && (!confirmClearKey ? <button type="button" className="danger options-action" onClick={() => setConfirmClearKey(true)}>{t('actionClearApiKey')}</button>
          : <><span className="help">{t('confirmClearKey')}</span><button type="button" className="danger options-action" onClick={() => void clearAnkiKey()}>{t('actionConfirmClearKey')}</button></>)}
        {syncing && <span className="help">{t('ankiSyncStatusSyncing')}</span>}
      </div>
      {syncResult && <p className="note" aria-live="polite">{t('ankiSyncResult', [String(syncResult.added), String(syncResult.skipped), String(syncResult.failed)])}</p>}
    </section>
  </section>;
}
