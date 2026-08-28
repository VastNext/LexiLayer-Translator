import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSelectionController, registerSelectionController, type SelectionDependencies } from '../../src/content/selection-controller';
import { SelectionView, type SelectionViewActions, type SelectionViewHandle } from '../../src/content/selection-view';
import { SUPPORTED_LANGUAGES } from '../../src/shared/languages';
import type { Translator } from '../../src/shared/i18n';

function selectionFor(element: Element, text: string): Selection {
  return {
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({
      commonAncestorContainer: element.firstChild ?? element,
      getBoundingClientRect: () => ({ left: 10, right: 50, top: 10, bottom: 30, width: 40, height: 20, x: 10, y: 10, toJSON() {} }),
    }),
  } as unknown as Selection;
}

function createPort() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let requestId: string | undefined;
  const port = {
    postMessage: vi.fn((message: unknown) => { requestId = (message as { requestId?: string }).requestId; }),
    disconnect: vi.fn(() => disconnectListeners.forEach((listener) => listener())),
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    emit: (message: unknown) => messageListeners.forEach((listener) => listener({ requestId, ...(message as object) })),
    emitDisconnect: () => disconnectListeners.forEach((listener) => listener()),
  };
  return port;
}

function createEventSource() {
  const listeners = new Map<string, EventListener>();
  return {
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener as EventListener);
    }),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    emit(type: string, event: Event) { listeners.get(type)?.(event); },
  };
}

class TestSelectionView implements SelectionViewHandle {
  readonly host = document.createElement('div');
  private result = '';
  private language = 'en';

  constructor(private readonly actions: SelectionViewActions) {
    this.host.dataset.vastSelectionHost = '';
    this.host.innerHTML = `
      <button aria-label="翻译选中内容">V</button>
      <section role="dialog"><select name="engine"><option value="google">Google</option><option value="bing">Bing</option><option value="custom-work">工作接口</option></select><select name="target-language"><option value="zh-Hans">简体中文</option><option value="en">English</option><option value="ja">日本語</option></select>
      <input name="include-context" type="checkbox" checked><div data-result></div>
      <button data-action="copy">复制</button><button data-action="retry">重试</button></section>`;
    this.host.querySelector('[aria-label="翻译选中内容"]')?.addEventListener('click', () => this.requestTranslation());
    this.host.querySelector('[data-action="retry"]')?.addEventListener('click', () => this.requestTranslation());
    this.host.querySelector('[data-action="copy"]')?.addEventListener('click', () => actions.copy());
    this.host.querySelector('[name="target-language"]')?.addEventListener('change', (event) => {
      this.language = (event.target as HTMLSelectElement).value;
      this.requestTranslation();
    });
  }

  mount(): void { document.body.append(this.host); }
  open(language: string): void { this.setTargetLanguage(language); }
  setTargetLanguage(language: string): void {
    this.language = language;
    (this.host.querySelector('[name="target-language"]') as HTMLSelectElement).value = language;
  }
  setIncludeContext(includeContext: boolean): void { (this.host.querySelector('[name="include-context"]') as HTMLInputElement).checked = includeContext; }
  setEngines(engines: Array<{ id: string; name: string; ready: boolean }>, activeEngineId: string): void {
    const select = this.host.querySelector('[name="engine"]') as HTMLSelectElement;
    for (const option of [...select.options]) option.disabled = engines.find((engine) => engine.id === option.value)?.ready === false;
    select.value = activeEngineId;
  }
  setResult(value: string): void {
    this.result = value;
    this.host.querySelector('[data-result]')!.textContent = value;
  }
  appendResult(chunk: string): void { this.setResult(this.result + chunk); }
  getResult(): string { return this.result; }
  remove(): void { this.host.remove(); }
  private requestTranslation(): void {
    const includeContext = (this.host.querySelector('[name="include-context"]') as HTMLInputElement).checked;
    this.actions.translate(this.language, includeContext, (this.host.querySelector('[name="engine"]') as HTMLSelectElement).value);
  }
}

function createDependencies(): SelectionDependencies & {
  port: ReturnType<typeof createPort>;
  selection: Selection | null;
  eventSource: ReturnType<typeof createEventSource>;
} {
  const port = createPort();
  const eventSource = createEventSource();
  return {
    port,
    eventSource,
    selection: null,
    getSelection() { return this.selection; },
    connect: vi.fn(() => port),
    translateFallback: vi.fn(async () => '非流式译文'),
    cancelFallback: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
    translateInline: vi.fn(async () => '段后中文译文'),
    getPublicConfig: vi.fn(async () => ({ targetLanguage: 'zh-Hans', selectionContext: true, selectionPopupEnabled: true, inlineSelectionModifier: 'Control' as const, activeEngineId: 'google', engines: [{ id: 'google', kind: 'google', name: 'Google', ready: true, capabilities: { streaming: false } }, { id: 'bing', kind: 'bing', name: 'Bing', ready: true, capabilities: { streaming: false } }, { id: 'custom-work', kind: 'custom-ai', name: '工作接口', ready: true, capabilities: { streaming: true } }] })),
    events: eventSource,
    createView: (_rect, actions) => new TestSelectionView(actions),
  };
}

function view(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-vast-selection-host]')!;
}

describe('划词翻译控制器', () => {
  let dependencies: ReturnType<typeof createDependencies>;
  let controller: ReturnType<typeof createSelectionController>;

  beforeEach(() => {
    document.body.innerHTML = '<p id="text">Hello selection context</p><input value="secret"><div id="edit" contenteditable="true">editable</div>';
    dependencies = createDependencies();
  });

  afterEach(() => {
    controller?.dispose();
    vi.restoreAllMocks();
  });

  function register(): void {
    controller = createSelectionController(dependencies);
    controller.register();
  }

  function trustedMouseUp(target?: EventTarget): void {
    dependencies.eventSource.emit('mouseup', { isTrusted: true, target } as unknown as MouseEvent);
  }

  it('普通选区显示原创 V 按钮，点击后创建 Shadow DOM 浮层', async () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    expect(view().querySelector('[aria-label="翻译选中内容"]')?.textContent).toBe('V');

    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    expect(view().querySelector('[role="dialog"]')).not.toBeNull();
    expect(dependencies.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-selection', text: 'Hello' }));
  });

  it('拒绝脚本派发的不可信 mouseup', () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();

    dependencies.eventSource.emit('mouseup', new MouseEvent('mouseup'));

    expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
  });

  it('可信 mouseup 产生的翻译授权只能消费一次', () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    const trigger = view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement;

    trigger.click();
    trigger.click();

    expect(dependencies.connect).toHaveBeenCalledOnce();
    expect(dependencies.port.postMessage).toHaveBeenCalledOnce();
  });

  it('可信 mouseup 产生的翻译授权过期后不可消费', () => {
    let now = 1_000;
    dependencies.now = () => now;
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    now += 1_501;

    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();

    expect(dependencies.connect).not.toHaveBeenCalled();
    expect(dependencies.port.postMessage).not.toHaveBeenCalled();
  });

  it('拒绝超过 5000 字及 input、textarea、contenteditable 和 password 内选区', () => {
    register();
    for (const [selector, text] of [
      ['#text', 'x'.repeat(5001)],
      ['input', 'secret'],
      ['#edit', 'editable'],
    ]) {
      dependencies.selection = selectionFor(document.querySelector(selector)!, text);
      trustedMouseUp();
      expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
    }
  });

  it('输入框 mouseup 不复用页面中遗留的普通文本选区', () => {
    register();
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'old page selection');

    trustedMouseUp(document.querySelector('input')!);

    expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
  });

  it('有限上下文开关只发送邻近上下文且可关闭', () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'selection');
    register();
    trustedMouseUp();
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    expect(dependencies.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ context: 'Hello selection context' }));

    (view().querySelector('[name="include-context"]') as HTMLInputElement).click();
    trustedMouseUp(view());
    (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    expect(dependencies.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ context: undefined }));
  });

  it('流式累积，custom 流式失败时回退非流式翻译', async () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    (view().querySelector('[name="engine"]') as HTMLSelectElement).value = 'custom-work';
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    dependencies.port.emit({ type: 'selection-chunk', chunk: '你' });
    dependencies.port.emit({ type: 'selection-chunk', chunk: '好' });
    expect(view().querySelector('[data-result]')?.textContent).toBe('你好');

    dependencies.port.emit({ type: 'selection-error', canFallback: true, error: '流式响应格式无效' });
    await vi.waitFor(() => expect(view().querySelector('[data-result]')?.textContent).toBe('非流式译文'));
  });

  it('引擎选择固定在 port、fallback 与 cancel 链路，内置引擎错误不 fallback', async () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    const engine = view().querySelector('[name="engine"]') as HTMLSelectElement;
    engine.value = 'bing';
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    expect(dependencies.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ engineId: 'bing' }));
    dependencies.port.emit({ type: 'selection-error', engineId: 'bing', canFallback: false, error: 'Bing 失败' });
    expect(dependencies.translateFallback).not.toHaveBeenCalled();
    expect(view().querySelector('[data-result]')).toHaveTextContent('Bing 失败');

    trustedMouseUp(view());
    engine.value = 'custom-work';
    (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    const customRequest = vi.mocked(dependencies.port.postMessage).mock.calls.at(-1)![0] as { requestId: string };
    dependencies.port.emit({ type: 'selection-error', requestId: customRequest.requestId, engineId: 'custom-work', canFallback: true, error: '流式格式错误' });
    await vi.waitFor(() => expect(dependencies.translateFallback).toHaveBeenCalledWith(customRequest.requestId, 'Hello', expect.any(String), 'Hello selection context', 'custom-work', expect.any(AbortSignal)));
    controller.close();
    expect(dependencies.cancelFallback).toHaveBeenCalledWith(customRequest.requestId, 'custom-work');
  });

  it('custom 只有 canFallback=true 才回退，否则结束 loading、显示错误且可重试', async () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    (view().querySelector('[name="engine"]') as HTMLSelectElement).value = 'custom-work';
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    const first = vi.mocked(dependencies.port.postMessage).mock.calls.at(-1)![0] as { requestId: string };

    dependencies.port.emit({ type: 'selection-error', requestId: first.requestId, engineId: 'custom-work', error: '流式失败' });

    expect(dependencies.translateFallback).not.toHaveBeenCalled();
    expect(view().querySelector('[data-result]')).toHaveTextContent('流式失败');
    trustedMouseUp(view());
    (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    expect(vi.mocked(dependencies.port.postMessage).mock.calls.filter(([message]) => (message as { type?: string }).type === 'translate-selection')).toHaveLength(2);
  });

  it('custom fallback 失败后结束 loading 并显示可重试错误', async () => {
    vi.mocked(dependencies.translateFallback).mockRejectedValue(new Error('fallback failed'));
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    (view().querySelector('[name="engine"]') as HTMLSelectElement).value = 'custom-work';
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();

    dependencies.port.emit({ type: 'selection-error', engineId: 'custom-work', canFallback: true, error: '流式失败' });

    await vi.waitFor(() => expect(view().querySelector('[data-result]')).toHaveTextContent('翻译失败，请重试'));
    trustedMouseUp(view());
    (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    expect(vi.mocked(dependencies.port.postMessage).mock.calls.filter(([message]) => (message as { type?: string }).type === 'translate-selection')).toHaveLength(2);
  });

  it('requestId 隔离旧流和旧 fallback，并把 engine/context/AbortSignal 传给回退', async () => {
    let resolveFallback!: (value: string) => void;
    vi.mocked(dependencies.translateFallback).mockReturnValue(new Promise((resolve) => { resolveFallback = resolve; }));
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'first');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    (view().querySelector('[name="engine"]') as HTMLSelectElement).value = 'custom-work';
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    const firstRequest = vi.mocked(dependencies.port.postMessage).mock.calls[0][0] as { requestId: string };
    dependencies.port.emit({ type: 'selection-error', requestId: firstRequest.requestId, canFallback: true, error: '失败' });
    expect(dependencies.translateFallback).toHaveBeenCalledWith(firstRequest.requestId, 'first', expect.any(String), 'Hello selection context', 'custom-work', expect.any(AbortSignal));

    trustedMouseUp(view());
    (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    const secondRequest = vi.mocked(dependencies.port.postMessage).mock.calls.at(-1)![0] as { requestId: string };
    dependencies.port.emit({ type: 'selection-chunk', requestId: firstRequest.requestId, chunk: '旧' });
    dependencies.port.emit({ type: 'selection-chunk', requestId: secondRequest.requestId, chunk: '新' });
    resolveFallback('旧回退');
    await Promise.resolve();
    expect(view().querySelector('[data-result]')?.textContent).toBe('新');
  });

  it('重试前使用旧 requestId 取消流和 fallback，并先中止本地 fallback', async () => {
    let oldSignal: AbortSignal | undefined;
    vi.mocked(dependencies.translateFallback).mockImplementation((_requestId, _text, _target, _context, _engine, signal) => {
      oldSignal = signal;
      return new Promise(() => undefined);
    });
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    (view().querySelector('[name="engine"]') as HTMLSelectElement).value = 'custom-work';
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    const firstRequest = vi.mocked(dependencies.port.postMessage).mock.calls[0][0] as { requestId: string };
    dependencies.port.emit({ type: 'selection-error', requestId: firstRequest.requestId, engineId: 'custom-work', canFallback: true, error: '流式失败' });
    await vi.waitFor(() => expect(oldSignal).toBeDefined());

    trustedMouseUp(view());
    (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click();

    expect(oldSignal?.aborted).toBe(true);
    expect(dependencies.port.postMessage).toHaveBeenCalledWith({ type: 'cancel-selection', requestId: firstRequest.requestId });
    expect(dependencies.cancelFallback).toHaveBeenCalledWith(firstRequest.requestId, 'custom-work');
    const secondRequest = vi.mocked(dependencies.port.postMessage).mock.calls.at(-1)![0] as { requestId: string };
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
  });

  it('支持复制、重试和目标语言切换', async () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    dependencies.port.emit({ type: 'selection-chunk', chunk: '译文' });
    (view().querySelector('[data-action="copy"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dependencies.copy).toHaveBeenCalledWith('译文'));

    const language = view().querySelector('[name="target-language"]') as HTMLSelectElement;
    language.value = 'ja';
    trustedMouseUp();
    language.dispatchEvent(new Event('change', { bubbles: true }));
    expect(dependencies.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ targetLanguage: 'ja' }));
  });

  it('Escape、外部点击和新选区都会中止并关闭旧浮层', () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
    expect(dependencies.port.disconnect).toHaveBeenCalled();
    expect(dependencies.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel-selection', requestId: expect.any(String) }));
    expect(dependencies.cancelFallback).toHaveBeenCalledWith(expect.any(String), 'google');

    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Again');
    trustedMouseUp();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
  });

  it('Port 已断开且操作抛错时 close 仍移除浮层', () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    dependencies.port.emitDisconnect();
    vi.mocked(dependencies.port.postMessage).mockImplementation(() => { throw new Error('Attempting to use a disconnected port object'); });
    vi.mocked(dependencies.port.disconnect).mockImplementation(() => { throw new Error('Attempting to use a disconnected port object'); });

    expect(() => controller.close()).not.toThrow();
    expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
  });

  it('旧 Port 断开后重试不会因 disconnected port 抛错', () => {
    const nextPort = createPort();
    vi.mocked(dependencies.connect).mockReturnValueOnce(dependencies.port).mockReturnValueOnce(nextPort);
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    (view().querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();
    dependencies.port.emitDisconnect();
    vi.mocked(dependencies.port.postMessage).mockImplementation(() => { throw new Error('Attempting to use a disconnected port object'); });
    trustedMouseUp(view());

    expect(() => (view().querySelector('[data-action="retry"]') as HTMLButtonElement).click()).not.toThrow();
    expect(nextPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'translate-selection' }));
  });

  it('closed shadow 内部 mousedown 通过 composedPath 识别为面板交互，不关闭浮层', () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    const host = view();
    document.dispatchEvent(Object.assign(new MouseEvent('mousedown'), { composedPath: () => [document.createElement('button'), host, document] }));
    expect(document.querySelector('[data-vast-selection-host]')).toBe(host);
  });

  it('关闭悬浮按钮后仍记住最近可信鼠标选区', async () => {
    vi.mocked(dependencies.getPublicConfig).mockResolvedValue({ ...(await dependencies.getPublicConfig()), selectionPopupEnabled: false });
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register();
    trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());

    expect(document.querySelector('[data-vast-selection-host]')).toBeNull();
    dependencies.selection = null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    await vi.waitFor(() => expect(document.querySelector('[data-vast-inline-selection-translation]')).toHaveTextContent('段后中文译文'));
  });

  it('Control 在当前选区块后插入纯文本译文，再按一次移除', async () => {
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    dependencies.selection = null;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    await vi.waitFor(() => expect(document.querySelector('#text + [data-vast-inline-selection-translation]')).toHaveTextContent('段后中文译文'));
    expect(dependencies.translateInline).toHaveBeenCalledWith('Hello', 'Hello selection context', 'google', 'zh-Hans');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    expect(document.querySelector('[data-vast-inline-selection-translation]')).toBeNull();
  });

  it('按配置 modifier 触发，Off、repeat、输入框与 contenteditable 均不响应', async () => {
    vi.mocked(dependencies.getPublicConfig).mockResolvedValue({ ...(await dependencies.getPublicConfig()), inlineSelectionModifier: 'Alt' });
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    dependencies.selection = null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', repeat: true }));
    expect(dependencies.translateInline).not.toHaveBeenCalled();
    document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
    document.querySelector('#edit')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
    expect(dependencies.translateInline).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    await vi.waitFor(() => expect(dependencies.translateInline).toHaveBeenCalledOnce());
  });

  it('Off 完全禁用选区内联翻译', async () => {
    vi.mocked(dependencies.getPublicConfig).mockResolvedValue({ ...(await dependencies.getPublicConfig()), inlineSelectionModifier: 'Off' });
    dependencies.selection = selectionFor(document.querySelector('#text')!, 'Hello');
    register(); trustedMouseUp();
    await vi.waitFor(() => expect(dependencies.getPublicConfig).toHaveBeenCalled());
    dependencies.selection = null;
    for (const key of ['Control', 'Alt', 'Shift', 'Meta']) document.dispatchEvent(new KeyboardEvent('keydown', { key }));
    expect(dependencies.translateInline).not.toHaveBeenCalled();
  });
});

describe('划词翻译真实注册接线', () => {
  afterEach(() => vi.restoreAllMocks());

  it('注册入口把 chrome.i18n 英文翻译器注入真实 SelectionView', () => {
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) {
      root = original.call(this, options);
      return root;
    });
    const messages: Record<string, string> = {
      selectionTranslate: 'Translate selection',
      selectionDialog: 'Selection translation',
      actionClose: 'Close',
      actionCopy: 'Copy',
      actionRetry: 'Retry',
    };
    vi.stubGlobal('chrome', {
      runtime: { connect: vi.fn(), sendMessage: vi.fn(async () => ({ data: {} })) },
      i18n: { getMessage: vi.fn((key: string) => messages[key] ?? key) },
    });
    const controller = registerSelectionController();

    controller.showText('Hello');

    expect(root!.querySelector('[aria-label="Translate selection"]')).not.toBeNull();
    controller.dispose();
    vi.unstubAllGlobals();
  });

  it('Extension context invalidated 时关闭视图且不产生未处理拒绝', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        connect: vi.fn(),
        sendMessage: vi.fn(async () => { throw new Error('Extension context invalidated.'); }),
      },
      i18n: { getMessage: vi.fn((key: string) => key) },
    });
    const controller = registerSelectionController();
    controller.showText('Hello');

    await vi.waitFor(() => expect(document.querySelector('[data-vast-selection-host]')).toBeNull());
    expect(() => controller.dispose()).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('划词翻译视图隔离', () => {
  afterEach(() => vi.restoreAllMocks());

  it('使用 closed shadow，网页无法读取翻译结果', () => {
    const attachShadow = vi.spyOn(HTMLElement.prototype, 'attachShadow');
    const view = new SelectionView(document, new DOMRect(0, 0, 10, 10), {
      translate: vi.fn(), copy: vi.fn(), close: vi.fn(),
    });
    view.mount();

    expect(view.host.shadowRoot).toBeNull();
    expect(attachShadow).toHaveBeenCalledWith({ mode: 'closed' });
    view.remove();
    attachShadow.mockRestore();
  });

  it('划词视图支持英文核心标签和完整语言列表', () => {
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const t: Translator = (key) => ({ selectionTranslate: 'Translate selection', selectionDialog: 'Selection translation', actionClose: 'Close', actionCopy: 'Copy', actionRetry: 'Retry' }[key] ?? key);
    const view = new SelectionView(document, new DOMRect(0, 0, 10, 10), { translate: vi.fn(), copy: vi.fn(), close: vi.fn() }, t);
    expect(root!.querySelector('[aria-label="Translate selection"]')).not.toBeNull();
    const languages = [...root!.querySelectorAll<HTMLOptionElement>('[name="target-language"] option')].map((option) => option.value);
    expect(languages).toContain('it');
    expect(languages).toEqual(SUPPORTED_LANGUAGES);
    view.remove();
  });

  it('划词引擎选项只显示内置名称，自定义未就绪追加未配置', () => {
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const view = new SelectionView(document, new DOMRect(0, 0, 10, 10), { translate: vi.fn(), copy: vi.fn(), close: vi.fn() });
    view.setEngines([
      { id: 'google', kind: 'google', name: 'Google', ready: true },
      { id: 'bing', kind: 'bing', name: 'Bing', ready: true },
      { id: 'custom-work', kind: 'custom-ai', name: '工作接口', ready: false },
    ], 'google');
    const options = [...root!.querySelectorAll<HTMLOptionElement>('[name="engine"] option')];
    expect(options.map((option) => option.textContent)).toEqual(['Google', 'Bing', '工作接口 · 未配置']);
    expect(options[2].disabled).toBe(true);
    view.remove();
  });

  it('按钮和打开后的面板都 clamp 在 viewport 8px 内，滚动保持 fixed，resize 重新 clamp', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 240 });
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const view = new SelectionView(document, new DOMRect(350, 230, 20, 20), { translate: vi.fn(), copy: vi.fn(), close: vi.fn() });
    view.mount();
    expect(view.host.style.position).toBe('fixed');
    expect(parseFloat(view.host.style.left)).toBeLessThanOrEqual(320);
    expect(parseFloat(view.host.style.top)).toBeLessThanOrEqual(200);
    vi.spyOn(root!.querySelector('.panel')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 220));
    view.open('zh-Hans');
    expect(parseFloat(view.host.style.left)).toBeLessThanOrEqual(32);
    expect(parseFloat(view.host.style.top)).toBeLessThanOrEqual(12);
    window.dispatchEvent(new Event('scroll'));
    expect(view.host.style.position).toBe('fixed');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 340 });
    window.dispatchEvent(new Event('resize'));
    expect(parseFloat(view.host.style.left)).toBeLessThanOrEqual(12);
    view.remove();
  });

  it('底部选区在上方空间足够时向上展开，并保持 viewport 底部留白', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const anchor = new DOMRect(180, 540, 120, 24);
    const view = new SelectionView(document, anchor, { translate: vi.fn(), copy: vi.fn(), close: vi.fn() });
    vi.spyOn(root!.querySelector('.panel')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 220));
    view.mount();
    view.open('zh-Hans');

    expect(parseFloat(view.host.style.top)).toBe(anchor.top - 220 - 8);
    expect(parseFloat(view.host.style.top) + 220).toBeLessThanOrEqual(window.innerHeight - 8);
    view.remove();
  });

  it('结果区右上角按重试、复制顺序提供 icon 按钮', () => {
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const view = new SelectionView(document, new DOMRect(10, 10, 20, 20), { translate: vi.fn(), copy: vi.fn(), close: vi.fn() });

    const wrap = root!.querySelector('.result-wrap');
    const actions = [...wrap!.querySelectorAll<HTMLElement>('.result-actions [data-action]')];
    expect(wrap?.querySelector('[data-result]')).not.toBeNull();
    expect(actions.map((action) => action.dataset.action)).toEqual(['retry', 'copy']);
    expect(wrap?.querySelector('[data-action="copy"]')).toHaveAttribute('aria-label', '复制');
    expect(wrap?.querySelector('[data-action="copy"]')).toHaveAttribute('title', '复制');
    expect(wrap?.querySelector('[data-action="retry"]')).toHaveAttribute('aria-label', '重试');
    expect(wrap?.querySelector('[data-action="retry"]')).toHaveAttribute('title', '重试');
    expect(root!.querySelector('.actions')).toBeNull();
    view.remove();
  });

  it('标题栏控件保持单行、close 固定可见，有限上下文是 aria-pressed 图标 toggle', () => {
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const view = new SelectionView(document, new DOMRect(10, 10, 20, 20), { translate: vi.fn(), copy: vi.fn(), close: vi.fn() });
    const top = root!.querySelector('.top')!;
    const context = root!.querySelector('[name="include-context"]') as HTMLButtonElement;
    expect(top.querySelector('[data-drag-handle]')).not.toBeNull();
    expect(top.querySelector('[data-action="close"]')).not.toBeNull();
    expect(context.tagName).toBe('BUTTON');
    expect(context).toHaveAttribute('aria-pressed', 'true');
    expect(context.title).toContain('发送选区所在段落的有限文本帮助消歧，不翻译上下文本身');
    expect(top.textContent).not.toContain('有限上下文');
    view.remove();
  });

  it('拖动标题栏更新 host left/top 并 clamp，select 和 button 不启动拖动', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    let root: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = original.call(this, options); return root; });
    const view = new SelectionView(document, new DOMRect(20, 20, 20, 20), { translate: vi.fn(), copy: vi.fn(), close: vi.fn() });
    vi.spyOn(root!.querySelector('.panel')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 220));
    view.open('zh-Hans');
    const before = view.host.style.left;
    root!.querySelector('[name="engine"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 30 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 200 }));
    expect(view.host.style.left).toBe(before);
    root!.querySelector('[data-drag-handle]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 30 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500, clientY: 500 }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(parseFloat(view.host.style.left)).toBeLessThanOrEqual(72);
    expect(parseFloat(view.host.style.top)).toBeLessThanOrEqual(72);
    view.remove();
  });

  it('拒绝脚本触发的不可信翻译按钮 click', () => {
    const translate = vi.fn();
    let capturedRoot: ShadowRoot | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) {
      capturedRoot = original.call(this, options);
      return capturedRoot;
    });
    const view = new SelectionView(document, new DOMRect(0, 0, 10, 10), {
      translate, copy: vi.fn(), close: vi.fn(),
    });

    (capturedRoot!.querySelector('[aria-label="翻译选中内容"]') as HTMLButtonElement).click();

    expect(translate).not.toHaveBeenCalled();
    view.remove();
  });

  it('宿主视觉或位置被篡改时拒绝可信点击授权', () => {
    const translate = vi.fn();
    let capturedRoot: ShadowRoot | undefined;
    let clickListener: EventListener | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { capturedRoot = original.call(this, options); return capturedRoot; });
    const addEventListener = HTMLElement.prototype.addEventListener;
    vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
      if (this.classList.contains('trigger') && type === 'click') clickListener = listener as EventListener;
      return addEventListener.call(this, type, listener, options);
    });
    const view = new SelectionView(document, new DOMRect(10, 10, 20, 20), { translate, copy: vi.fn(), close: vi.fn() });
    view.mount();
    view.host.style.setProperty('opacity', '0', 'important');
    expect(capturedRoot!.querySelector('.trigger')).not.toBeNull();
    clickListener?.({ isTrusted: true, clientX: 31, clientY: 31 } as unknown as MouseEvent);
    expect(translate).not.toHaveBeenCalled();
  });

  it('宿主点击安全相关样式全部使用内联 important', () => {
    const view = new SelectionView(document, new DOMRect(10, 10, 20, 20), {
      translate: vi.fn(), copy: vi.fn(), close: vi.fn(),
    });
    for (const property of ['position', 'z-index', 'left', 'top', 'opacity', 'visibility', 'display', 'pointer-events', 'transform']) {
      expect(view.host.style.getPropertyPriority(property), property).toBe('important');
    }
  });

  it('真实几何与命中栈正常时接受可信点击', () => {
    const translate = vi.fn();
    const close = vi.fn();
    let capturedRoot: ShadowRoot | undefined;
    let clickListener: EventListener | undefined;
    const original = Element.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { capturedRoot = original.call(this, options); return capturedRoot; });
    const addEventListener = HTMLElement.prototype.addEventListener;
    vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
      if (this.classList.contains('trigger') && type === 'click') clickListener = listener as EventListener;
      return addEventListener.call(this, type, listener, options);
    });
    const view = new SelectionView(document, new DOMRect(10, 10, 20, 20), { translate, copy: vi.fn(), close });
    vi.spyOn(view.host, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, 30, 32, 32));
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: vi.fn(() => [view.host]) });
    view.mount();

    clickListener?.({ isTrusted: true, clientX: 31, clientY: 31 } as unknown as MouseEvent);

    expect(translate).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it.each([
    ['opacity', '0', new DOMRect(30, 30, 32, 32)],
    ['transform', 'matrix(1, 0, 0, 1, 10, 0)', new DOMRect(30, 30, 32, 32)],
    ['left', '80px', new DOMRect(80, 30, 32, 32)],
    ['width', '96px', new DOMRect(30, 30, 96, 32)],
  ])('拒绝 %s 篡改并关闭浮层', (property, value, attackedRect) => {
    const translate = vi.fn();
    const close = vi.fn();
    let clickListener: EventListener | undefined;
    const addEventListener = HTMLElement.prototype.addEventListener;
    vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
      if (this.classList.contains('trigger') && type === 'click') clickListener = listener as EventListener;
      return addEventListener.call(this, type, listener, options);
    });
    const view = new SelectionView(document, new DOMRect(10, 10, 20, 20), { translate, copy: vi.fn(), close });
    const rect = vi.spyOn(view.host, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, 30, 32, 32));
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: vi.fn(() => [view.host]) });
    view.mount();
    view.host.style.setProperty(property, value, 'important');
    rect.mockReturnValue(attackedRect);

    clickListener?.({ isTrusted: true, clientX: attackedRect.left + 1, clientY: attackedRect.top + 1 } as unknown as MouseEvent);

    expect(translate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
