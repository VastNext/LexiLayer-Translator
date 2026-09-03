import { useEffect, useState } from 'react';
import { BrandMark } from '../BrandMark';
import { type Theme } from '../shared/config';
import { engineDisplayName } from '../shared/engine-display';
import { createTranslator, type Translator } from '../shared/i18n';
import { languageOptions } from '../shared/languages';
import type { PopupConfigResponse } from './api';
import { isAiEngine } from '../shared/experts';

interface Progress { status: string; completed: number; failed: number; total: number }

export interface PopupApi {
  getConfig(): Promise<PopupConfigResponse>;
  savePreferences?(preferences: NonNullable<PopupConfigResponse['preferences']>): Promise<void>;
  setActiveEngine?(engineId: string): Promise<void>;
  savePopupState?(engineId: string, preferences: NonNullable<PopupConfigResponse['preferences']>, expertId?: string | null): Promise<void>;
  sendToPage(message: unknown): Promise<unknown>;
  setTranslationBadge(active: boolean): Promise<void>;
  openOptions(): void;
  getProgress(): Promise<Progress | undefined>;
  subscribeProgress(listener: (progress: Progress) => void): (() => void) | Promise<() => void>;
}

const fallbackPreferences: NonNullable<PopupConfigResponse['preferences']> = {
  sourceLanguage: 'auto', targetLanguage: 'zh-Hans', displayMode: 'bilingual', scanScope: 'whole-page' as const,
  translationPosition: 'after' as const, userInstruction: '', selectionContext: true,
  selectionPopupEnabled: true, inlineSelectionModifier: 'Control' as const,
};

export function PopupApp({ api, t = createTranslator() }: { api: PopupApi; t?: Translator }) {
  const [preferences, setPreferences] = useState(fallbackPreferences);
  const [engineId, setEngineId] = useState('google');
  const [engines, setEngines] = useState<Array<{ id: string; kind: string; name: string; ready: boolean }>>([
    { id: 'google', kind: 'google', name: 'Google', ready: true },
    { id: 'bing', kind: 'bing', name: 'Bing', ready: true },
  ]);
  const [status, setStatus] = useState(t('ready'));
  const [busy, setBusy] = useState(false);
  const [pageActive, setPageActive] = useState(false);
  const [theme, setTheme] = useState<Theme>('pearl-reader');
  const [experts, setExperts] = useState<NonNullable<PopupConfigResponse['experts']>>([]);
  const [activeExpertByEngine, setActiveExpertByEngine] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void api.getConfig().then((config) => {
      if (disposed) return;
      if (config.preferences) setPreferences(config.preferences);
      const nextTheme = config.theme ?? 'pearl-reader';
      setTheme(nextTheme);
      document.documentElement.dataset.theme = nextTheme;
      setEngineId(config.activeEngineId ?? 'google');
      if (config.availableEngines?.length) setEngines(config.availableEngines);
      setExperts(config.experts?.filter((expert) => expert.enabled) ?? []);
      setActiveExpertByEngine(config.activeExpertByEngine ?? {});
    }).catch((error) => setStatus(error instanceof Error ? error.message : t('statusFailed')));
    void api.getProgress().then((progress) => { if (!disposed && progress) applyProgress(progress); }).catch(() => undefined);
    void Promise.resolve(api.subscribeProgress((progress) => applyProgress(progress)))
      .then((cleanup) => { if (disposed) cleanup(); else unsubscribe = cleanup; })
      .catch(() => undefined);
    return () => { disposed = true; unsubscribe?.(); };
  }, [api]);

  function formatProgress(progress: Progress): string {
    if (progress.status === 'partial') return t('statusPartial', [String(progress.completed), String(progress.total), String(progress.failed)]);
    if (progress.status === 'translating') return t('statusProgress', [String(progress.completed), String(progress.total)]);
    if (progress.status === 'error') return t('statusError', [String(progress.failed), String(progress.total)]);
    if (progress.status === 'complete') return t('statusComplete', [String(progress.completed), String(progress.total)]);
    return t('ready');
  }

  function applyProgress(progress: Progress): void {
    setStatus(formatProgress(progress));
    setPageActive(progress.status !== 'idle');
  }

  function translationCommand(nextEngineId = engineId, nextPreferences = preferences, nextExpertId = activeExpertByEngine[nextEngineId]) {
    return {
      type: 'translate-page', engineId: nextEngineId, scope: nextPreferences.scanScope,
      sourceLanguage: nextPreferences.sourceLanguage ?? 'auto',
      mode: nextPreferences.displayMode === 'translation' ? 'translation-only' : 'bilingual',
      targetLanguage: nextPreferences.targetLanguage,
      ...(isAiEngine(nextEngineId, engines.find((engine) => engine.id === nextEngineId)?.kind) && nextExpertId ? { expertId: nextExpertId } : {}),
    };
  }

  function selectedExpertId(nextEngineId: string): string | undefined {
    return activeExpertByEngine[nextEngineId];
  }

  async function savePreferences(next: typeof preferences, retranslate = false): Promise<void> {
    setPreferences(next);
    try {
      await (api.savePopupState ? (selectedExpertId(engineId) !== undefined ? api.savePopupState(engineId, next, selectedExpertId(engineId)) : api.savePopupState(engineId, next)) : api.savePreferences?.(next));
      if (retranslate && pageActive) await api.sendToPage(translationCommand(engineId, next));
    }
    catch (error) { setStatus(error instanceof Error ? error.message : t('statusFailed')); }
  }

  async function changeEngine(nextEngineId: string): Promise<void> {
    setEngineId(nextEngineId);
    try {
      await (api.savePopupState ? (selectedExpertId(nextEngineId) !== undefined ? api.savePopupState(nextEngineId, preferences, selectedExpertId(nextEngineId)) : api.savePopupState(nextEngineId, preferences)) : api.setActiveEngine?.(nextEngineId) ?? Promise.resolve());
      if (pageActive) await api.sendToPage(translationCommand(nextEngineId, preferences, activeExpertByEngine[nextEngineId]));
    } catch (error) { setStatus(error instanceof Error ? error.message : t('statusFailed')); }
  }

  async function changeExpert(nextExpertId: string): Promise<void> {
    const nextMap = { ...activeExpertByEngine, [engineId]: nextExpertId };
    setActiveExpertByEngine(nextMap);
    try {
      await api.savePopupState?.(engineId, preferences, nextExpertId || null);
      if (pageActive) await api.sendToPage(translationCommand(engineId, preferences, nextExpertId));
    } catch (error) { setStatus(error instanceof Error ? error.message : t('statusFailed')); }
  }

  async function togglePage(): Promise<void> {
    setBusy(true);
    try {
      if (pageActive) {
        await api.setTranslationBadge(false);
        await api.sendToPage({ type: 'restore-page' });
        setPageActive(false);
        setStatus(t('ready'));
      } else {
        await api.setTranslationBadge(true);
        await api.sendToPage(translationCommand());
        setPageActive(true);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('statusFailed'));
    } finally { setBusy(false); }
  }

  return <main className="shell popup" data-theme={theme}>
    <header className="popup-toolbar">
      <div className="brand-lockup"><span className="brand-icon"><BrandMark /></span><strong>Vast Translator</strong></div>
      <button className="icon-button" aria-label={t('actionSettings')} title={t('actionSettings')} onClick={api.openOptions}><span aria-hidden="true">⚙</span></button>
    </header>
    <div className="popup-controls">
       <div className="language-control">
      <label><span>{t('sourceLanguage')}</span><select aria-label={t('sourceLanguage')} value={preferences.sourceLanguage ?? 'auto'} onChange={(event) => void savePreferences({ ...preferences, sourceLanguage: event.target.value })}>
        {languageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select></label><span className="language-arrow" aria-hidden="true">→</span>
      <label><span>{t('targetLanguage')}</span><select aria-label={t('targetLanguage')} value={preferences.targetLanguage} onChange={(event) => void savePreferences({ ...preferences, targetLanguage: event.target.value })}>
        {languageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select></label>
       </div>
       <label className="engine-control"><span className="engine-label">{t('translationEngine')}</span><select aria-label={t('translationEngine')} value={engineId} onChange={(event) => {
         void changeEngine(event.target.value);
       }}>{engines.map((engine) => <option key={engine.id} value={engine.id} disabled={!engine.ready}>{engineDisplayName(engine as Parameters<typeof engineDisplayName>[0])}</option>)}</select></label>
       {isAiEngine(engineId, engines.find((engine) => engine.id === engineId)?.kind) && experts.length > 0 && <label className="engine-control expert-control"><span className="engine-label">AI 专家</span><select aria-label="AI 专家" value={activeExpertByEngine[engineId] ?? ''} onChange={(event) => void changeExpert(event.target.value)}><option value="">不使用专家</option>{experts.map((expert) => <option key={expert.id} value={expert.id}>{expert.name}</option>)}</select></label>}
    </div>
    <p className="status translation-status" role="status"><span className="status-dot" aria-hidden="true" />{status}</p>
    <div className="primary-actions">
      <button className="mode-icon" aria-label={preferences.displayMode === 'bilingual' ? t('bilingual') : t('translationOnly')} title={t('modeToggleHelp')} onClick={() => void savePreferences({ ...preferences, displayMode: preferences.displayMode === 'bilingual' ? 'translation' : 'bilingual' }, true)}>{preferences.displayMode === 'bilingual' ? '◫' : '▣'}</button>
      <button className="primary primary--wide" disabled={busy} aria-busy={busy} onClick={() => void togglePage()}>{busy ? t('statusTranslating') : pageActive ? t('showOriginal') : t('translateShortcut')}</button>
    </div>
  </main>;
}
