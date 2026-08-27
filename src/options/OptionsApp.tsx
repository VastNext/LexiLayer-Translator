import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../BrandMark';
import {
  DEFAULT_SETTINGS, MAX_CUSTOM_ENGINES, exportSafeSettings, validateEngine,
  type CustomAiEngine, type OptionsEngine, type OptionsSettings, type ReadingPreferences, type SafeSettings,
} from '../shared/config';
import { languageOptions } from '../shared/languages';
import { createTranslator, type Translator } from '../shared/i18n';

type CustomDraft = Omit<CustomAiEngine, 'apiKey'> & {
  apiKey: string;
  hasApiKey: boolean;
  savedBaseUrl: string;
  isNew?: boolean;
};

export interface OptionsApi {
  load(): Promise<OptionsSettings>;
  savePreferences(preferences: ReadingPreferences): Promise<void>;
  upsertEngine(engine: CustomAiEngine): Promise<void>;
  deleteEngine(engineId: string): Promise<void>;
  setActiveEngine(engineId: string): Promise<void>;
  setEngineEnabled(engineId: string, enabled: boolean): Promise<void>;
  reorderEngines(engineIds: string[]): Promise<void>;
  testEngine(engineId: string, candidate?: CustomAiEngine): Promise<void>;
  clearEngineApiKey(engineId: string): Promise<void>;
  importSettings(settings: unknown): Promise<void>;
  clearCache(): Promise<void>;
  exportSettings(settings: SafeSettings): void;
}

function customDraft(engine: Extract<OptionsEngine, { kind: 'custom-ai' }>): CustomDraft {
  return { ...engine, apiKey: '', hasApiKey: engine.hasApiKey, savedBaseUrl: engine.baseUrl };
}

function origin(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}

function safeExport(settings: OptionsSettings, drafts: CustomDraft[]): SafeSettings {
  return exportSafeSettings({
    ...settings,
    engines: settings.engines.map((engine) => {
      if (engine.kind !== 'custom-ai') return engine;
      const draft = drafts.find((candidate) => candidate.id === engine.id) ?? customDraft(engine);
      const { hasApiKey: _hasApiKey, savedBaseUrl: _savedBaseUrl, isNew: _isNew, apiKey: _apiKey, ...safe } = draft;
      return { ...safe, apiKey: '' };
    }),
  } as Parameters<typeof exportSafeSettings>[0]);
}

export function OptionsApp({ api, t = createTranslator() }: { api: OptionsApi; t?: Translator }) {
  const [settings, setSettings] = useState<OptionsSettings>(() => ({
    ...structuredClone(DEFAULT_SETTINGS),
    engines: structuredClone(DEFAULT_SETTINGS.engines.filter((engine): engine is Exclude<OptionsEngine, { kind: 'custom-ai' }> => engine.kind !== 'custom-ai')),
  }));
  const [drafts, setDrafts] = useState<CustomDraft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [confirmKey, setConfirmKey] = useState<string>();
  const [confirmCache, setConfirmCache] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const reloadGeneration = useRef(0);

  async function reload(message?: string): Promise<void> {
    const generation = ++reloadGeneration.current;
    setLoaded(false);
    setLoadFailed(false);
    try {
      const value = await api.load();
      if (generation !== reloadGeneration.current) return;
      setSettings(value);
      setDrafts(value.engines.filter((engine): engine is Extract<OptionsEngine, { kind: 'custom-ai' }> => engine.kind === 'custom-ai').map(customDraft));
      if (message) setStatus(message);
    } catch (error) {
      if (generation !== reloadGeneration.current) return;
      setLoadFailed(true);
      setStatus(error instanceof Error ? error.message : t('statusSaveFailed'));
    } finally {
      if (generation === reloadGeneration.current) setLoaded(true);
    }
  }

  useEffect(() => { void reload(); }, [api]);

  const updatePreferences = <K extends keyof ReadingPreferences>(key: K, value: ReadingPreferences[K]) => {
    setSettings((current) => ({ ...current, readingPreferences: { ...current.readingPreferences, [key]: value } }));
  };
  const updateDraft = <K extends keyof CustomDraft>(id: string, key: K, value: CustomDraft[K]) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, [key]: value } : draft));
  };

  async function act(action: () => Promise<void>, success: string, refresh = false): Promise<void> {
    try {
      await action();
      if (refresh) await reload(success); else setStatus(success);
    } catch (error) { setStatus(error instanceof Error ? error.message : t('statusSaveFailed')); }
  }

  async function saveDraft(draft: CustomDraft): Promise<void> {
    const changedOrigin = Boolean(draft.hasApiKey && origin(draft.baseUrl) !== origin(draft.savedBaseUrl));
    const engine: CustomAiEngine = {
      id: draft.id, kind: 'custom-ai', name: draft.name.trim(), enabled: draft.enabled, order: draft.order,
      baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: draft.apiKey,
    };
    const errors = validateEngine(engine).filter((error) => error !== 'API Key 必须是字符串');
    if (!engine.apiKey && (!draft.hasApiKey || changedOrigin)) errors.push('API Key 不能为空');
    if (errors.length) return setStatus(errors.join('；'));
    await act(() => api.upsertEngine(engine), t('statusEngineSaved'), true);
  }

  async function move(id: string, direction: -1 | 1): Promise<void> {
    const ordered = [...settings.engines].sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((engine) => engine.id === id);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    await act(() => api.reorderEngines(ordered.map(({ id: engineId }) => engineId)), t('statusOrderSaved'), true);
  }

  async function importFile(file?: File): Promise<void> {
    if (!file) return;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error(t('importReadFailed')));
        reader.readAsText(file);
      });
      const parsed = JSON.parse(text);
      await api.importSettings(parsed);
      await reload(t('importApplied'));
    } catch (error) { setStatus(error instanceof Error ? error.message : t('importInvalid')); }
  }

  const customCount = drafts.length;
  const statusState = /失败|错误|无效|不能为空|不能|failed|invalid/i.test(status) ? 'error' : 'ready';

  return <main className="shell options">
    <header className="masthead"><div className="brand-lockup"><BrandMark /><div><h1>Vast Translator</h1><p className="kicker">{t('optionsKicker')}</p></div></div><span className="version">v0.2.0</span></header>

    <section className="section section--marked" aria-label={t('builtinEngines')}>
      <div className="section-header"><h2>{t('builtinEngines')}</h2><span className="section-index">01 / BUILTIN</span></div>
      <div className="builtin-list">{settings.engines.filter((engine) => engine.kind !== 'custom-ai').map((engine) => <article className="engine-row" key={engine.id}>
        <div><h3>{engine.name}</h3><p className="engine-meta">{engine.id === 'google' ? t('googleDefaultFree') : t('bingBackup')}</p></div>
        <div className="engine-controls">
          <span className={`badge ${settings.activeEngineId === engine.id ? 'badge--active' : ''}`}>{settings.activeEngineId === engine.id ? t('activeDefault') : t('builtin')}</span>
          <label className="toggle"><input type="checkbox" aria-label={`${engine.name} ${t('enabled')}`} checked={engine.enabled} onChange={(event) => void act(() => api.setEngineEnabled(engine.id, event.target.checked), t('statusEngineUpdated'), true)} /> {t('enabled')}</label>
          {settings.activeEngineId !== engine.id && <button className="secondary" disabled={!engine.enabled} onClick={() => void act(() => api.setActiveEngine(engine.id), t('statusActiveChanged'), true)}>{t('setDefault')}</button>}
          <button className="secondary" disabled={!engine.enabled} onClick={() => void act(() => api.testEngine(engine.id), t('statusConnectionSuccess'))}>{t('actionTestConnection')}</button>
        </div>
      </article>)}</div>
    </section>

    <section className="section" aria-labelledby="custom-engines-title">
      <div className="section-header"><div><h2 id="custom-engines-title">{t('customAiEngines')}</h2><p className="section-copy">{t('customAiDescription')}</p></div><span className="section-index">02 / AI · {customCount}/{MAX_CUSTOM_ENGINES}</span></div>
      <div className="engine-stack">{drafts.map((draft, index) => {
        const changedOrigin = Boolean(draft.hasApiKey && origin(draft.baseUrl) !== origin(draft.savedBaseUrl));
        return <fieldset className="engine-card" aria-label={draft.name} key={draft.id}>
          <legend>{draft.name}</legend>
          <div className="engine-card-head"><div className="engine-identity"><span className="badge">AI</span><code>{draft.id}</code>{settings.activeEngineId === draft.id && <span className="badge badge--active">{t('activeDefault')}</span>}</div><label className="toggle"><input type="checkbox" aria-label={t('enabled')} checked={draft.enabled} onChange={(event) => void act(() => api.setEngineEnabled(draft.id, event.target.checked), t('statusEngineUpdated'), true)} /> {t('enabled')}</label></div>
          <div className="grid engine-grid">
            <label className="field">{t('engineName')}<input aria-label={t('engineName')} value={draft.name} onChange={(event) => updateDraft(draft.id, 'name', event.target.value)} /></label>
            <label className="field">{t('model')}<input aria-label={t('model')} value={draft.model} onChange={(event) => updateDraft(draft.id, 'model', event.target.value)} /></label>
            <label className="field field--wide">Base URL<input aria-label="Base URL" value={draft.baseUrl} onChange={(event) => updateDraft(draft.id, 'baseUrl', event.target.value)} /><small>{t('connectionDestination')}<span className="origin">{origin(draft.baseUrl) ?? t('invalidAddress')}</span></small></label>
            <label className="field field--wide">API Key<input aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => updateDraft(draft.id, 'apiKey', event.target.value)} /><small>{draft.hasApiKey && !changedOrigin ? t('optionsKeySaved') : t('apiKeyHelp')}</small></label>
          </div>
          {changedOrigin && <p className="note">{t('engineOriginChanged')}</p>}
          <div className="actions engine-actions">
            <button className="primary" onClick={() => void saveDraft(draft)}>{t('saveEngine')}</button>
            <button className="secondary" onClick={() => void act(() => api.testEngine(draft.id, { id: draft.id, kind: 'custom-ai', name: draft.name, enabled: draft.enabled, order: draft.order, baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey }), t('statusConnectionSuccess'))}>{t('actionTestConnection')}</button>
            <button className="secondary" disabled={!draft.enabled || changedOrigin || (!draft.hasApiKey && !draft.apiKey)} onClick={() => void act(() => api.setActiveEngine(draft.id), t('statusActiveChanged'), true)}>{t('setDefault')}</button>
            <button className="secondary compact" aria-label={t('moveUp')} disabled={index === 0} onClick={() => void move(draft.id, -1)}>↑ {t('moveUp')}</button>
            <button className="secondary compact" aria-label={t('moveDown')} disabled={index === drafts.length - 1} onClick={() => void move(draft.id, 1)}>↓ {t('moveDown')}</button>
            {draft.hasApiKey && confirmKey !== draft.id && <button className="danger" onClick={() => setConfirmKey(draft.id)}>{t('actionClearApiKey')}</button>}
            {confirmKey === draft.id && <><span className="help">{t('confirmClearKey')}</span><button className="danger" onClick={() => void act(async () => { await api.clearEngineApiKey(draft.id); setConfirmKey(undefined); await reload(t('statusKeyCleared')); }, t('statusKeyCleared'))}>{t('actionConfirmClearKey')}</button></>}
            {!draft.isNew && confirmDelete !== draft.id && <button className="danger" onClick={() => setConfirmDelete(draft.id)}>{t('deleteEngine')}</button>}
            {confirmDelete === draft.id && <><span className="help">{t('confirmDeleteEngine')}</span><button className="danger" onClick={() => void act(async () => { await api.deleteEngine(draft.id); setConfirmDelete(undefined); await reload(t('statusEngineDeleted')); }, t('statusEngineDeleted'))}>{t('confirmDeleteEngineAction')}</button></>}
          </div>
        </fieldset>;
      })}</div>
      <button className="secondary add-engine" disabled={!loaded || customCount >= MAX_CUSTOM_ENGINES} onClick={() => {
        const id = `custom-${Date.now().toString(36)}`;
        setDrafts((current) => [...current, { id, kind: 'custom-ai', name: `${t('newCustomAi')} ${current.length + 1}`, enabled: true, order: settings.engines.length + current.filter((item) => item.isNew).length, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', hasApiKey: false, savedBaseUrl: '', isNew: true }]);
      }}>{t('addCustomAi')}</button>
    </section>

    <section className="section" aria-labelledby="reading-title"><div className="section-header"><h2 id="reading-title">{t('optionsReadingPreferences')}</h2><span className="section-index">03 / READ</span></div><div className="grid">
      <label className="field">{t('targetLanguage')}<select aria-label={t('targetLanguage')} value={settings.readingPreferences.targetLanguage} onChange={(event) => updatePreferences('targetLanguage', event.target.value)}>{languageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</select></label>
      <label className="field">{t('defaultMode')}<select aria-label={t('defaultMode')} value={settings.readingPreferences.displayMode} onChange={(event) => updatePreferences('displayMode', event.target.value as ReadingPreferences['displayMode'])}><option value="bilingual">{t('bilingual')}</option><option value="translation">{t('translationOnly')}</option></select></label>
      <label className="field">{t('translationPosition')}<select aria-label={t('translationPosition')} value={settings.readingPreferences.translationPosition} onChange={(event) => updatePreferences('translationPosition', event.target.value as ReadingPreferences['translationPosition'])}><option value="after">{t('positionAfter')}</option><option value="before">{t('positionBefore')}</option></select></label>
      <label className="field">{t('defaultScope')}<select aria-label={t('defaultScope')} value={settings.readingPreferences.scanScope} onChange={(event) => updatePreferences('scanScope', event.target.value as ReadingPreferences['scanScope'])}><option value="main-content">{t('mainContent')}</option><option value="whole-page">{t('wholePage')}</option></select></label>
      <label className="field check-field"><input aria-label={t('limitedContext')} type="checkbox" checked={settings.readingPreferences.selectionContext} onChange={(event) => updatePreferences('selectionContext', event.target.checked)} /> {t('limitedContextLabel')}</label>
      <label className="field field--wide">{t('customInstruction')}<textarea aria-label={t('customInstruction')} value={settings.readingPreferences.userInstruction} onChange={(event) => updatePreferences('userInstruction', event.target.value)} /><small>{t('instructionCustomOnly')}</small></label>
    </div><div className="actions actions--primary"><button className="primary" onClick={() => void act(() => api.savePreferences(settings.readingPreferences), t('statusSaved'))}>{t('savePreferences')}</button></div></section>

    <section className="section" aria-labelledby="data-title"><div className="section-header"><h2 id="data-title">{t('optionsDataManagement')}</h2><span className="section-index">04 / LOCAL</span></div>
      <input ref={importInput} hidden aria-label={t('actionImport')} type="file" accept="application/json" onChange={(event) => void importFile(event.target.files?.[0])} />
      <div className="actions"><button className="secondary" onClick={() => importInput.current?.click()}>{t('actionImport')}</button><button className="secondary" onClick={() => api.exportSettings(safeExport(settings, drafts))}>{t('actionExport')}</button>
      {!confirmCache ? <button className="danger" onClick={() => setConfirmCache(true)}>{t('actionClearCache')}</button> : <><span className="help">{t('confirmClear')}</span><button className="danger" onClick={() => void act(async () => { await api.clearCache(); setConfirmCache(false); }, t('cacheCleared'))}>{t('actionConfirmClear')}</button></>}</div>
    </section>
    <p className="status sticky-status" role="status" data-state={statusState}>{status || t('unchanged')} {loadFailed && <button className="secondary compact" onClick={() => void reload()}>{t('actionRetry')}</button>}</p>
  </main>;
}
