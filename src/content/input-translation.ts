interface InputTranslationDependencies {
  getConfig(): Promise<{ activeEngineId: string; preferences: { inputTargetLanguage?: string } }>;
  translate(text: string, engineId: string, targetLanguage: string): Promise<string>;
}

export function registerInputTranslation(dependencies: InputTranslationDependencies) {
  let composing = false;
  let pending = false;
  let disposed = false;
  let invalidatePending: (() => void) | undefined;
  let checkPending: (() => void) | undefined;
  const onCompositionStart = () => { composing = true; invalidatePending?.(); };
  const onCompositionEnd = () => { composing = false; };

  async function onKeyDown(event: KeyboardEvent): Promise<void> {
    if (disposed || !event.isTrusted || event.repeat || event.isComposing || event.keyCode === 229 || composing
      || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey
      || (event.code !== 'KeyX' && event.key.toLowerCase() !== 'x')) return;
    checkPending?.();
    if (pending) { event.preventDefault(); return; }
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element.closest('[inert],[aria-readonly="true"],[aria-disabled="true"]')) return;
    const control = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : undefined;
    let range: Range | undefined;
    let start = 0;
    let end = 0;
    let text: string;
    if (control) {
      if (control.readOnly || control.matches(':disabled') || (control instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(control.type))) return;
      if (control.selectionStart === null || control.selectionEnd === null) return;
      start = control.selectionStart; end = control.selectionEnd;
      text = control.value.slice(start, end);
    } else {
      if (!['', 'true', 'plaintext-only'].includes(element.getAttribute('contenteditable') ?? 'false')) return;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
      range = selection.getRangeAt(0).cloneRange();
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      // 嵌套编辑器、不可编辑岛和表单控件不属于普通富文本选区。
      if ([...element.querySelectorAll('[contenteditable],input,textarea,select,button')].some((node) => range!.intersectsNode(node))) return;
      text = range.toString();
    }
    if (!text.trim() || text.length > 5000) return;
    event.preventDefault();
    pending = true;
    let changed = false;
    const invalidate = () => { changed = true; if (invalidatePending === invalidate) pending = false; };
    invalidatePending = invalidate;
    const snapshot = control ? control.value : element.innerHTML;
    const observer = new MutationObserver(invalidate);
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    element.addEventListener('input', invalidate);
    element.addEventListener('blur', invalidate);
    const current = () => {
      if (disposed || changed || composing || observer.takeRecords().length || !element.isConnected || document.activeElement !== element
        || element.closest('[inert],[aria-readonly="true"],[aria-disabled="true"]')) return false;
      if (control) return !control.readOnly && !control.matches(':disabled') && control.value === snapshot
        && control.selectionStart === start && control.selectionEnd === end
        && (!(control instanceof HTMLInputElement) || ['text', 'search', 'url', 'tel'].includes(control.type));
      const selection = document.getSelection();
      if (!selection || selection.rangeCount !== 1 || element.innerHTML !== snapshot) return false;
      const selected = selection.getRangeAt(0);
      return selected.startContainer === range!.startContainer && selected.startOffset === range!.startOffset
        && selected.endContainer === range!.endContainer && selected.endOffset === range!.endOffset;
    };
    // 选区曾偏离即永久作废；选回原位置也不能恢复旧任务的写入权。
    const onSelectionChange = () => { if (!current()) invalidate(); };
    checkPending = onSelectionChange;
    document.addEventListener('selectionchange', onSelectionChange, true);
    element.addEventListener('select', onSelectionChange);
    try {
      const config = await dependencies.getConfig();
      if (!current()) return;
      const translated = await dependencies.translate(text, config.activeEngineId, config.preferences.inputTargetLanguage ?? 'en');
      if (!translated.trim() || !current()) return;
      const before = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertReplacementText', data: translated });
      if (!element.dispatchEvent(before) || !current()) return;
      if (control) {
        // 调用原生 setter 绕过 React 的 value tracker，再用 input 通知受控表单。
        const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, snapshot.slice(0, start) + translated + snapshot.slice(end));
        control.setSelectionRange(start, start + translated.length);
      } else {
        range!.deleteContents();
        const node = document.createTextNode(translated);
        range!.insertNode(node);
        range!.selectNodeContents(node);
        const selection = document.getSelection()!;
        selection.removeAllRanges(); selection.addRange(range!);
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: translated }));
    } catch {
      // 网络失败、扩展更新或页面拒绝编辑时保留原文，不暴露输入内容。
    } finally {
      observer.disconnect();
      element.removeEventListener('input', invalidate);
      element.removeEventListener('blur', invalidate);
      document.removeEventListener('selectionchange', onSelectionChange, true);
      element.removeEventListener('select', onSelectionChange);
      if (invalidatePending === invalidate) { invalidatePending = undefined; checkPending = undefined; pending = false; }
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('compositionstart', onCompositionStart, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
  return {
    onKeyDown,
    dispose() {
      disposed = true; invalidatePending?.();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('compositionstart', onCompositionStart, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
    },
  };
}
