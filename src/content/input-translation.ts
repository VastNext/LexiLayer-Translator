interface InputTranslationDependencies {
  getConfig(): Promise<{ activeEngineId: string; preferences: { inputTargetLanguage?: string } }>;
  translate(text: string, engineId: string, targetLanguage: string): Promise<string>;
}

export function registerInputTranslation(dependencies: InputTranslationDependencies) {
  let composing = false;
  let pending = false;
  let disposed = false;
  let taskId = 0;
  let statusHost: HTMLElement | undefined;
  let statusText: HTMLElement | undefined;
  let statusSpinner: HTMLElement | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let invalidatePending: (() => void) | undefined;
  let checkPending: (() => void) | undefined;
  const onCompositionStart = () => { composing = true; invalidatePending?.(); };
  const onCompositionEnd = () => { composing = false; };

  const removeStatus = () => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    statusHost?.remove();
    statusHost = undefined;
    statusText = undefined;
    statusSpinner = undefined;
  };

  const showStatus = (element: HTMLElement, id: number, state: 'loading' | 'success' | 'error' | 'cancelled') => {
    if (disposed || id !== taskId) return;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    if (!statusHost?.isConnected) {
      statusHost = undefined;
      statusText = undefined;
      statusSpinner = undefined;
      statusHost = document.createElement('div');
      statusHost.dataset.lexilayerInputTranslationStatus = '';
      statusHost.setAttribute('role', 'status');
      statusHost.setAttribute('aria-live', 'polite');
      const shadow = statusHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; }
        .status { box-sizing: border-box; display: flex; align-items: center; gap: 7px; min-height: 28px; max-width: min(280px, calc(100vw - 16px)); padding: 5px 10px; border: 1px solid rgba(15, 23, 42, .14); border-radius: 7px; background: rgba(255, 255, 255, .96); box-shadow: 0 4px 14px rgba(15, 23, 42, .14); color: #334155; font: 12px/16px system-ui, sans-serif; white-space: nowrap; }
        .spinner { width: 12px; height: 12px; box-sizing: border-box; border: 2px solid #cbd5e1; border-top-color: #2563eb; border-radius: 50%; animation: spin .7s linear infinite; }
        .status:not([data-state="loading"]) .spinner { display: none; }
        .status[data-state="success"] { color: #166534; }
        .status[data-state="error"] { color: #991b1b; }
        .status[data-state="cancelled"] { color: #475569; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
      `;
      const status = document.createElement('div');
      status.className = 'status';
      statusSpinner = document.createElement('span');
      statusSpinner.className = 'spinner';
      statusSpinner.setAttribute('aria-hidden', 'true');
      statusText = document.createElement('span');
      status.append(statusSpinner, statusText);
      shadow.append(style, status);
      document.documentElement.append(statusHost);
    }
    const labels = {
      loading: '翻译中…',
      success: '翻译完成',
      error: '翻译失败，原文已保留',
      cancelled: '翻译已取消',
    } as const;
    const label = labels[state];
    statusHost.dataset.state = state;
    statusHost.setAttribute('aria-label', label);
    statusText!.textContent = label;
    statusSpinner!.parentElement!.dataset.state = state;
    const rect = element.getBoundingClientRect();
    const statusRect = statusHost.getBoundingClientRect();
    const width = Math.min(statusRect.width || 280, Math.max(0, window.innerWidth - 16));
    const height = statusRect.height || 28;
    const above = rect.top - height - 8;
    const below = rect.bottom + 8;
    const top = above >= 8 || below + height > window.innerHeight - 8 ? above : below;
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, window.innerWidth - width - 8));
    statusHost.style.top = `${Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8))}px`;
    statusHost.style.left = `${left}px`;
    statusHost.style.right = 'auto';
    if (state !== 'loading') statusTimer = setTimeout(() => {
      if (id === taskId) removeStatus();
    }, 1500);
  };

  async function onKeyDown(event: KeyboardEvent): Promise<void> {
    if (disposed || !event.isTrusted || event.repeat || event.isComposing || event.keyCode === 229 || composing
      || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey
      || (event.code !== 'KeyX' && event.key.toLowerCase() !== 'x')) return;
    checkPending?.();
    if (pending) {
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement) showStatus(active, taskId, 'loading');
      return;
    }
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
    const currentTaskId = ++taskId;
    showStatus(element, currentTaskId, 'loading');
    let changed = false;
    let committing = false;
    const invalidate = () => {
      if (changed) return;
      changed = true;
      if (invalidatePending === invalidate) {
        pending = false;
        showStatus(element, currentTaskId, 'cancelled');
      }
    };
    invalidatePending = invalidate;
    const snapshot = control ? control.value : element.innerHTML;
    const observer = new MutationObserver(() => { if (!committing) invalidate(); });
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    const onInput = () => { if (!committing) invalidate(); };
    element.addEventListener('input', onInput);
    element.addEventListener('blur', invalidate);
    const current = () => {
      const mutationPending = observer.takeRecords().length > 0;
      let valid = !disposed && !changed && !composing && !mutationPending && element.isConnected && document.activeElement === element
        && !element.closest('[inert],[aria-readonly="true"],[aria-disabled="true"]');
      if (control) valid = valid && !control.readOnly && !control.matches(':disabled') && control.value === snapshot
        && control.selectionStart === start && control.selectionEnd === end
        && (!(control instanceof HTMLInputElement) || ['text', 'search', 'url', 'tel'].includes(control.type));
      else {
        const selection = document.getSelection();
        valid = valid && Boolean(selection && selection.rangeCount === 1 && element.innerHTML === snapshot);
        if (valid) {
          const selected = selection!.getRangeAt(0);
          valid = selected.startContainer === range!.startContainer && selected.startOffset === range!.startOffset
            && selected.endContainer === range!.endContainer && selected.endOffset === range!.endOffset;
        }
      }
      if (!valid) invalidate();
      return valid;
    };
    // 选区曾偏离即永久作废；选回原位置也不能恢复旧任务的写入权。
    const onSelectionChange = () => { current(); };
    checkPending = onSelectionChange;
    document.addEventListener('selectionchange', onSelectionChange, true);
    element.addEventListener('select', onSelectionChange);
    try {
      const config = await dependencies.getConfig();
      if (!current()) return;
      const translated = await dependencies.translate(text, config.activeEngineId, config.preferences.inputTargetLanguage ?? 'en');
      if (!current()) return;
      if (!translated.trim()) { showStatus(element, currentTaskId, 'error'); return; }
      const before = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertReplacementText', data: translated });
      if (!element.dispatchEvent(before) || !current()) { invalidate(); return; }
      committing = true;
      let committed = false;
      if (control) {
        // 调用原生 setter 绕过 React 的 value tracker，再用 input 通知受控表单。
        const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const expected = snapshot.slice(0, start) + translated + snapshot.slice(end);
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, expected);
        control.setSelectionRange(start, start + translated.length);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: translated }));
        committed = element.isConnected && document.activeElement === element && !control.readOnly && !control.matches(':disabled')
          && control.value === expected && control.selectionStart === start && control.selectionEnd === start + translated.length;
      } else {
        range!.deleteContents();
        const node = document.createTextNode(translated);
        range!.insertNode(node);
        range!.selectNodeContents(node);
        const selection = document.getSelection()!;
        selection.removeAllRanges(); selection.addRange(range!);
        observer.takeRecords();
        const expected = element.innerHTML;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: translated }));
        committed = element.isConnected && document.activeElement === element && element.innerHTML === expected && node.isConnected;
      }
      if (observer.takeRecords().length) committed = false;
      committing = false;
      if (!committed) { invalidate(); return; }
      showStatus(element, currentTaskId, 'success');
    } catch {
      // 网络失败、扩展更新或页面拒绝编辑时保留原文，不暴露输入内容。
      if (!changed) showStatus(element, currentTaskId, 'error');
    } finally {
      observer.disconnect();
      element.removeEventListener('input', onInput);
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
      removeStatus();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('compositionstart', onCompositionStart, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
    },
  };
}
