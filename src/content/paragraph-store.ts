export interface ParagraphRecord {
  id: string;
  element: HTMLElement;
  sourceText: string;
  version: number;
  currentTaskId?: string;
  wrapper?: HTMLElement;
  sourceWrapper?: HTMLElement;
  originalHidden: HTMLElement['hidden'];
}

function readSourceText(element: HTMLElement): string {
  const source = element.querySelector<HTMLElement>(':scope > [data-vast-source]') ?? element;
  return source.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export class ParagraphStore {
  private readonly records = new WeakMap<HTMLElement, ParagraphRecord>();
  private nextId = 1;

  get(element: HTMLElement): ParagraphRecord | undefined {
    return this.records.get(element);
  }

  getOrCreate(element: HTMLElement): ParagraphRecord {
    const existing = this.records.get(element);
    if (existing) return existing;

    const record: ParagraphRecord = {
      id: `paragraph-${this.nextId++}`,
      element,
      sourceText: readSourceText(element),
      version: 1,
      originalHidden: element.hidden,
    };
    this.records.set(element, record);
    return record;
  }

  refresh(element: HTMLElement): ParagraphRecord {
    const record = this.getOrCreate(element);
    const sourceText = readSourceText(element);
    if (sourceText !== record.sourceText) {
      record.sourceText = sourceText;
      record.version += 1;
    }
    return record;
  }

  delete(element: HTMLElement): ParagraphRecord | undefined {
    const record = this.records.get(element);
    this.records.delete(element);
    if (record) {
      record.wrapper = undefined;
      record.sourceWrapper = undefined;
      record.currentTaskId = undefined;
    }
    return record;
  }
}
