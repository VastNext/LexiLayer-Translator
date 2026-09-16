import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInputTranslation } from '../../src/content/input-translation';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks(); });

function getStatus() {
  return document.querySelector<HTMLElement>('[data-lexilayer-input-translation-status]');
}

function setup(html = '<textarea>前你好后</textarea>') {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild as HTMLTextAreaElement;
  element.focus();
  if (element.setSelectionRange) element.setSelectionRange(1, 3);
  let resolve!: (text: string) => void;
  const translate = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
  const getConfig = vi.fn(async () => ({ activeEngineId: 'bing', preferences: { inputTargetLanguage: 'ja' } }));
  const controller = registerInputTranslation({ getConfig, translate });
  cleanups.push(controller.dispose);
  const press = (extra = {}) => controller.onKeyDown({ key: 'X', code: 'KeyX', altKey: true, shiftKey: true, isTrusted: true, preventDefault: vi.fn(), ...extra } as unknown as KeyboardEvent);
  return { element, translate, getConfig, press, resolve: (text: string) => resolve(text) };
}

describe('输入框选区翻译', () => {
  it('触发后显示隔离的翻译中状态且不提前修改内容', async () => {
    const fixture = setup();
    fixture.element.getBoundingClientRect = () => ({ top: 80, right: 300, bottom: 120, left: 100, width: 200, height: 40, x: 100, y: 80, toJSON() {} });
    const pending = fixture.press();
    await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    const status = getStatus();
    expect(status).not.toBeNull();
    expect(status?.shadowRoot).toBeNull();
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-label')).toBe('翻译中…');
    expect(status?.dataset.state).toBe('loading');
    expect(status?.style.top).toBe('44px');
    expect(fixture.element.value).toBe('前你好后');
    fixture.resolve('hello'); await pending;
  });

  it('控件上方空间不足时将状态放在下方', async () => {
    const fixture = setup();
    fixture.element.getBoundingClientRect = () => ({ top: 8, right: 300, bottom: 48, left: 100, width: 200, height: 40, x: 100, y: 8, toJSON() {} });
    const pending = fixture.press();
    await vi.waitFor(() => expect(getStatus()?.style.top).toBe('56px'));
    fixture.resolve('hello'); await pending;
  });

  it('测量浮层后在窄视口内钳制位置并优先选择空间足够的上方', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if ((this as HTMLElement).dataset.lexilayerInputTranslationStatus !== undefined) {
        return { top: 0, right: 120, bottom: 28, left: 0, width: 120, height: 28, x: 0, y: 0, toJSON() {} };
      }
      return { top: 70, right: 155, bottom: 100, left: 130, width: 25, height: 30, x: 130, y: 70, toJSON() {} };
    });
    vi.stubGlobal('innerWidth', 160); vi.stubGlobal('innerHeight', 120);
    const fixture = setup();
    const pending = fixture.press();
    await vi.waitFor(() => expect(getStatus()?.style.left).toBe('32px'));
    expect(getStatus()?.style.top).toBe('34px');
    fixture.resolve('hello'); await pending;
    vi.unstubAllGlobals();
  });

  it('减少动态效果时停止 spinner 动画', async () => {
    const attachShadow = HTMLElement.prototype.attachShadow;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement) {
      return attachShadow.call(this, { mode: 'open' });
    });
    const fixture = setup(); const pending = fixture.press();
    await vi.waitFor(() => expect(getStatus()).not.toBeNull());
    expect(getStatus()?.shadowRoot?.querySelector('style')?.textContent).toMatch(/prefers-reduced-motion[\s\S]*animation:\s*none/);
    fixture.resolve('hello'); await pending;
  });

  it.each([
    ['成功', 'hello', '翻译完成', 'success'],
    ['空响应', '', '翻译失败，原文已保留', 'error'],
  ])('%s 后显示短暂终态并移除', async (_name, translated, label, state) => {
    vi.useFakeTimers();
    const fixture = setup();
    const pending = fixture.press();
    await vi.advanceTimersByTimeAsync(0);
    fixture.resolve(translated); await pending;
    expect(getStatus()?.getAttribute('aria-label')).toBe(label);
    expect(getStatus()?.dataset.state).toBe(state);
    await vi.advanceTimersByTimeAsync(1600);
    expect(getStatus()).toBeNull();
    vi.useRealTimers();
  });

  it('异常失败显示保留原文状态', async () => {
    const fixture = setup();
    fixture.translate.mockRejectedValueOnce(new Error('失败'));
    await fixture.press();
    expect(fixture.element.value).toBe('前你好后');
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译失败，原文已保留');
    expect(getStatus()?.dataset.state).toBe('error');
  });

  it.each(['内容', '选区', '焦点'])('%s变化时显示取消原因', async (reason) => {
    const fixture = setup(); const pending = fixture.press();
    await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalled());
    if (reason === '内容') fixture.element.dispatchEvent(new Event('input'));
    if (reason === '选区') { fixture.element.setSelectionRange(0, 1); document.dispatchEvent(new Event('selectionchange')); }
    if (reason === '焦点') fixture.element.blur();
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译已取消');
    expect(getStatus()?.dataset.state).toBe('cancelled');
    fixture.resolve('旧译文'); await pending;
  });

  it('旧任务结束不得覆盖新任务的翻译中状态', async () => {
    const fixture = setup();
    let finishOld!: (text: string) => void;
    let finishNew!: (text: string) => void;
    fixture.translate
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    const old = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    fixture.element.dispatchEvent(new Event('input'));
    const next = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(2));
    finishOld('旧译文'); await old;
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译中…');
    expect(getStatus()?.dataset.state).toBe('loading');
    finishNew('新译文'); await next;
  });

  it.each([
    ['移除控件', (element: HTMLTextAreaElement) => element.remove()],
    ['程序化修改值', (element: HTMLTextAreaElement) => { element.value = '程序改写'; }],
    ['程序化修改选区', (element: HTMLTextAreaElement) => element.setSelectionRange(0, 1)],
    ['切换只读', (element: HTMLTextAreaElement) => { element.readOnly = true; }],
    ['切换禁用', (element: HTMLTextAreaElement) => { element.disabled = true; }],
  ])('%s即使没有事件也进入取消终态并移除', async (_name, change) => {
    vi.useFakeTimers();
    const fixture = setup(); const pending = fixture.press();
    await vi.advanceTimersByTimeAsync(0);
    change(fixture.element);
    fixture.resolve('hello'); await pending;
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译已取消');
    await vi.advanceTimersByTimeAsync(1600);
    expect(getStatus()).toBeNull();
  });

  it('待处理 mutation record 永久取消任务并定时移除', async () => {
    vi.useFakeTimers();
    const fixture = setup('<div contenteditable="true">你好</div>');
    const range = document.createRange(); range.selectNodeContents(fixture.element);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const pending = fixture.press(); await vi.advanceTimersByTimeAsync(0);
    fixture.element.firstChild!.textContent = '改动';
    fixture.resolve('hello'); await pending;
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译已取消');
    await vi.advanceTimersByTimeAsync(1600);
    expect(getStatus()).toBeNull();
  });

  it('自身提交的 input 不产生取消状态，ARIA 状态仅从加载进入成功', async () => {
    const fixture = setup(); const pending = fixture.press();
    await vi.waitFor(() => expect(getStatus()?.getAttribute('aria-label')).toBe('翻译中…'));
    const labels: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'aria-label') labels.push(record.oldValue ?? '');
      }
    });
    observer.observe(getStatus()!, { attributes: true, attributeFilter: ['aria-label'], attributeOldValue: true });
    fixture.resolve('hello'); await pending; await Promise.resolve(); observer.disconnect();
    expect(labels).toEqual(['翻译中…']);
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译完成');
  });

  it.each(['回滚', '改写'])('站点 input handler 同步%s提交结果时不报告成功', async (behavior) => {
    const fixture = setup();
    fixture.element.addEventListener('input', () => {
      fixture.element.value = behavior === '回滚' ? '前你好后' : '站点改写';
      fixture.element.setSelectionRange(1, 3);
    });
    const pending = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalled());
    fixture.resolve('hello'); await pending;
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译已取消');
    expect(getStatus()?.dataset.state).toBe('cancelled');
  });

  it('状态宿主被页面删除后重复快捷键恢复单实例提示且不重复请求', async () => {
    const fixture = setup(); const pending = fixture.press();
    await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    getStatus()!.remove();
    await fixture.press();
    expect(fixture.translate).toHaveBeenCalledTimes(1);
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译中…');
    expect(document.querySelectorAll('[data-lexilayer-input-translation-status]')).toHaveLength(1);
    fixture.resolve('hello'); await pending;
  });

  it('重复快捷键不重复请求且维持同一个提示', async () => {
    const fixture = setup();
    const first = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    const status = getStatus();
    await fixture.press();
    expect(fixture.translate).toHaveBeenCalledTimes(1);
    expect(getStatus()).toBe(status);
    expect(getStatus()?.getAttribute('aria-label')).toBe('翻译中…');
    fixture.resolve('hello'); await first;
  });

  it('dispose 清理状态宿主和终态计时器', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const pending = fixture.press(); await vi.advanceTimersByTimeAsync(0);
    fixture.resolve('hello'); await pending;
    expect(getStatus()).not.toBeNull();
    cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(getStatus()).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(getStatus()).toBeNull();
    vi.useRealTimers();
  });

  it.each(['textarea', 'contenteditable'])('%s 选区移开又选回永久作废旧结果', async (kind) => {
    const fixture = setup(kind === 'textarea' ? undefined : '<div contenteditable="true">前你好后</div>');
    const select = (start: number, end: number) => {
      if (kind === 'textarea') fixture.element.setSelectionRange(start, end);
      else {
        const range = document.createRange(); range.setStart(fixture.element.firstChild!, start); range.setEnd(fixture.element.firstChild!, end);
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      }
      document.dispatchEvent(new Event('selectionchange'));
    };
    select(1, 3);
    const pending = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalled());
    select(0, 1); select(1, 3);
    fixture.resolve('旧译文'); await pending;
    expect(kind === 'textarea' ? fixture.element.value : fixture.element.textContent).toBe('前你好后');
  });

  it.each(['textarea', 'contenteditable'])('%s 改选后立即触发新任务，旧任务不影响新任务', async (kind) => {
    const fixture = setup(kind === 'textarea' ? undefined : '<div contenteditable="true">前你好后</div>');
    const select = (start: number, end: number) => {
      if (kind === 'textarea') fixture.element.setSelectionRange(start, end);
      else {
        const range = document.createRange(); range.setStart(fixture.element.firstChild!, start); range.setEnd(fixture.element.firstChild!, end);
        document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      }
    };
    select(1, 3);
    let finishOld!: (text: string) => void;
    fixture.translate.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    select(0, 1);
    // 不等待异步 selectionchange，快捷键仍须检查当前选区。
    const next = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(2));
    finishOld('旧译文'); await old;
    document.dispatchEvent(new Event('selectionchange'));
    await fixture.press(); expect(fixture.translate).toHaveBeenCalledTimes(2);
    fixture.resolve('新'); await next;
    expect(kind === 'textarea' ? fixture.element.value : fixture.element.textContent).toBe('新你好后');
  });
  it.each(['textarea', 'input'])('仅替换 %s 选区并派发输入事件', async (tag) => {
    const fixture = setup(tag === 'input' ? '<input value="前你好后">' : undefined);
    const input = vi.fn();
    fixture.element.addEventListener('input', input);
    const pending = fixture.press();
    await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledWith('你好', 'bing', 'ja'));
    fixture.resolve('hello'); await pending;
    expect(fixture.element.value).toBe('前hello后');
    expect(input).toHaveBeenCalledTimes(1);
    expect(fixture.element.selectionStart).toBe(1);
    expect(fixture.element.selectionEnd).toBe(6);
  });

  it.each(['<input type="password" value="前你好后">', '<textarea readonly>前你好后</textarea>', '<textarea disabled>前你好后</textarea>'])('不读取受保护控件 %s', async (html) => {
    const fixture = setup(html); await fixture.press(); expect(fixture.getConfig).not.toHaveBeenCalled();
  });

  it.each(['内容', '选区', '焦点', '输入后撤回', '移除', '只读'])('异步期间%s改变不回填', async (change) => {
    const fixture = setup(); const pending = fixture.press();
    await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalled());
    if (change === '内容') fixture.element.value = '改过了';
    if (change === '选区') fixture.element.setSelectionRange(0, 1);
    if (change === '焦点') fixture.element.blur();
    if (change === '输入后撤回') fixture.element.dispatchEvent(new Event('input', { bubbles: true }));
    if (change === '移除') fixture.element.remove();
    if (change === '只读') fixture.element.readOnly = true;
    const value = fixture.element.value;
    fixture.resolve('hello'); await pending;
    expect(fixture.element.value).toBe(value);
  });

  it('过滤伪造、重复、组合输入和多余修饰键', async () => {
    const fixture = setup();
    for (const extra of [{ isTrusted: false }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }]) await fixture.press(extra);
    expect(fixture.getConfig).not.toHaveBeenCalled();
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    await fixture.press(); expect(fixture.getConfig).not.toHaveBeenCalled();
    document.dispatchEvent(new CompositionEvent('compositionend'));
    const first = fixture.press(); await fixture.press();
    await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    fixture.resolve('hello'); await first;
  });

  it('失败和空响应保留原文，之后可以重试', async () => {
    const fixture = setup(); fixture.translate.mockRejectedValueOnce(new Error('失败'));
    await fixture.press(); expect(fixture.element.value).toBe('前你好后');
    const pending = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(2));
    fixture.resolve(''); await pending; expect(fixture.element.value).toBe('前你好后');
  });

  it('页面取消 beforeinput 时保留原文', async () => {
    const fixture = setup();
    fixture.element.addEventListener('beforeinput', (event) => event.preventDefault());
    const pending = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalled());
    fixture.resolve('hello'); await pending; expect(fixture.element.value).toBe('前你好后');
  });

  it('输入改变使旧任务失效后立即允许新任务，旧任务结束不解锁新任务', async () => {
    const fixture = setup();
    let finishOld!: (text: string) => void;
    fixture.translate.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(1));
    fixture.element.dispatchEvent(new Event('input'));
    const next = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledTimes(2));
    finishOld('旧译文'); await old;
    await fixture.press(); expect(fixture.translate).toHaveBeenCalledTimes(2);
    fixture.resolve('新译文'); await next;
    expect(fixture.element.value).toBe('前新译文后');
  });

  it('contenteditable 跨文本节点仅替换选区且译文不解析为 HTML', async () => {
    const fixture = setup('<div contenteditable="true">前<b>你好</b><i>世界</i>后</div>');
    const range = document.createRange();
    range.setStart(fixture.element.querySelector('b')!.firstChild!, 0);
    range.setEnd(fixture.element.querySelector('i')!.firstChild!, 2);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const pending = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalledWith('你好世界', 'bing', 'ja'));
    fixture.resolve('<hello>'); await pending;
    expect(fixture.element.textContent).toBe('前<hello>后'); expect(fixture.element.querySelector('hello')).toBeNull();
  });

  it('contenteditable 改动后恢复相同文本仍拒绝旧结果', async () => {
    const fixture = setup('<div contenteditable="true">你好</div>');
    const range = document.createRange(); range.selectNodeContents(fixture.element);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const pending = fixture.press(); await vi.waitFor(() => expect(fixture.translate).toHaveBeenCalled());
    fixture.element.firstChild!.textContent = '改动'; fixture.element.firstChild!.textContent = '你好';
    fixture.resolve('hello'); await pending; expect(fixture.element.textContent).toBe('你好');
  });
});
