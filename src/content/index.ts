import type { SiteRule } from '../rules/types';
import type { TranslationRequest, TranslationResult } from '../shared/messages';
import { DomRenderer, type TranslationMode } from './dom-renderer';
import { scanParagraphElements, type ScanScope } from './dom-scanner';
import { DynamicPageObserver } from './dynamic-observer';
import { ParagraphStore, type ParagraphRecord } from './paragraph-store';
import { matchSiteRule } from './rule-matcher';
import { registerSelectionController } from './selection-controller';
import { ParagraphVisibilityBatchQueue, type SchedulerFailure } from './scheduler';
import { chooseTargetLanguage, normalizeLanguage } from '../shared/languages';

interface PageCommand {
  type: string;
  scope?: ScanScope;
  sourceLanguage?: string;
  targetLanguage?: string;
  mode?: TranslationMode;
  source?: string;
  text?: string;
  placement?: 'before' | 'after';
}

interface PublicConfig { targetLanguage: string; displayMode: string; translationPosition: 'before' | 'after'; scanScope: ScanScope }
interface ObserverChanges { added: HTMLElement[]; invalidated: ParagraphRecord[]; removed?: ParagraphRecord[] }

export interface ProgressState {
  status: 'idle' | 'translating' | 'complete' | 'partial' | 'error';
  completed: number;
  failed: number;
  total: number;
}

export interface ContentControllerDependencies {
  addMessageListener(listener: (message: unknown) => Promise<unknown>): void;
  loadRule(): Promise<SiteRule>;
  scan(rule: SiteRule, scope: ScanScope): HTMLElement[];
  translate(request: TranslationRequest & { taskId: string }): Promise<TranslationResult[]>;
  cancel(taskId: string): Promise<void>;
  getConfig(): Promise<PublicConfig>;
  getPageLanguage(): string;
  showSelectionText(text: string): void;
  schedule(items: ParagraphRecord[][], worker: (paragraphs: ParagraphRecord[]) => Promise<void>): Promise<SchedulerFailure<ParagraphRecord[]>[]>;
  beginRender(paragraph: ParagraphRecord): { taskId: string; expectedVersion: number };
  renderLoading(paragraph: ParagraphRecord): void;
  renderTranslation(paragraph: ParagraphRecord, translation: string, options: { mode: TranslationMode; placement?: 'before' | 'after'; taskId: string; expectedVersion: number }): void;
  renderError(paragraph: ParagraphRecord, error: string): void;
  restore(paragraph: ParagraphRecord): void;
  startObserver(rule: SiteRule, store: ParagraphStore, scope: ScanScope, onChanges: (changes: ObserverChanges) => Promise<void>): void;
  stopObserver(): void;
  report(progress: ProgressState): void;
}

function isPageCommand(value: unknown): value is PageCommand {
  return typeof value === 'object' && value !== null && typeof (value as PageCommand).type === 'string';
}

export function createContentController(dependencies: ContentControllerDependencies) {
  const store = new ParagraphStore();
  const paragraphs = new Map<string, ParagraphRecord>();
  const completedIds = new Set<string>();
  const failedIds = new Set<string>();
  let active = false;
  let generation = 0;
  let activeTaskId: string | undefined;
  let lastCommand: PageCommand = { type: 'translate-page' };
  let lastProgressKey = '';

  function report(status: ProgressState['status'], completed = 0, failed = 0): void {
    const progress = { status, completed, failed, total: paragraphs.size };
    const key = `${status}:${completed}:${failed}:${progress.total}`;
    if (key === lastProgressKey) return;
    lastProgressKey = key;
    dependencies.report(progress);
  }

  function reportCurrent(): void {
    const completed = completedIds.size;
    const failed = failedIds.size;
    report(failed ? completed ? 'partial' : 'error' : 'complete', completed, failed);
  }

  async function resolveCommand(command: PageCommand): Promise<PageCommand> {
    const config = await dependencies.getConfig();
    const sourceLanguage = normalizeLanguage(command.sourceLanguage ?? (dependencies.getPageLanguage() || 'auto'));
    const preferred = command.targetLanguage ?? config.targetLanguage;
    const targetLanguage = chooseTargetLanguage(sourceLanguage, preferred === 'auto' ? (config.targetLanguage === 'auto' ? 'en' : config.targetLanguage) : preferred);
    return {
      ...command,
      sourceLanguage,
      targetLanguage,
      mode: command.mode ?? (config.displayMode === 'translation' ? 'translation-only' : 'bilingual'),
      placement: command.placement ?? config.translationPosition,
      scope: command.scope ?? config.scanScope,
    };
  }

  async function processParagraphs(items: ParagraphRecord[], currentGeneration: number, taskId: string): Promise<{ completed: number; failed: number }> {
    let completed = 0;
    let failed = 0;
    const batches: ParagraphRecord[][] = [];
    let batch: ParagraphRecord[] = [];
    let characters = 0;
    for (const paragraph of items) {
      if (batch.length && (batch.length >= 8 || characters + paragraph.sourceText.length > 6000)) {
        batches.push(batch); batch = []; characters = 0;
      }
      batch.push(paragraph); characters += paragraph.sourceText.length;
    }
    if (batch.length) batches.push(batch);
    const failures = await dependencies.schedule(batches, async (paragraphs) => {
      if (currentGeneration !== generation) return;
      const tokens = new Map(paragraphs.map((paragraph) => [paragraph.id, dependencies.beginRender(paragraph)]));
      const results = await dependencies.translate({
        taskId, sourceLanguage: lastCommand.sourceLanguage ?? 'auto',
        targetLanguage: lastCommand.targetLanguage!, segments: paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.sourceText })),
      });
      if (currentGeneration !== generation) return;
      const byId = new Map(results.map((result) => [result.id, result.text]));
      for (const paragraph of paragraphs) {
        const text = byId.get(paragraph.id);
        if (text === undefined) {
          dependencies.renderError(paragraph, '翻译失败，请重试');
          completedIds.delete(paragraph.id);
          failedIds.add(paragraph.id);
          failed += 1;
          continue;
        }
        dependencies.renderTranslation(paragraph, text, { mode: lastCommand.mode!, placement: lastCommand.placement, ...tokens.get(paragraph.id)! });
        failedIds.delete(paragraph.id);
        completedIds.add(paragraph.id);
        completed += 1;
      }
      if (currentGeneration === generation) reportCurrent();
    });
    if (currentGeneration !== generation) return { completed: 0, failed: 0 };
    for (const failure of failures) {
      const message = failure.error instanceof Error && /^[\u3400-\u9fff]/u.test(failure.error.message) ? failure.error.message : '翻译失败，请重试';
      for (const paragraph of failure.item) dependencies.renderError(paragraph, message);
      for (const paragraph of failure.item) { completedIds.delete(paragraph.id); failedIds.add(paragraph.id); }
    }
    return { completed, failed: failed + failures.reduce((count, failure) => count + failure.item.length, 0) };
  }

  async function restore(): Promise<void> {
    generation += 1;
    dependencies.stopObserver();
    if (activeTaskId) await dependencies.cancel(activeTaskId);
    for (const paragraph of paragraphs.values()) dependencies.restore(paragraph);
    paragraphs.clear();
    completedIds.clear();
    failedIds.clear();
    active = false;
    activeTaskId = undefined;
    report('idle');
  }

  async function translate(command: PageCommand): Promise<void> {
    const currentGeneration = ++generation;
    const previousTaskId = activeTaskId;
    activeTaskId = undefined;
    if (previousTaskId || active) dependencies.stopObserver();
    if (previousTaskId) await dependencies.cancel(previousTaskId);
    if (currentGeneration !== generation) return;
    command = await resolveCommand(command);
    if (currentGeneration !== generation) return;
    lastCommand = { ...lastCommand, ...command, type: 'translate-page' };
    for (const paragraph of paragraphs.values()) dependencies.restore(paragraph);
    completedIds.clear();
    failedIds.clear();
    const taskId = `page-${currentGeneration}`;
    activeTaskId = taskId;
    const rule = await dependencies.loadRule();
    const elements = dependencies.scan(rule, command.scope ?? lastCommand.scope ?? 'main-content');
    for (const element of elements) {
      const paragraph = store.refresh(element);
      paragraphs.set(paragraph.id, paragraph);
      dependencies.renderLoading(paragraph);
    }
    active = true;
    dependencies.startObserver(rule, store, command.scope ?? 'main-content', async ({ added, invalidated, removed = [] }) => {
      if (currentGeneration !== generation) return;
      if (added.length === 0 && invalidated.length === 0 && removed.length === 0) return;
      for (const paragraph of removed) { paragraphs.delete(paragraph.id); completedIds.delete(paragraph.id); failedIds.delete(paragraph.id); }
      const changed: ParagraphRecord[] = [];
      for (const paragraph of invalidated) {
        completedIds.delete(paragraph.id); failedIds.delete(paragraph.id);
        dependencies.restore(paragraph);
        changed.push(store.refresh(paragraph.element));
      }
      for (const element of added) changed.push(store.getOrCreate(element));
      for (const paragraph of changed) { paragraphs.set(paragraph.id, paragraph); dependencies.renderLoading(paragraph); }
      if (changed.length) await processParagraphs(changed, currentGeneration, taskId);
      if (currentGeneration === generation) reportCurrent();
    });
    report('translating');

    try {
      await processParagraphs([...paragraphs.values()], currentGeneration, taskId);
      if (currentGeneration !== generation) return;
      reportCurrent();
    } catch (error) {
      if (currentGeneration !== generation) return;
      const message = error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)
        ? error.message
        : '翻译失败，请重试';
      for (const paragraph of paragraphs.values()) dependencies.renderError(paragraph, message);
      for (const paragraph of paragraphs.values()) { completedIds.delete(paragraph.id); failedIds.add(paragraph.id); }
      report('error', 0, paragraphs.size);
    }
  }

  async function onMessage(message: unknown): Promise<unknown> {
    if (!isPageCommand(message)) return undefined;
    if (message.type === 'restore-page') return restore();
    if (message.type === 'toggle-page-translation') return active ? restore() : translate(message);
    if (message.type === 'translate-page') return translate(message);
    if (message.type === 'retry-page-translation') return translate(lastCommand);
    if (message.type === 'translate-selection' && message.source === 'context-menu' && typeof message.text === 'string') {
      dependencies.showSelectionText(message.text);
    }
    return undefined;
  }

  async function dispose(): Promise<void> {
    generation += 1;
    dependencies.stopObserver();
    const taskId = activeTaskId;
    activeTaskId = undefined;
    active = false;
    if (taskId) await dependencies.cancel(taskId);
  }

  return { register: () => dependencies.addMessageListener(onMessage), onMessage, dispose };
}

export function createRuntimeDependencies(): ContentControllerDependencies {
  const renderer = new DomRenderer();
  let observer: DynamicPageObserver | undefined;
  const visibilityQueues = new Set<ParagraphVisibilityBatchQueue<ParagraphRecord>>();
  return {
    addMessageListener(listener) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        void listener(message).then(sendResponse);
        return true;
      });
    },
    loadRule: () => matchSiteRule(new URL(location.href)),
    scan: (rule, scope) => scanParagraphElements(document, rule, scope),
    async translate(request) {
      const response = await chrome.runtime.sendMessage({ type: 'translate-batch', ...request }) as { ok: boolean; data?: TranslationResult[]; error?: string };
      if (!response.ok) throw new Error(response.error ?? '翻译失败');
      return response.data ?? [];
    },
    async cancel(taskId) { await chrome.runtime.sendMessage({ type: 'cancel-task', taskId }); },
    async getConfig() {
      const response = await chrome.runtime.sendMessage({ type: 'get-public-config' }) as { data?: PublicConfig };
      return response.data ?? { targetLanguage: 'en', displayMode: 'bilingual', translationPosition: 'after', scanScope: 'main-content' };
    },
    getPageLanguage: () => document.documentElement.lang || 'auto',
    showSelectionText: () => undefined,
    async schedule(items, worker) {
      let visibility!: ParagraphVisibilityBatchQueue<ParagraphRecord>;
      visibility = new ParagraphVisibilityBatchQueue(worker, undefined, () => visibilityQueues.delete(visibility));
      visibilityQueues.add(visibility);
      visibility.add(items.flat());
      return visibility.whenIdle();
    },
    beginRender: (paragraph) => renderer.beginTask(paragraph),
    renderLoading: (paragraph) => renderer.renderLoading(paragraph),
    renderTranslation: (paragraph, text, options) => renderer.renderTranslation(paragraph, text, { ...options, placement: options.placement ?? 'after' }),
    renderError: (paragraph, error) => renderer.renderError(paragraph, error),
    restore: (paragraph) => renderer.restore(paragraph),
    startObserver(rule, store, scope, onChanges) {
      observer?.stop();
      observer = new DynamicPageObserver(document.body, {
        debounceMs: 150,
        scan(root) {
          return scanParagraphElements(root, rule, scope);
        },
        store,
        onChanges(changes) {
          for (const paragraph of [...changes.invalidated, ...changes.removed]) {
            for (const queue of visibilityQueues) queue.remove(paragraph.element);
          }
          void onChanges(changes);
        },
      });
      observer.start();
    },
    stopObserver() {
      observer?.stop(); observer = undefined;
      for (const queue of visibilityQueues) queue.disconnect();
      visibilityQueues.clear();
    },
    report(progress) { void chrome.runtime.sendMessage({ type: 'page-progress', progress }); },
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const selection = registerSelectionController();
  const dependencies = createRuntimeDependencies();
  dependencies.showSelectionText = (text) => selection.showText(text);
  createContentController(dependencies).register();
}
