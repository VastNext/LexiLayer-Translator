import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInputTranslation } from '../../src/content/input-translation';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); document.body.innerHTML = ''; });

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
