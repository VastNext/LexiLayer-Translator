import { useEffect, useState } from 'react';
import { BrandMark } from '../BrandMark';
import { languageOptions } from '../shared/languages';
import { createTranslator, type Translator } from '../shared/i18n';

export interface PopupApi {
  getConfig(): Promise<{ targetLanguage: string; displayMode: string }>;
  sendToPage(message: unknown): Promise<unknown>;
  openOptions(): void;
  getProgress(): Promise<{ status: string; completed: number; failed: number; total: number } | undefined>;
  subscribeProgress(listener: (progress: { status: string; completed: number; failed: number; total: number }) => void): (() => void) | Promise<() => void>;
}

export function PopupApp({ api, t = createTranslator() }: { api: PopupApi; t?: Translator }) {
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [scope, setScope] = useState('main-content');
  const [mode, setMode] = useState('bilingual');
  const [status, setStatus] = useState(t('ready'));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void api.getConfig().then((config) => {
      if (disposed) return;
      setTargetLanguage(config.targetLanguage);
      setMode(config.displayMode === 'translation' ? 'translation-only' : config.displayMode);
    });
    void api.getProgress().then((progress) => { if (!disposed && progress) setStatus(formatProgress(progress)); });
    void Promise.resolve(api.subscribeProgress((progress) => setStatus(formatProgress(progress))))
      .then((cleanup) => { if (disposed) cleanup(); else unsubscribe = cleanup; });
    return () => { disposed = true; unsubscribe?.(); };
  }, [api]);

  function formatProgress(progress: { status: string; completed: number; failed: number; total: number }): string {
    if (progress.status === 'partial') return t('statusPartial', [String(progress.completed), String(progress.total), String(progress.failed)]);
    if (progress.status === 'translating') return t('statusProgress', [String(progress.completed), String(progress.total)]);
    if (progress.status === 'error') return t('statusError', [String(progress.failed), String(progress.total)]);
    if (progress.status === 'complete') return t('statusComplete', [String(progress.completed), String(progress.total)]);
    return t('ready');
  }

  async function translate(): Promise<void> {
    setStatus(t('statusTranslating'));
    setBusy(true);
    try {
      await api.sendToPage({ type: 'translate-page', scope, mode, targetLanguage });
      let progress = await api.getProgress();
      for (let attempt = 0; progress?.status === 'translating' && attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        progress = await api.getProgress();
      }
      setStatus((current) => progress ? formatProgress(progress) : current === t('statusTranslating') ? t('statusStarted') : current);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('statusFailed'));
    } finally {
      setBusy(false);
    }
  }

  const state = busy ? 'loading' : /失败|错误/.test(status) ? 'error' : 'ready';
  return <main className="shell popup">
    <header className="masthead">
      <div className="brand-lockup"><BrandMark /><div><h1>Vast Translator</h1><p className="kicker">{t('popupKicker')}</p></div></div>
      <span className="version">v0.1</span>
    </header>
    <section className="panel panel--marked" aria-labelledby="page-settings"><div className="section-header"><h2 id="page-settings">{t('popupCurrentPage')}</h2><span className="section-index">01 / READ</span></div>
    <div className="grid">
      <label className="field">{t('targetLanguage')}<select aria-label={t('targetLanguage')} value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
        {languageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select></label>
      <label className="field">{t('translationScope')}<select aria-label={t('translationScope')} value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="main-content">{t('mainContent')}</option><option value="whole-page">{t('wholePage')}</option>
      </select></label>
      <label className="field">{t('displayMode')}<select aria-label={t('displayMode')} value={mode} onChange={(event) => setMode(event.target.value)}>
        <option value="bilingual">{t('bilingual')}</option><option value="translation-only">{t('translationOnly')}</option>
      </select></label>
    </div>
    <p className="status" role="status" data-state={state}>{status}</p>
    <div className="actions actions--primary">
      <button className="primary" disabled={busy} aria-busy={busy} onClick={() => void translate()}>{busy ? t('statusTranslating') : t('actionTranslatePage')}</button>
      <button className="secondary" disabled={busy} onClick={() => void api.sendToPage({ type: 'restore-page' })}>{t('actionRestore')}</button>
      <button className="secondary" disabled={busy} onClick={() => void api.sendToPage({ type: 'retry-page-translation' })}>{t('actionRetry')}</button>
      <button className="secondary" onClick={api.openOptions}>{t('actionSettings')}</button>
    </div>
    </section>
    <p className="shortcut">{t('shortcut')} <kbd>Shift</kbd> + <kbd>Alt</kbd> + <kbd>A</kbd></p>
  </main>;
}
