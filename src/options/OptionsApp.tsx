import { useEffect, useRef, useState } from 'react';
import packageJson from '../../package.json' with { type: 'json' };
import { BrandMark } from '../BrandMark';
import {
  DEFAULT_SETTINGS, MAX_CUSTOM_ENGINES, createGeneratedExpertId, exportSettingsWithApiKeys, stripApiKeys, validateEngine,
  type CustomAiEngine, type OptionsEngine, type OptionsSettings, type ReadingPreferences, type SafeSettings, type Theme,
} from '../shared/config';
import { defaultExperts, type Expert } from '../shared/experts';
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
  getEngineApiKey(engineId: string): Promise<string>;
  savePreferences(preferences: ReadingPreferences): Promise<void>;
  upsertEngine(engine: CustomAiEngine): Promise<void>;
  deleteEngine(engineId: string): Promise<void>;
  setActiveEngine(engineId: string): Promise<void>;
  setEngineEnabled(engineId: string, enabled: boolean): Promise<void>;
  reorderEngines(engineIds: string[]): Promise<void>;
  testEngine(engineId: string, candidate?: CustomAiEngine): Promise<void>;
  clearEngineApiKey(engineId: string): Promise<void>;
  importSettings(settings: unknown, allowApiKeys?: boolean): Promise<void>;
  clearCache(): Promise<void>;
  exportSettings(settings: SafeSettings | OptionsSettings): void;
  saveTheme(theme: Theme): Promise<void>;
  setExpertEnabled?(expertId: string, enabled: boolean): Promise<void>;
  upsertExpert?(expert: Expert): Promise<void>;
  deleteExpert?(expertId: string): Promise<void>;
}

const themeChoices: Array<{ id: Theme; name: string; descriptionKey: string; swatch: string }> = [
  { id: 'pearl-reader', name: 'Pearl Reader', descriptionKey: 'themePearlDescription', swatch: 'swatch-pearl' },
  { id: 'command-translator', name: 'Command Translator', descriptionKey: 'themeCommandDescription', swatch: 'swatch-command' },
  { id: 'sage-global', name: 'Sage Global', descriptionKey: 'themeSageDescription', swatch: 'swatch-sage' },
  { id: 'editorial-lingua', name: 'Editorial Lingua', descriptionKey: 'themeEditorialDescription', swatch: 'swatch-editorial' },
  { id: 'precision-blue', name: 'Precision Blue', descriptionKey: 'themePrecisionDescription', swatch: 'swatch-precision' },
];

function customDraft(engine: Extract<OptionsEngine, { kind: 'custom-ai' }>): CustomDraft {
  return { ...engine, apiKey: '', hasApiKey: engine.hasApiKey, savedBaseUrl: engine.baseUrl };
}

function origin(value: string): string | undefined {
  try { return new URL(value).origin; } catch { return undefined; }
}

function exportableSettings(settings: OptionsSettings, drafts: CustomDraft[]): Parameters<typeof exportSettingsWithApiKeys>[0] {
  return {
    ...settings,
    engines: settings.engines.map((engine) => {
      if (engine.kind !== 'custom-ai') return engine;
      const draft = drafts.find((candidate) => candidate.id === engine.id);
      const { hasApiKey: _hasApiKey, ...withoutStatus } = engine;
      return { ...withoutStatus, apiKey: draft?.apiKey ?? '' };
    }),
  } as Parameters<typeof exportSettingsWithApiKeys>[0];
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
  const [visibleApiKeys, setVisibleApiKeys] = useState<Set<string>>(() => new Set());
  const [collapsedEngines, setCollapsedEngines] = useState<Set<string>>(() => new Set());
  const [exportChoice, setExportChoice] = useState(false);
  const [editingExpertId, setEditingExpertId] = useState<string>();
  const [newExpertIds, setNewExpertIds] = useState<Set<string>>(() => new Set());
  const confirmExpertDelete = undefined;
  const importInput = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reloadGeneration = useRef(0);

  async function reload(message?: string): Promise<void> {
    const generation = ++reloadGeneration.current;
    setLoaded(false);
    setLoadFailed(false);
    try {
      const value = await api.load();
      if (generation !== reloadGeneration.current) return;
      setSettings(value);
      document.documentElement.dataset.theme = value.theme;
      const customEngines = value.engines.filter((engine): engine is Extract<OptionsEngine, { kind: 'custom-ai' }> => engine.kind === 'custom-ai');
      const loadedDrafts = customEngines.map(customDraft);
      setDrafts(loadedDrafts);
      setVisibleApiKeys(new Set());
      const keys = await Promise.all(customEngines.map(async (engine) => engine.hasApiKey ? api.getEngineApiKey(engine.id) : ''));
      if (generation !== reloadGeneration.current) return;
      setDrafts(loadedDrafts.map((draft, index) => ({ ...draft, apiKey: keys[index] })));
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
  const updateBaseUrl = (id: string, value: string) => {
    setDrafts((current) => current.map((draft) => {
      if (draft.id !== id) return draft;
      const changedOrigin = Boolean(draft.savedBaseUrl && origin(value) !== origin(draft.savedBaseUrl));
      return changedOrigin ? { ...draft, baseUrl: value, apiKey: '', hasApiKey: false } : { ...draft, baseUrl: value };
    }));
    setVisibleApiKeys((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const toggleApiKey = (id: string) => setVisibleApiKeys((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function act(action: () => Promise<void>, success: string, refresh = false): Promise<void> {
    setStatus(t('statusSaving'));
    try {
      await action();
      if (refresh) await reload(success); else setStatus(success);
    } catch (error) { setStatus(error instanceof Error ? error.message : t('statusSaveFailed')); }
  }

  async function testConnection(engineId: string, candidate?: CustomAiEngine): Promise<void> {
    setStatus(t('statusConnectionTesting'));
    try {
      await api.testEngine(engineId, candidate);
      setStatus(t('statusConnectionSuccess'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('statusConnectionFailed'));
    }
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
    const index = drafts.findIndex((draft) => draft.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= drafts.length) return;
    const orderedDrafts = [...drafts];
    [orderedDrafts[index], orderedDrafts[target]] = [orderedDrafts[target], orderedDrafts[index]];
    if (drafts[index].isNew || drafts[target].isNew) {
      setDrafts(orderedDrafts);
      return;
    }

    const customIds = orderedDrafts.filter((draft) => !draft.isNew).map((draft) => draft.id);
    let customIndex = 0;
    const engineIds = [...settings.engines].sort((a, b) => a.order - b.order).map((engine) => (
      engine.kind === 'custom-ai' ? customIds[customIndex++] : engine.id
    ));
    setStatus(t('statusSaving'));
    try {
      await api.reorderEngines(engineIds);
      setDrafts(orderedDrafts);
      setSettings((current) => ({
        ...current,
        engines: current.engines
          .map((engine) => ({ ...engine, order: engineIds.indexOf(engine.id) }))
          .sort((a, b) => a.order - b.order),
      }));
      setStatus(t('statusOrderSaved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('statusSaveFailed'));
    }
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
      const containsApiKeys = JSON.stringify(parsed).toLowerCase().includes('apikey');
      if (containsApiKeys) await api.importSettings(parsed, true); else await api.importSettings(stripApiKeys(parsed));
      await reload(t('importApplied'));
    } catch (error) { setStatus(error instanceof Error ? error.message : t('importInvalid')); }
  }

  const customCount = drafts.length;
  const experts = settings.experts ?? defaultExperts();
  const builtinExperts = experts.filter((expert) => expert.kind === 'builtin');
  const customExperts = experts.filter((expert) => expert.kind === 'custom');
  const statusState = /失败|错误|无效|不能为空|不能|failed|invalid/i.test(status) ? 'error' : 'ready';

  async function chooseTheme(theme: Theme): Promise<void> {
    const previous = settings.theme;
    setSettings((current) => ({ ...current, theme }));
    document.documentElement.dataset.theme = theme;
    try {
      await api.saveTheme(theme);
      setStatus(t('themeSaved'));
    } catch (error) {
      setSettings((current) => ({ ...current, theme: previous }));
      document.documentElement.dataset.theme = previous;
      setStatus(error instanceof Error ? error.message : t('statusSaveFailed'));
    }
  }

  function navigateTo(id: string): void {
    const content = contentRef.current;
    const target = document.getElementById(id);
    if (!content || !target) return;
    content.scrollTo({ top: target.offsetTop - content.offsetTop, behavior: 'smooth' });
  }

  async function saveExpert(expert: Expert): Promise<void> {
    const errors = !expert.name.trim() ? ['专家名称不能为空'] : !expert.prompt?.trim() ? ['专家提示词不能为空'] : [];
    if (errors.length) return setStatus(errors.join('；'));
    await act(async () => {
      await api.upsertExpert?.(expert);
      setNewExpertIds((current) => { const next = new Set(current); next.delete(expert.id); return next; });
      setEditingExpertId(undefined);
    }, 'AI 专家已保存', true);
  }

  function cancelExpertEdit(expertId: string): void {
    if (newExpertIds.has(expertId)) {
      setSettings((current) => ({ ...current, experts: (current.experts ?? []).filter((expert) => expert.id !== expertId) }));
      setNewExpertIds((current) => { const next = new Set(current); next.delete(expertId); return next; });
    } else {
      void reload();
    }
    setEditingExpertId(undefined);
  }

  async function deleteExpert(expertId: string): Promise<void> {
    await act(async () => {
      await api.deleteExpert?.(expertId);
      setEditingExpertId(undefined);
    }, '专家已删除', true);
  }

  function requestDeleteExpert(expert: Expert): void {
    if (window.confirm(`确定删除专家“${expert.name}”吗？`)) void deleteExpert(expert.id);
  }

  function setConfirmExpertDelete(expertId: string): void {
    const expert = (settings.experts ?? []).find((item) => item.id === expertId);
    if (expert) requestDeleteExpert(expert);
  }


  function createExpert(): void {
    const id = createGeneratedExpertId((settings.experts ?? []).map((expert) => expert.id));
    setSettings((current) => ({ ...current, experts: [...(current.experts ?? []), { id, kind: 'custom', name: '我的翻译专家', description: '自定义翻译能力', prompt: 'Translate accurately into {{to}}. Preserve meaning and formatting.', enabled: true, order: current.experts?.length ?? 0 }] }));
    setNewExpertIds((current) => new Set(current).add(id));
    setEditingExpertId(id);
  }

  async function exportFile(includeApiKeys: boolean): Promise<void> {
    const source = exportableSettings(settings, drafts);
    if (includeApiKeys) {
      source.engines = await Promise.all(source.engines.map(async (engine) => engine.kind === 'custom-ai'
        ? { ...engine, apiKey: engine.apiKey || await api.getEngineApiKey(engine.id) }
        : engine));
    }
    const exported = exportSettingsWithApiKeys(source, includeApiKeys);
    api.exportSettings(exported as SafeSettings | OptionsSettings);
    setExportChoice(false);
  }

  return <main className="shell options" data-theme={settings.theme}>
    <aside className="options-nav">
      <div className="options-brand"><span className="brand-icon"><BrandMark /></span><strong>Vast</strong></div>
      <nav aria-label={t('settingsNavigation')}>
        <button onClick={() => navigateTo('builtin-engines')}>{t('translationEngine')}</button>
        <button onClick={() => navigateTo('custom-engines')}>{t('customAiEngines')}</button>
        <button onClick={() => navigateTo('ai-experts')}>AI 专家</button>
        <button onClick={() => navigateTo('reading-preferences')}>{t('optionsReadingPreferences')}</button>
        <button onClick={() => navigateTo('selection-preferences')}>{t('selectionPreferences')}</button>
        <button onClick={() => navigateTo('appearance-theme')}>{t('appearanceTheme')}</button>
        <button onClick={() => navigateTo('data-privacy')}>{t('dataPrivacy')}</button>
      </nav>
      <small>v{packageJson.version}</small>
    </aside>
    <div className="options-content" ref={contentRef}>
    <header className="masthead"><div><p className="eyebrow">VAST TRANSLATOR</p><h1>{t('optionsTitle')}</h1><p className="kicker">{t('optionsKicker')}</p></div><span className="version">v{packageJson.version}</span></header>

    <section id="builtin-engines" className="section section--marked" aria-label={t('builtinEngines')}>
      <div className="section-header"><h2>{t('builtinEngines')}</h2><span className="section-index">01 / BUILTIN</span></div>
      <div className="builtin-list">{settings.engines.filter((engine) => engine.kind !== 'custom-ai').map((engine) => <article className="engine-row" key={engine.id}>
        <div><h3>{engine.name}</h3></div>
        <div className="engine-controls">
          <span className="badge">{t('builtin')}</span>
          {settings.activeEngineId === engine.id && <span className="badge badge--active">{t('activeDefault')}</span>}
          <label className="toggle"><input type="checkbox" aria-label={`${engine.name} ${t('enabled')}`} checked={engine.enabled} onChange={(event) => void act(() => api.setEngineEnabled(engine.id, event.target.checked), t('statusEngineUpdated'), true)} /> {t('enabled')}</label>
          {settings.activeEngineId !== engine.id && <button className="secondary options-action" disabled={!engine.enabled} onClick={() => void act(() => api.setActiveEngine(engine.id), t('statusActiveChanged'), true)}>{t('setDefault')}</button>}
          <button className="secondary options-action" disabled={!engine.enabled} onClick={() => void testConnection(engine.id)}>{t('actionTestConnection')}</button>
        </div>
      </article>)}</div>
    </section>

    <section id="ai-experts" className="section" aria-label="AI 专家"><div className="section-header"><div><h2>AI 专家</h2><p className="section-copy">选择适合当前内容的翻译方式，也可以创建自己的专家。</p></div><span className="section-index">03 / EXPERTS</span></div>
      <div className="expert-settings-list">{builtinExperts.map((expert) => <article className="expert-setting" aria-label={expert.name} key={expert.id}><div className="expert-setting-head"><div><h3>{expert.name}</h3><span className="badge">PROMPTS</span><p>{expert.description}</p></div><label className="toggle"><input type="checkbox" aria-label={`${expert.name} 启用`} checked={expert.enabled} onChange={(event) => void act(() => api.setExpertEnabled?.(expert.id, event.target.checked) ?? Promise.resolve(), '专家状态已更新', true)} /> 启用</label></div></article>)}</div>
      {customExperts.length > 0 && <div className="expert-custom-group"><div className="expert-custom-heading"><div><h3>用户自定义专家</h3><p>你创建的专家，点击编辑后修改详细提示词。</p></div><span className="section-index">CUSTOM</span></div><div className="expert-settings-list">{customExperts.map((expert) => {
        const editing = editingExpertId === expert.id;
        const isNew = newExpertIds.has(expert.id);
        return <article className={`expert-setting expert-setting--custom ${editing ? 'expert-setting--editing' : ''}`} aria-label={expert.name} key={expert.id}>
          {!editing && <label className="toggle expert-compact-toggle"><input type="checkbox" aria-label={`${expert.name} 启用`} checked={expert.enabled} onChange={(event) => void act(() => api.setExpertEnabled?.(expert.id, event.target.checked) ?? Promise.resolve(), '专家状态已更新', true)} /> 启用</label>}
          {!editing ? <div className="expert-setting-head"><div><h3>{expert.name}</h3><span className="badge">CUSTOM</span><p>{expert.description}</p></div><div className="expert-card-actions"><span className={`expert-status ${expert.enabled ? 'expert-status--on' : ''}`}>{expert.enabled ? '已启用' : '未启用'}</span><button type="button" className="icon-button" aria-label={`编辑 ${expert.name}`} title="编辑" onClick={() => setEditingExpertId(expert.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.7 4.7L8 20l11.5-11.5a2.1 2.1 0 0 0-3-3L5 17Z" /><path d="m14.5 6.5 3 3" /></svg></button>{confirmExpertDelete === expert.id ? <button type="button" className="icon-button icon-button--danger" aria-label={`确认删除 ${expert.name}`} title="确认删除" onClick={() => void deleteExpert(expert.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7V4h6v3m-9 0 1 13h10l1-13" /></svg></button> : <button type="button" className="icon-button icon-button--danger" aria-label={`删除 ${expert.name}`} title="删除" onClick={() => setConfirmExpertDelete(expert.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7V4h6v3m-9 0 1 13h10l1-13" /></svg></button>}</div></div> : <><div className="expert-setting-head"><div><h3>{expert.name}</h3><span className="badge">{isNew ? 'NEW' : 'CUSTOM'}</span></div><label className="toggle"><input type="checkbox" aria-label={`${expert.name} 启用`} checked={expert.enabled} onChange={(event) => setSettings((current) => ({ ...current, experts: (current.experts ?? []).map((item) => item.id === expert.id ? { ...item, enabled: event.target.checked } : item) }))} /> 启用</label></div><div className="grid"><label className="field">名称<input value={expert.name} onChange={(event) => setSettings((current) => ({ ...current, experts: (current.experts ?? []).map((item) => item.id === expert.id ? { ...item, name: event.target.value } : item) }))} /></label><label className="field field--wide">说明<input value={expert.description} onChange={(event) => setSettings((current) => ({ ...current, experts: (current.experts ?? []).map((item) => item.id === expert.id ? { ...item, description: event.target.value } : item) }))} /></label><label className="field field--wide">系统提示词<textarea value={expert.prompt} onChange={(event) => setSettings((current) => ({ ...current, experts: (current.experts ?? []).map((item) => item.id === expert.id ? { ...item, prompt: event.target.value } : item) }))} /></label></div><div className="actions expert-edit-actions"><button className="primary options-action" onClick={() => void saveExpert(expert)}>保存专家</button><button className="secondary options-action" onClick={() => cancelExpertEdit(expert.id)}>{isNew ? '取消' : '取消编辑'}</button>{!isNew && (confirmExpertDelete === expert.id ? <button className="danger options-action" onClick={() => void deleteExpert(expert.id)}>确认删除</button> : <button type="button" className="icon-button icon-button--danger" aria-label={`删除 ${expert.name}`} title="删除" onClick={() => setConfirmExpertDelete(expert.id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7V4h6v3m-9 0 1 13h10l1-13" /></svg></button>)}</div></>}
        </article>;
      })}</div></div>}
      <button className="secondary options-action add-engine" onClick={createExpert}>＋ 自定义专家</button>
    </section>

    <section id="custom-engines" className="section" aria-labelledby="custom-engines-title">
      <div className="section-header"><div><h2 id="custom-engines-title">{t('customAiEngines')}</h2><p className="section-copy">{t('customAiDescription')}</p></div><span className="section-index">02 / AI · {customCount}/{MAX_CUSTOM_ENGINES}</span></div>
      <div className="engine-stack">{drafts.map((draft, index) => {
        const changedOrigin = Boolean(draft.savedBaseUrl && origin(draft.baseUrl) !== origin(draft.savedBaseUrl));
        const collapsed = collapsedEngines.has(draft.id);
        return <fieldset className={`engine-card ${collapsed ? 'engine-card--collapsed' : ''}`} aria-label={draft.name} key={draft.id}>
          <legend><button type="button" className="engine-collapse" aria-expanded={!collapsed} aria-label={`${draft.name} ${collapsed ? '展开' : '折叠'}`} onClick={() => setCollapsedEngines((current) => { const next = new Set(current); if (next.has(draft.id)) next.delete(draft.id); else next.add(draft.id); return next; })}>{collapsed ? '›' : '⌄'}</button>{draft.name}</legend>
          <div className="engine-card-head"><div className="engine-identity"><span className="badge">AI</span>{settings.activeEngineId === draft.id && <span className="badge badge--active">{t('activeDefault')}</span>}</div><label className="toggle"><input type="checkbox" aria-label={t('enabled')} checked={draft.enabled} onChange={(event) => {
            if (draft.isNew) updateDraft(draft.id, 'enabled', event.target.checked);
            else void act(() => api.setEngineEnabled(draft.id, event.target.checked), t('statusEngineUpdated'), true);
          }} /> {t('enabled')}</label></div>
          {!collapsed && <div className="grid engine-grid">
            <label className="field">{t('engineName')}<input aria-label={t('engineName')} value={draft.name} onChange={(event) => updateDraft(draft.id, 'name', event.target.value)} /></label>
            <label className="field">{t('model')}<input aria-label={t('model')} value={draft.model} onChange={(event) => updateDraft(draft.id, 'model', event.target.value)} /></label>
            <label className="field field--wide">Base URL<input aria-label="Base URL" value={draft.baseUrl} onChange={(event) => updateBaseUrl(draft.id, event.target.value)} /><small>{t('connectionDestination')}<span className="origin">{origin(draft.baseUrl) ?? t('invalidAddress')}</span></small></label>
            <label className="field field--wide">API Key<span className="input-wrapper"><input aria-label="API Key" type={visibleApiKeys.has(draft.id) ? 'text' : 'password'} autoComplete="off" value={draft.apiKey} onChange={(event) => updateDraft(draft.id, 'apiKey', event.target.value)} /><button type="button" className="input-icon-button" aria-label={visibleApiKeys.has(draft.id) ? t('hideApiKey') : t('showApiKey')} onClick={() => toggleApiKey(draft.id)}>{visibleApiKeys.has(draft.id) ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.8 10.8 0 0 1 12 4c5.5 0 9 5.1 9 8a8.7 8.7 0 0 1-2.1 3.8M6.2 6.2C4.2 7.6 3 10 3 12c0 2.9 3.5 8 9 8 1.2 0 2.3-.2 3.2-.6" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12c0-2.9 3.5-8 9-8s9 5.1 9 8-3.5 8-9 8-9-5.1-9-8Z" /><circle cx="12" cy="12" r="3" /></svg>}</button></span><small>{draft.hasApiKey && !changedOrigin ? t('optionsKeySaved') : t('apiKeyHelp')}</small></label>
           </div>}
           {!collapsed && changedOrigin && <p className="note">{t('engineOriginChanged')}</p>}
           {!collapsed && <div className="actions engine-actions">
            <button className="primary options-action" onClick={() => void saveDraft(draft)}>{t('saveEngine')}</button>
            <button className="secondary options-action" onClick={() => void testConnection(draft.id, { id: draft.id, kind: 'custom-ai', name: draft.name, enabled: draft.enabled, order: draft.order, baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey })}>{t('actionTestConnection')}</button>
            <button className="secondary options-action" disabled={!draft.enabled || changedOrigin || (!draft.hasApiKey && !draft.apiKey)} onClick={() => void act(() => api.setActiveEngine(draft.id), t('statusActiveChanged'), true)}>{t('setDefault')}</button>
            <button className="secondary options-action" aria-label={t('moveUp')} disabled={index === 0} onClick={() => void move(draft.id, -1)}>↑ {t('moveUp')}</button>
            <button className="secondary options-action" aria-label={t('moveDown')} disabled={index === drafts.length - 1} onClick={() => void move(draft.id, 1)}>↓ {t('moveDown')}</button>
            {draft.hasApiKey && confirmKey !== draft.id && <button className="danger options-action" onClick={() => setConfirmKey(draft.id)}>{t('actionClearApiKey')}</button>}
            {confirmKey === draft.id && <><span className="help">{t('confirmClearKey')}</span><button className="danger options-action" onClick={() => void act(async () => { await api.clearEngineApiKey(draft.id); setConfirmKey(undefined); await reload(t('statusKeyCleared')); }, t('statusKeyCleared'))}>{t('actionConfirmClearKey')}</button></>}
            {!draft.isNew && confirmDelete !== draft.id && <button className="danger options-action" onClick={() => setConfirmDelete(draft.id)}>{t('deleteEngine')}</button>}
            {confirmDelete === draft.id && <><span className="help">{t('confirmDeleteEngine')}</span><button className="danger options-action" onClick={() => void act(async () => { await api.deleteEngine(draft.id); setConfirmDelete(undefined); await reload(t('statusEngineDeleted')); }, t('statusEngineDeleted'))}>{t('confirmDeleteEngineAction')}</button></>}
           </div>}
        </fieldset>;
      })}</div>
      <button className="secondary options-action add-engine" disabled={!loaded || customCount >= MAX_CUSTOM_ENGINES} onClick={() => {
        const id = `custom-${Date.now().toString(36)}`;
        setDrafts((current) => [...current, { id, kind: 'custom-ai', name: `${t('newCustomAi')} ${current.length + 1}`, enabled: true, order: settings.engines.length + current.filter((item) => item.isNew).length, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', hasApiKey: false, savedBaseUrl: '', isNew: true }]);
      }}>{t('addCustomAi')}</button>
    </section>

    <section id="reading-preferences" className="section" aria-labelledby="reading-title"><div className="section-header"><h2 id="reading-title">{t('optionsReadingPreferences')}</h2><span className="section-index">03 / READ</span></div><div className="grid">
      <label className="field">{t('targetLanguage')}<select aria-label={t('targetLanguage')} value={settings.readingPreferences.targetLanguage} onChange={(event) => updatePreferences('targetLanguage', event.target.value)}>{languageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</select></label>
      <label className="field">{t('defaultMode')}<select aria-label={t('defaultMode')} value={settings.readingPreferences.displayMode} onChange={(event) => updatePreferences('displayMode', event.target.value as ReadingPreferences['displayMode'])}><option value="bilingual">{t('bilingual')}</option><option value="translation">{t('translationOnly')}</option></select></label>
      <label className="field">{t('translationPosition')}<select aria-label={t('translationPosition')} value={settings.readingPreferences.translationPosition} onChange={(event) => updatePreferences('translationPosition', event.target.value as ReadingPreferences['translationPosition'])}><option value="after">{t('positionAfter')}</option><option value="before">{t('positionBefore')}</option></select></label>
      <label className="field">{t('defaultScope')}<select aria-label={t('defaultScope')} value={settings.readingPreferences.scanScope} onChange={(event) => updatePreferences('scanScope', event.target.value as ReadingPreferences['scanScope'])}><option value="main-content">{t('mainContent')}</option><option value="whole-page">{t('wholePage')}</option></select></label>
      <label className="field field--wide">{t('customInstruction')}<textarea aria-label={t('customInstruction')} value={settings.readingPreferences.userInstruction} onChange={(event) => updatePreferences('userInstruction', event.target.value)} /><small>{t('instructionCustomOnly')}</small></label>
    </div></section>

    <section id="selection-preferences" className="section" aria-label={t('selectionPreferences')}><div className="section-header"><h2>{t('selectionPreferences')}</h2><span className="section-index">04 / SELECT</span></div><div className="grid">
      <label className="field check-field"><input aria-label={t('limitedContext')} type="checkbox" checked={settings.readingPreferences.selectionContext} onChange={(event) => updatePreferences('selectionContext', event.target.checked)} /> {t('limitedContextLabel')}</label>
      <label className="field check-field"><input aria-label={t('selectionPopupEnabled')} type="checkbox" checked={settings.readingPreferences.selectionPopupEnabled} onChange={(event) => updatePreferences('selectionPopupEnabled', event.target.checked)} /> {t('selectionPopupEnabled')}</label>
      <label className="field">{t('inlineSelectionModifier')}<select aria-label={t('inlineSelectionModifier')} value={settings.readingPreferences.inlineSelectionModifier} onChange={(event) => updatePreferences('inlineSelectionModifier', event.target.value as ReadingPreferences['inlineSelectionModifier'])}><option value="Control">Ctrl</option><option value="Alt">Alt</option><option value="Shift">Shift</option><option value="Meta">{typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'Command' : 'Win / Command'}</option><option value="Off">{t('modifierOff')}</option></select></label>
      <p className="field field--wide context-help">{t('limitedContextHelp')}</p>
    </div><div className="actions actions--primary"><button className="primary options-action" onClick={() => void act(() => api.savePreferences(settings.readingPreferences), t('statusSaved'))}>{t('savePreferences')}</button></div></section>

    <section id="appearance-theme" className="section theme-section" aria-label={t('appearanceTheme')}><div className="section-header"><div><h2>{t('appearanceTheme')}</h2><p className="section-copy">{t('themeDescription')}</p></div><span className="section-index">05 / THEME</span></div>
      <div className="theme-grid">{themeChoices.map((theme) => <button key={theme.id} className={`theme-choice ${settings.theme === theme.id ? 'selected' : ''}`} aria-pressed={settings.theme === theme.id} aria-label={`${theme.name}：${t(theme.descriptionKey)}`} onClick={() => void chooseTheme(theme.id)}>
        <span className={`theme-swatch ${theme.swatch}`} aria-hidden="true" /><span><strong>{theme.name}</strong><small>{t(theme.descriptionKey)}</small></span><i aria-hidden="true">{settings.theme === theme.id ? '✓' : ''}</i>
      </button>)}</div>
    </section>

    <section id="data-privacy" className="section" aria-labelledby="data-title"><div className="section-header"><div><h2 id="data-title">{t('dataPrivacy')}</h2><p className="section-copy">{t('privacyWarning')}</p></div><span className="section-index">06 / LOCAL</span></div>
      <input ref={importInput} hidden aria-label={t('actionImport')} type="file" accept="application/json" onChange={(event) => void importFile(event.target.files?.[0])} />
       <div className="actions"><button className="secondary options-action" onClick={() => importInput.current?.click()}>{t('actionImport')}</button>{!exportChoice ? <button className="secondary options-action" onClick={() => setExportChoice(true)}>{t('actionExport')}</button> : <span className="export-choice"><span className="help">是否包含 API Key？</span><button className="primary options-action" onClick={() => void exportFile(true)}>包含 API Key</button><button className="secondary options-action" onClick={() => void exportFile(false)}>不含 API Key</button><button className="secondary options-action" onClick={() => setExportChoice(false)}>取消导出</button></span>}
      {!confirmCache ? <button className="danger options-action" onClick={() => setConfirmCache(true)}>{t('actionClearCache')}</button> : <><span className="help">{t('confirmClear')}</span><button className="danger options-action" onClick={() => void act(async () => { await api.clearCache(); setConfirmCache(false); }, t('cacheCleared'))}>{t('actionConfirmClear')}</button></>}</div>
    </section>
    <p className="status status-toast" role="status" data-state={statusState}>{status || t('unchanged')} {loadFailed && <button className="secondary options-action" onClick={() => void reload()}>{t('actionRetry')}</button>}</p>
    </div>
  </main>;
}
