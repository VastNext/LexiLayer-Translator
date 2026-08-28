import { SelectionView, type SelectionViewActions, type SelectionViewHandle } from './selection-view';

interface SelectionPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface SelectionDependencies {
  getSelection(): Selection | null;
  connect(): SelectionPort;
  translateFallback(requestId: string, text: string, targetLanguage: string, context: string | undefined, engineId: string, signal: AbortSignal): Promise<string>;
  cancelFallback(requestId: string, engineId: string): Promise<void>;
  copy(text: string): Promise<void>;
  translateInline(text: string, context: string | undefined, engineId: string, targetLanguage: string): Promise<string>;
  getPublicConfig(): Promise<{ targetLanguage: string; selectionContext: boolean; selectionPopupEnabled: boolean; inlineSelectionModifier: 'Control' | 'Alt' | 'Shift' | 'Meta' | 'Off'; activeEngineId: string; engines: Array<{ id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }> }>;
  createView?(rect: DOMRect, actions: SelectionViewActions): SelectionViewHandle;
  events?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  now?: () => number;
}

interface StreamMessage { type?: string; requestId?: string; engineId?: string; chunk?: string; error?: string; canFallback?: boolean }

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && /Extension context invalidated/i.test(error.message);
}

function selectedElement(selection: Selection): Element | null {
  const node = selection.getRangeAt(0).commonAncestorContainer;
  return node instanceof Element ? node : node.parentElement;
}

function isAllowedSelection(selection: Selection, text: string): boolean {
  if (!text || text.length > 5000 || selection.rangeCount === 0) return false;
  const element = selectedElement(selection);
  return Boolean(element && !element.closest('input,textarea,[contenteditable="true"],[contenteditable=""],[type="password"]'));
}

function selectionBlock(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('p,li,blockquote,figcaption,td,th,h1,h2,h3,h4,h5,h6,article,section,main,div')
    ?? (element instanceof HTMLElement ? element : element.parentElement);
}

interface RememberedSelection {
  text: string;
  context?: string;
  element: Element;
  block: HTMLElement;
  range: Range;
  rect: DOMRect;
}

export function createSelectionController(dependencies: SelectionDependencies) {
  let view: SelectionViewHandle | undefined;
  let port: SelectionPort | undefined;
  let portConnected = false;
  let text = '';
  let context: string | undefined;
  let targetLanguage = 'en';
  let engineId = 'google';
  let authorizationExpiresAt = 0;
  let authorizationAvailable = false;
  let requestGeneration = 0;
  let fallbackController: AbortController | undefined;
  let activeRequestId: string | undefined;
  let activeRequestEngineId: string | undefined;
  let remembered: RememberedSelection | undefined;
  let config: Awaited<ReturnType<SelectionDependencies['getPublicConfig']>> = { targetLanguage: 'en', selectionContext: true, selectionPopupEnabled: true, inlineSelectionModifier: 'Control', activeEngineId: 'google', engines: [] };
  let selectionGeneration = 0;
  const events = dependencies.events ?? document;
  const now = dependencies.now ?? Date.now;
  const onMouseUp = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea,[contenteditable="true"],[contenteditable=""],[type="password"]')) return close();
    authorizationAvailable = true;
    authorizationExpiresAt = now() + 1_500;
    if (view && (event.target === view.host || view.host.contains(event.target as Node))) return;
    rememberSelection();
    if (!remembered) return close();
    const generation = ++selectionGeneration;
    if (config.selectionPopupEnabled) showRemembered();
    void dependencies.getPublicConfig().then((value) => {
      config = value;
      targetLanguage = value.targetLanguage;
      engineId = value.activeEngineId;
      if (generation !== selectionGeneration) return;
      if (!value.selectionPopupEnabled) close();
      else if (!view) showRemembered();
      else { view.setTargetLanguage(value.targetLanguage); view.setIncludeContext(value.selectionContext); view.setEngines(value.engines, value.activeEngineId); }
    }).catch((error) => { if (isContextInvalidated(error)) close(); });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') return close();
    if (event.repeat || config.inlineSelectionModifier === 'Off' || event.key !== config.inlineSelectionModifier) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea,[contenteditable="true"],[contenteditable=""],[type="password"]')) return;
    void toggleInline();
  };
  const onMouseDown = (event: MouseEvent) => {
    if (view && !event.composedPath().includes(view.host)) close();
  };

  function close(): void {
    if (activeRequestId) safePost({ type: 'cancel-selection', requestId: activeRequestId });
    if (activeRequestId && activeRequestEngineId) void dependencies.cancelFallback(activeRequestId, activeRequestEngineId).catch(() => undefined);
    safeDisconnect();
    fallbackController?.abort();
    view?.remove();
    view = undefined;
    authorizationAvailable = false;
    activeRequestId = undefined;
    activeRequestEngineId = undefined;
  }

  function safePost(message: unknown): boolean {
    if (!port || !portConnected) return false;
    try { port.postMessage(message); return true; } catch { return false; }
  }

  function safeDisconnect(): void {
    const current = port;
    port = undefined;
    portConnected = false;
    if (!current) return;
    try { current.disconnect(); } catch { /* Port 可能已由浏览器断开。 */ }
  }

  function rememberSelection(): void {
    const selection = dependencies.getSelection();
    const selectedText = selection?.toString().trim() ?? '';
    if (!selection || !isAllowedSelection(selection, selectedText)) { remembered = undefined; return; }
    const range = selection.getRangeAt(0);
    const element = selectedElement(selection);
    const block = element && selectionBlock(element);
    if (!element || !block) { remembered = undefined; return; }
    remembered = {
      text: selectedText,
      context: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 600),
      element,
      block,
      range,
      rect: range.getBoundingClientRect(),
    };
  }

  async function toggleInline(): Promise<void> {
    const selected = remembered;
    if (!selected || !selected.block.isConnected) return;
    const existing = selected.block.nextElementSibling;
    if (existing?.hasAttribute('data-vast-inline-selection-translation')) { existing.remove(); return; }
    const result = await dependencies.translateInline(selected.text, selected.context, config.activeEngineId, config.targetLanguage).catch(() => '');
    if (!result || remembered !== selected || !selected.block.isConnected) return;
    const translation = selected.block.ownerDocument.createElement('div');
    translation.dataset.vastInlineSelectionTranslation = '';
    translation.textContent = result;
    selected.block.after(translation);
  }

  function start(language: string, includeContext: boolean, selectedEngineId: string): void {
    if (!authorizationAvailable || now() > authorizationExpiresAt) return;
    authorizationAvailable = false;
    const previousRequestId = activeRequestId;
    const previousEngineId = activeRequestEngineId;
    if (previousRequestId) safePost({ type: 'cancel-selection', requestId: previousRequestId });
    fallbackController?.abort();
    if (previousRequestId && previousEngineId) void dependencies.cancelFallback(previousRequestId, previousEngineId).catch(() => undefined);
    safeDisconnect();
    targetLanguage = language;
    engineId = selectedEngineId;
    const requestId = `selection-${++requestGeneration}`;
    activeRequestId = requestId;
    activeRequestEngineId = selectedEngineId;
    fallbackController = undefined;
    let currentPort: SelectionPort;
    try { currentPort = dependencies.connect(); } catch (error) {
      if (isContextInvalidated(error)) close();
      else view?.setResult('翻译失败，请重试');
      return;
    }
    port = currentPort;
    portConnected = true;
    currentPort.onDisconnect.addListener(() => {
      if (port !== currentPort) return;
      port = undefined;
      portConnected = false;
      activeRequestId = undefined;
      activeRequestEngineId = undefined;
      fallbackController?.abort();
      fallbackController = undefined;
    });
    currentPort.onMessage.addListener((raw) => {
      const message = raw as StreamMessage;
      if (message.requestId !== requestId || requestId !== activeRequestId || message.engineId !== undefined && message.engineId !== engineId) return;
      if (message.type === 'selection-chunk' && typeof message.chunk === 'string') view?.appendResult(message.chunk);
      if (message.type === 'selection-error' && message.canFallback === true && engineId.startsWith('custom-')) {
        const controller = new AbortController();
        fallbackController = controller;
        void dependencies.translateFallback(requestId, text, targetLanguage, includeContext ? context : undefined, engineId, controller.signal)
          .then((result) => { if (!controller.signal.aborted && requestId === activeRequestId) view?.setResult(result); })
          .catch(() => { if (!controller.signal.aborted && requestId === activeRequestId) view?.setResult('翻译失败，请重试'); });
      } else if (message.type === 'selection-error') {
        view?.setResult(message.error || '翻译失败，请重试');
      }
    });
    safePost({
      type: 'translate-selection', requestId, engineId, text, sourceLanguage: 'auto', targetLanguage,
      context: includeContext ? context : undefined,
    });
  }

  function showRemembered(): void {
    const selected = remembered;
    if (!selected) return close();
    close();
    authorizationAvailable = true;
    authorizationExpiresAt = now() + 1_500;
    text = selected.text;
    context = selected.context;
    const actions = {
      translate: start,
      copy: () => { if (view?.getResult()) void dependencies.copy(view.getResult()); },
      close,
    };
    view = dependencies.createView?.(selected.rect, actions)
      ?? new SelectionView(document, selected.rect, actions);
    view.mount();
    view.setTargetLanguage(config.targetLanguage);
    view.setIncludeContext(config.selectionContext);
    if (config.engines.length) view.setEngines(config.engines, config.activeEngineId);
  }

  function showText(value: string): void {
    if (!value.trim() || value.length > 5000) return;
    close();
    text = value.trim();
    context = undefined;
    authorizationAvailable = true;
    authorizationExpiresAt = now() + 1_500;
    const actions = { translate: start, copy: () => { if (view?.getResult()) void dependencies.copy(view.getResult()); }, close };
    view = dependencies.createView?.(new DOMRect(16, 16, 0, 0), actions) ?? new SelectionView(document, new DOMRect(16, 16, 0, 0), actions);
    view.mount();
    view.open(targetLanguage);
    void dependencies.getPublicConfig().then((config) => { targetLanguage = config.targetLanguage; engineId = config.activeEngineId; view?.setTargetLanguage(config.targetLanguage); view?.setIncludeContext(config.selectionContext); view?.setEngines(config.engines, config.activeEngineId); }).catch((error) => { if (isContextInvalidated(error)) close(); });
  }

  function register(): void {
    void dependencies.getPublicConfig().then((value) => { config = value; targetLanguage = value.targetLanguage; engineId = value.activeEngineId; }).catch((error) => { if (isContextInvalidated(error)) close(); });
    events.addEventListener('mouseup', onMouseUp as EventListener);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
  }

  function dispose(): void {
    close();
    events.removeEventListener('mouseup', onMouseUp as EventListener);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('mousedown', onMouseDown);
  }

  return { register, close, dispose, showText };
}

export function registerSelectionController() {
  const t = (key: string, substitutions?: string | string[]) => chrome.i18n.getMessage(key, substitutions) || key;
  let controller: ReturnType<typeof createSelectionController>;
  async function runtimeMessage<T>(message: unknown): Promise<T> {
    try { return await chrome.runtime.sendMessage(message) as T; }
    catch (error) {
      if (isContextInvalidated(error)) controller?.close();
      throw error;
    }
  }
  controller = createSelectionController({
    getSelection: () => globalThis.getSelection(),
    connect: () => chrome.runtime.connect({ name: 'vast-selection-stream' }),
    async translateFallback(requestId, text, targetLanguage, context, engineId, signal) {
      if (signal.aborted) throw new Error('任务已取消');
      const response = await runtimeMessage<{ ok: boolean; data?: Array<{ text: string }>; error?: string }>({
        type: 'translate-selection-fallback', requestId, engineId, sourceLanguage: 'auto', targetLanguage, context, text,
      });
      if (signal.aborted) throw new Error('任务已取消');
      if (!response.ok) throw new Error(response.error);
      return response.data?.[0]?.text ?? '';
    },
    async cancelFallback(requestId, _engineId) {
      await runtimeMessage({ type: 'cancel-selection-fallback', requestId });
    },
    copy: (text) => navigator.clipboard.writeText(text),
    async translateInline(text, context, engineId, targetLanguage) {
      const response = await runtimeMessage<{ ok: boolean; data?: { text?: string }; error?: string }>({ type: 'translate-selection-inline', text, context, engineId, targetLanguage });
      if (!response.ok) throw new Error(response.error);
      return response.data?.text ?? '';
    },
    async getPublicConfig() {
      const response = await runtimeMessage<{ data?: { preferences?: { targetLanguage?: string; selectionContext?: boolean; selectionPopupEnabled?: boolean; inlineSelectionModifier?: 'Control' | 'Alt' | 'Shift' | 'Meta' | 'Off' }; activeEngineId?: string; availableEngines?: Array<{ id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }> } }>({ type: 'get-public-config' });
      return { targetLanguage: response.data?.preferences?.targetLanguage ?? 'en', selectionContext: response.data?.preferences?.selectionContext ?? true, selectionPopupEnabled: response.data?.preferences?.selectionPopupEnabled ?? true, inlineSelectionModifier: response.data?.preferences?.inlineSelectionModifier ?? 'Control', activeEngineId: response.data?.activeEngineId ?? 'google', engines: response.data?.availableEngines ?? [{ id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } }, { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } }] };
    },
    createView: (rect, actions) => new SelectionView(document, rect, actions, t),
  });
  controller.register();
  return controller;
}
