import type { ParagraphRecord } from './paragraph-store';

export type TranslationMode = 'bilingual' | 'translation-only';
export type TranslationPlacement = 'before' | 'after';

export interface RenderTranslationOptions {
  mode: TranslationMode;
  placement: TranslationPlacement;
  expectedVersion: number;
  taskId: string;
}

export class DomRenderer {
  private nextTaskId = 1;

  beginTask(paragraph: ParagraphRecord): Pick<RenderTranslationOptions, 'taskId' | 'expectedVersion'> {
    const taskId = `${paragraph.id}:${this.nextTaskId++}`;
    paragraph.currentTaskId = taskId;
    return { taskId, expectedVersion: paragraph.version };
  }

  renderLoading(paragraph: ParagraphRecord): void {
    this.renderState(paragraph, 'loading', '翻译中…', 'after');
  }

  renderError(paragraph: ParagraphRecord, message: string): void {
    this.renderState(paragraph, 'error', message, 'after');
  }

  renderTranslation(
    paragraph: ParagraphRecord,
    translation: string,
    options: RenderTranslationOptions,
  ): boolean {
    if (!paragraph.element.isConnected
      || options.expectedVersion !== paragraph.version
      || options.taskId !== paragraph.currentTaskId) return false;

    const internal = this.requiresInternalWrapper(paragraph.element);
    this.renderState(paragraph, 'translated', translation, options.placement, internal);
    if (internal) this.setInternalSourceHidden(paragraph, options.mode === 'translation-only');
    else paragraph.element.hidden = options.mode === 'translation-only';
    return true;
  }

  restore(paragraph: ParagraphRecord): void {
    paragraph.wrapper?.remove();
    paragraph.wrapper = undefined;
    if (paragraph.sourceWrapper) {
      paragraph.sourceWrapper.replaceWith(...paragraph.sourceWrapper.childNodes);
      paragraph.sourceWrapper = undefined;
    }
    paragraph.element.hidden = paragraph.originalHidden;
    paragraph.currentTaskId = undefined;
  }

  private renderState(
    paragraph: ParagraphRecord,
    state: 'loading' | 'error' | 'translated',
    text: string,
    placement: TranslationPlacement,
    internal = false,
  ): void {
    const wrapper = paragraph.wrapper ?? paragraph.element.ownerDocument.createElement('div');
    wrapper.dataset.vastTranslator = '';
    wrapper.dataset.vastState = state;
    wrapper.textContent = text;

    if (internal) {
      const sourceWrapper = this.ensureSourceWrapper(paragraph);
      if (placement === 'before') sourceWrapper.before(wrapper);
      else sourceWrapper.after(wrapper);
    } else if (placement === 'before') paragraph.element.before(wrapper);
    else paragraph.element.after(wrapper);
    paragraph.wrapper = wrapper;
  }

  private requiresInternalWrapper(element: HTMLElement): boolean {
    return ['TD', 'TH', 'LI'].includes(element.tagName);
  }

  private ensureSourceWrapper(paragraph: ParagraphRecord): HTMLElement {
    if (paragraph.sourceWrapper) return paragraph.sourceWrapper;
    const wrapper = paragraph.element.ownerDocument.createElement('div');
    wrapper.dataset.vastSource = '';
    wrapper.append(...paragraph.element.childNodes);
    paragraph.element.append(wrapper);
    paragraph.sourceWrapper = wrapper;
    return wrapper;
  }

  private setInternalSourceHidden(paragraph: ParagraphRecord, hidden: boolean): void {
    this.ensureSourceWrapper(paragraph).hidden = hidden;
  }
}
