import { languageOptions } from '../shared/languages';
import type { Translator } from '../shared/i18n';
import { engineDisplayName } from '../shared/config';

const selectionMessages: Record<string, string> = {
  selectionTranslate: '翻译选中内容', selectionDialog: '划词翻译', translationEngine: '翻译引擎', targetLanguage: '目标语言',
  limitedContextShort: '有限上下文', actionClose: '关闭', preparing: '准备翻译…', actionCopy: '复制', actionRetry: '重试',
};
const selectionTranslator: Translator = (key) => selectionMessages[key] ?? key;

export interface SelectionViewActions {
  translate(targetLanguage: string, includeContext: boolean, engineId: string): void;
  copy(): void;
  close(): void;
}

export interface SelectionViewHandle {
  readonly host: HTMLElement;
  mount(): void;
  open(targetLanguage: string): void;
  setTargetLanguage(targetLanguage: string): void;
  setIncludeContext(includeContext: boolean): void;
  setEngines(engines: Array<{ id: string; kind: string; name: string; ready: boolean }>, activeEngineId: string): void;
  setResult(value: string): void;
  appendResult(chunk: string): void;
  getResult(): string;
  remove(): void;
}

export class SelectionView {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private result = '';
  private readonly expectedLeft: number;
  private readonly expectedTop: number;
  private readonly expectedWidth = 32;
  private readonly expectedHeight = 32;

  constructor(document: Document, rect: DOMRect, private readonly actions: SelectionViewActions, private readonly t: Translator = selectionTranslator) {
    this.host = document.createElement('div');
    this.host.dataset.vastSelectionHost = '';
    this.host.dataset.vastState = 'ready';
    this.expectedLeft = Math.max(8, rect.right);
    this.expectedTop = Math.max(8, rect.bottom);
    for (const [name, value] of [['position', 'fixed'], ['z-index', '2147483647'], ['left', `${this.expectedLeft}px`], ['top', `${this.expectedTop}px`], ['opacity', '1'], ['visibility', 'visible'], ['display', 'block'], ['pointer-events', 'auto'], ['transform', 'none']] as const) {
      this.host.style.setProperty(name, value, 'important');
    }
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    this.shadow.innerHTML = `
      <style>
        :host{all:initial;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#17201d}
        button,select,input{font:inherit}button{cursor:pointer}
        .trigger{width:32px;height:32px;border:0;border-radius:11px;background:#176b52;color:white;font-weight:800}
        .panel{display:none;width:320px;padding:14px;border:1px solid #c8d8d1;border-radius:16px;background:#f8fbf9;box-shadow:0 18px 50px #10251d35}
        .panel.open{display:block}.top,.actions{display:flex;gap:8px;align-items:center}.top{justify-content:space-between}
        .result{min-height:64px;margin:12px 0;padding:10px;border-radius:10px;background:white;white-space:pre-wrap}
        .actions button{border:1px solid #b8ccc4;border-radius:8px;background:white;padding:6px 9px}
        label{font-size:12px;color:#47645a}
      </style>
      <button class="trigger" aria-label="${this.t('selectionTranslate')}">V</button>
      <section class="panel" role="dialog" aria-label="${this.t('selectionDialog')}">
        <div class="top">
          <select name="engine" aria-label="${this.t('translationEngine')}"><option value="google">Google</option><option value="bing">Bing</option></select>
          <select name="target-language" aria-label="${this.t('targetLanguage')}">
            ${languageOptions.filter(({ value }) => value !== 'auto').map(({ value, label }) => `<option value="${value}">${label}</option>`).join('')}
          </select>
          <label><input name="include-context" type="checkbox" checked> ${this.t('limitedContextShort')}</label>
          <button data-action="close" aria-label="${this.t('actionClose')}">×</button>
        </div>
        <div class="result" data-result>${this.t('preparing')}</div>
        <div class="actions"><button data-action="copy">${this.t('actionCopy')}</button><button data-action="retry">${this.t('actionRetry')}</button></div>
      </section>`;
    this.bind();
  }

  mount(): void {
    this.host.ownerDocument.body.append(this.host);
  }

  open(targetLanguage: string): void {
    this.setTargetLanguage(targetLanguage);
    this.shadow.querySelector('.panel')?.classList.add('open');
  }

  setTargetLanguage(targetLanguage: string): void {
    (this.shadow.querySelector('[name="target-language"]') as HTMLSelectElement).value = targetLanguage;
  }

  setIncludeContext(includeContext: boolean): void {
    (this.shadow.querySelector('[name="include-context"]') as HTMLInputElement).checked = includeContext;
  }

  setEngines(engines: Array<{ id: string; kind: string; name: string; ready: boolean }>, activeEngineId: string): void {
    const select = this.shadow.querySelector('[name="engine"]') as HTMLSelectElement;
    select.replaceChildren(...engines.map((engine) => {
      const option = this.host.ownerDocument.createElement('option');
      option.value = engine.id; option.disabled = !engine.ready; option.textContent = engineDisplayName(engine as Parameters<typeof engineDisplayName>[0]);
      return option;
    }));
    select.value = activeEngineId;
    this.host.dataset.vastReady = '';
  }

  setResult(value: string): void {
    this.result = value;
    this.host.dataset.vastState = value ? (/失败/.test(value) ? 'error' : 'translated') : 'loading';
    const result = this.shadow.querySelector('[data-result]');
    if (result) result.textContent = value;
  }

  appendResult(chunk: string): void {
    if (this.result === '准备翻译…') this.result = '';
    this.setResult(this.result + chunk);
  }

  getResult(): string {
    return this.result;
  }

  remove(): void {
    this.host.remove();
  }

  private bind(): void {
    this.shadow.querySelector('.trigger')?.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (!this.isTrustedGeometry(event as MouseEvent)) return this.actions.close();
      this.open((this.shadow.querySelector('[name="target-language"]') as HTMLSelectElement).value);
      this.requestTranslation();
    });
    this.shadow.querySelector('[data-action="retry"]')?.addEventListener('click', (event) => {
      if (event.isTrusted) this.requestTranslation();
    });
    this.shadow.querySelector('[data-action="copy"]')?.addEventListener('click', () => this.actions.copy());
    this.shadow.querySelector('[data-action="close"]')?.addEventListener('click', () => this.actions.close());
    this.shadow.querySelector('[name="target-language"]')?.addEventListener('change', (event) => {
      if (event.isTrusted) this.requestTranslation();
    });
    this.shadow.querySelector('[name="engine"]')?.addEventListener('change', (event) => {
      if (event.isTrusted) this.requestTranslation();
    });
  }

  private isTrustedGeometry(event: MouseEvent): boolean {
    const view = this.host.ownerDocument.defaultView;
    const style = view?.getComputedStyle(this.host);
    const rect = this.host.getBoundingClientRect();
    if (!style || style.opacity !== '1' || style.visibility !== 'visible' || style.display !== 'block'
      || style.pointerEvents !== 'auto' || style.transform !== 'none') return false;
    if (Math.abs(rect.left - this.expectedLeft) > 2 || Math.abs(rect.top - this.expectedTop) > 2
      || Math.abs(rect.width - this.expectedWidth) > 2 || Math.abs(rect.height - this.expectedHeight) > 2
      || rect.left < 0 || rect.top < 0
      || rect.right > (view?.innerWidth ?? 0) || rect.bottom > (view?.innerHeight ?? 0)) return false;
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return false;
    const top = this.host.ownerDocument.elementsFromPoint(event.clientX, event.clientY)[0];
    return top === this.host;
  }

  private requestTranslation(): void {
    const language = (this.shadow.querySelector('[name="target-language"]') as HTMLSelectElement).value;
    const context = (this.shadow.querySelector('[name="include-context"]') as HTMLInputElement).checked;
    this.setResult('');
    const engineId = (this.shadow.querySelector('[name="engine"]') as HTMLSelectElement).value;
    this.actions.translate(language, context, engineId);
  }
}
