import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../BrandMark';
import { DEFAULT_CONFIG, exportSafeConfig, parseConfigImport, validateConfig, type TranslatorConfig } from '../shared/config';
import { languageOptions } from '../shared/languages';
import { createTranslator, type Translator } from '../shared/i18n';

export interface OptionsApi {
  load(): Promise<{ config: TranslatorConfig; hasApiKey: boolean }>;
  save(config: TranslatorConfig): Promise<void>;
  testConnection(config: TranslatorConfig): Promise<void>;
  clearCache(): Promise<void>;
  clearApiKey(): Promise<void>;
  exportConfig(config: ReturnType<typeof exportSafeConfig>): void;
}

export function OptionsApp({ api, t = createTranslator() }: { api: OptionsApi; t?: Translator }) {
  const [config, setConfig] = useState<TranslatorConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'cache' | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void api.load().then(({ config: value, hasApiKey: hasKey }) => { setConfig(value); setHasApiKey(hasKey); setLoaded(true); }); }, [api]);
  const field = (name: keyof TranslatorConfig, value: string) => setConfig((current) => ({ ...current, [name]: value }));

  async function importConfig(file?: File): Promise<void> {
    if (!file) return;
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error(t('importReadFailed')));
        reader.readAsText(file);
      });
      const imported = parseConfigImport(JSON.parse(text));
      setConfig((current) => {
        const next = { ...current, ...imported };
        if (!imported.baseUrl) return next;
        try {
          if (new URL(imported.baseUrl).origin === new URL(current.baseUrl).origin) return next;
        } catch {
          return next;
        }
        return { ...next, apiKey: '' };
      });
      const originChanged = imported.baseUrl && new URL(imported.baseUrl).origin !== new URL(config.baseUrl).origin;
      if (originChanged) setHasApiKey(false);
      setStatus(originChanged
        ? t('importOriginChanged')
        : t('importReady'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('importInvalid'));
    }
  }

  async function saveConfig(): Promise<void> {
    const errors = validateConfig({ ...config, apiKey: config.apiKey || (hasApiKey ? 'existing-key' : '') });
    if (errors.length) return setStatus(errors.join('；'));
    try {
      setBusy('save');
      await api.save(config);
      if (config.apiKey) {
        setHasApiKey(true);
        setConfig((current) => ({ ...current, apiKey: '' }));
      }
      setStatus(t('statusSaved'));
    } catch (error) {
       setStatus(error instanceof Error ? error.message : t('statusSaveFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(): Promise<void> {
    setBusy('test');
    setStatus(t('statusConnectionTesting'));
    try { await api.testConnection(config); setStatus(t('statusConnectionSuccess')); }
    catch { setStatus(t('statusConnectionFailed')); }
    finally { setBusy(null); }
  }

  let connectionOrigin = t('invalidAddress');
  try { connectionOrigin = new URL(config.baseUrl).origin; } catch { /* 输入时显示无效状态 */ }
  const statusState = busy ? 'loading' : /失败|错误|无效/.test(status) ? 'error' : 'ready';

  return <main className="shell options">
    <header className="masthead"><div className="brand-lockup"><BrandMark /><div><h1>Vast Translator</h1><p className="kicker">{t('optionsKicker')}</p></div></div><span className="version">v0.1.0</span></header>
    <section className="section section--marked" aria-labelledby="connection-title"><div className="section-header"><h2 id="connection-title">{t('optionsApiConnection')}</h2><span className="section-index">01 / CONNECT</span></div>
    <div className="grid">
       <label className="field">Base URL<input aria-label="Base URL" disabled={!loaded} value={config.baseUrl} onChange={(event) => field('baseUrl', event.target.value)} /><small>{t('connectionDestination')}<span className="origin">{connectionOrigin}</span></small></label>
       <label className="field">{t('model')}<input aria-label={t('model')} disabled={!loaded} value={config.model} onChange={(event) => field('model', event.target.value)} /></label>
       <label className="field field--wide">API Key<input aria-label="API Key" type="password" autoComplete="off" disabled={!loaded} value={config.apiKey} onChange={(event) => field('apiKey', event.target.value)} /><small>{t('apiKeyHelp')}</small></label>
       {hasApiKey && <p className="help">{t('optionsKeySaved')}</p>}
    </div>
    <p className="note"><strong>{t('connectionNoticeTitle')}</strong>：{t('connectionNotice')}</p>
    <div className="actions actions--primary"><button className="secondary" disabled={!loaded || busy !== null} aria-busy={busy === 'test'} onClick={() => void testConnection()}>{busy === 'test' ? t('statusTesting') : t('actionTestConnection')}</button></div>
    </section>
    <section className="section" aria-labelledby="reading-title"><div className="section-header"><h2 id="reading-title">{t('optionsReadingPreferences')}</h2><span className="section-index">02 / MARK</span></div><div className="grid">
      <label className="field">{t('targetLanguage')}<select aria-label={t('targetLanguage')} value={config.targetLanguage} onChange={(event) => field('targetLanguage', event.target.value)}>
        {languageOptions.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
      </select></label>
      <label className="field">{t('defaultMode')}<select aria-label={t('defaultMode')} value={config.displayMode} onChange={(event) => field('displayMode', event.target.value)}>
        <option value="bilingual">{t('bilingual')}</option><option value="translation">{t('translationOnly')}</option>
      </select></label>
      <label className="field">{t('translationPosition')}<select aria-label={t('translationPosition')} value={config.translationPosition} onChange={(event) => field('translationPosition', event.target.value)}><option value="after">{t('positionAfter')}</option><option value="before">{t('positionBefore')}</option></select></label>
      <label className="field">{t('defaultScope')}<select aria-label={t('defaultScope')} value={config.scanScope} onChange={(event) => field('scanScope', event.target.value)}><option value="main-content">{t('mainContent')}</option><option value="whole-page">{t('wholePage')}</option></select></label>
      <label className="field check-field"><input aria-label={t('limitedContext')} type="checkbox" checked={config.selectionContext} onChange={(event) => setConfig((current) => ({ ...current, selectionContext: event.target.checked }))} /> {t('limitedContextLabel')}</label>
    </div>
    <label className="field field--wide">{t('customInstruction')}<textarea aria-label={t('customInstruction')} value={config.userInstruction} onChange={(event) => field('userInstruction', event.target.value)} /></label>
    <p className="note">{t('privacyWarning')}</p>
    <p className="status" role="status" data-state={statusState}>{status || t('unchanged')}</p>
    <div className="actions actions--primary">
      <button className="primary" disabled={!loaded || busy !== null} aria-busy={busy === 'save'} onClick={() => void saveConfig()}>{busy === 'save' ? t('statusSaving') : t('actionSaveSettings')}</button>
      {hasApiKey && !confirmClearKey && <button className="danger" onClick={() => setConfirmClearKey(true)}>{t('actionClearApiKey')}</button>}
      {hasApiKey && confirmClearKey && <><span className="help">{t('confirmClearKey')}</span><button className="danger" onClick={() => void api.clearApiKey().then(() => { setHasApiKey(false); setConfirmClearKey(false); setStatus(t('statusKeyCleared')); })}>{t('actionConfirmClearKey')}</button></>}
    </div>
    </section>
    <section className="section" aria-labelledby="data-title"><div className="section-header"><h2 id="data-title">{t('optionsDataManagement')}</h2><span className="section-index">03 / LOCAL</span></div>
      <input ref={importInput} id="config-import" hidden aria-label={t('actionImport')} type="file" accept="application/json" onChange={(event) => void importConfig(event.target.files?.[0])} />
      <div className="actions">
        <button className="secondary" onClick={() => importInput.current?.click()}>{t('actionImport')}</button>
        <button className="secondary" onClick={() => api.exportConfig(exportSafeConfig(config))}>{t('actionExport')}</button>
        {!confirmClear && <button className="danger" onClick={() => setConfirmClear(true)}>{t('actionClearCache')}</button>}
        {confirmClear && <><span className="help">{t('confirmClear')}</span><button className="danger" disabled={busy !== null} onClick={() => { setBusy('cache'); void api.clearCache().then(() => { setConfirmClear(false); setStatus(t('cacheCleared')); }).finally(() => setBusy(null)); }}>{t('actionConfirmClear')}</button></>}
      </div>
    </section>
  </main>;
}
