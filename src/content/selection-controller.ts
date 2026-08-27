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
  getPublicConfig(): Promise<{ targetLanguage: string; selectionContext: boolean; activeEngineId: string; engines: Array<{ id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }> }>;
  createView?(rect: DOMRect, actions: SelectionViewActions): SelectionViewHandle;
  events?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  now?: () => number;
}

interface StreamMessage { type?: string; requestId?: string; engineId?: string; chunk?: string; error?: string; canFallback?: boolean }

function selectedElement(selection: Selection): Element | null {
  const node = selection.getRangeAt(0).commonAncestorContainer;
  return node instanceof Element ? node : node.parentElement;
}

function isAllowedSelection(selection: Selection, text: string): boolean {
  if (!text || text.length > 5000 || selection.rangeCount === 0) return false;
  const element = selectedElement(selection);
  return Boolean(element && !element.closest('input,textarea,[contenteditable="true"],[contenteditable=""],[type="password"]'));
}

export function createSelectionController(dependencies: SelectionDependencies) {
  let view: SelectionViewHandle | undefined;
  let port: SelectionPort | undefined;
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
  const events = dependencies.events ?? document;
  const now = dependencies.now ?? Date.now;
  const onMouseUp = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea,[contenteditable="true"],[contenteditable=""],[type="password"]')) return close();
    authorizationAvailable = true;
    authorizationExpiresAt = now() + 1_500;
    if (view && (event.target === view.host || view.host.contains(event.target as Node))) return;
    show();
  };
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  const onMouseDown = (event: MouseEvent) => {
    if (view && event.target !== view.host && !view.host.contains(event.target as Node)) close();
  };

  function close(): void {
    if (activeRequestId) port?.postMessage({ type: 'cancel-selection', requestId: activeRequestId });
    if (activeRequestId && activeRequestEngineId) void dependencies.cancelFallback(activeRequestId, activeRequestEngineId);
    port?.disconnect();
    fallbackController?.abort();
    port = undefined;
    view?.remove();
    view = undefined;
    authorizationAvailable = false;
    activeRequestId = undefined;
    activeRequestEngineId = undefined;
  }

  function start(language: string, includeContext: boolean, selectedEngineId: string): void {
    if (!authorizationAvailable || now() > authorizationExpiresAt) return;
    authorizationAvailable = false;
    const previousRequestId = activeRequestId;
    const previousEngineId = activeRequestEngineId;
    if (previousRequestId) port?.postMessage({ type: 'cancel-selection', requestId: previousRequestId });
    fallbackController?.abort();
    if (previousRequestId && previousEngineId) void dependencies.cancelFallback(previousRequestId, previousEngineId);
    port?.disconnect();
    targetLanguage = language;
    engineId = selectedEngineId;
    const requestId = `selection-${++requestGeneration}`;
    activeRequestId = requestId;
    activeRequestEngineId = selectedEngineId;
    fallbackController = undefined;
    port = dependencies.connect();
    port.onMessage.addListener((raw) => {
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
    port.postMessage({
      type: 'translate-selection', requestId, engineId, text, sourceLanguage: 'auto', targetLanguage,
      context: includeContext ? context : undefined,
    });
  }

  function show(): void {
    const selection = dependencies.getSelection();
    const selectedText = selection?.toString().trim() ?? '';
    if (!selection || !isAllowedSelection(selection, selectedText)) return close();
    close();
    authorizationAvailable = true;
    text = selectedText;
    const element = selectedElement(selection);
    context = element?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 600);
    const actions = {
      translate: start,
      copy: () => { if (view?.getResult()) void dependencies.copy(view.getResult()); },
      close,
    };
    view = dependencies.createView?.(selection.getRangeAt(0).getBoundingClientRect(), actions)
      ?? new SelectionView(document, selection.getRangeAt(0).getBoundingClientRect(), actions);
    view.mount();
    view.setTargetLanguage(targetLanguage);
    void dependencies.getPublicConfig().then((config) => {
      targetLanguage = config.targetLanguage;
      view?.setTargetLanguage(config.targetLanguage);
      view?.setIncludeContext(config.selectionContext);
      engineId = config.activeEngineId;
      view?.setEngines(config.engines, config.activeEngineId);
    });
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
    void dependencies.getPublicConfig().then((config) => { targetLanguage = config.targetLanguage; engineId = config.activeEngineId; view?.setTargetLanguage(config.targetLanguage); view?.setIncludeContext(config.selectionContext); view?.setEngines(config.engines, config.activeEngineId); });
  }

  function register(): void {
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
  const controller = createSelectionController({
    getSelection: () => globalThis.getSelection(),
    connect: () => chrome.runtime.connect({ name: 'vast-selection-stream' }),
    async translateFallback(requestId, text, targetLanguage, context, engineId, signal) {
      if (signal.aborted) throw new Error('任务已取消');
      const response = await chrome.runtime.sendMessage({
        type: 'translate-selection-fallback', requestId, engineId, sourceLanguage: 'auto', targetLanguage, context, text,
      }) as { ok: boolean; data?: Array<{ text: string }>; error?: string };
      if (signal.aborted) throw new Error('任务已取消');
      if (!response.ok) throw new Error(response.error);
      return response.data?.[0]?.text ?? '';
    },
    async cancelFallback(requestId, _engineId) {
      await chrome.runtime.sendMessage({ type: 'cancel-selection-fallback', requestId });
    },
    copy: (text) => navigator.clipboard.writeText(text),
    async getPublicConfig() {
      const response = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as { data?: { preferences?: { targetLanguage?: string; selectionContext?: boolean }; activeEngineId?: string; availableEngines?: Array<{ id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }> } };
      return { targetLanguage: response.data?.preferences?.targetLanguage ?? 'en', selectionContext: response.data?.preferences?.selectionContext ?? true, activeEngineId: response.data?.activeEngineId ?? 'google', engines: response.data?.availableEngines ?? [{ id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } }, { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } }] };
    },
    createView: (rect, actions) => new SelectionView(document, rect, actions, t),
  });
  controller.register();
  return controller;
}
