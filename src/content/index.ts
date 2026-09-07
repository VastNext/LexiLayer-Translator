// legacy 渲染器与划词节点样式：由本入口导入以触发构建产出 content.css，
// 供 manifest content_scripts 声明式注入（与 content-inline.css 并列）。
import './content.css';
import type { SiteRule } from '../rules/types';
import type { TranslationRequest, TranslationResult } from '../shared/messages';
import type { TranslationMode } from './dom-renderer';
import type { ScanScope } from './dom-scanner';
import { ParagraphStore, type ParagraphRecord } from './paragraph-store';
import type { SchedulerFailure } from './scheduler';
import { chooseTargetLanguage, normalizeLanguage } from '../shared/languages';
import type { RendererMode } from '../shared/config';

interface PageCommand {
  type: string;
  scope?: ScanScope;
  sourceLanguage?: string;
  targetLanguage?: string;
  mode?: TranslationMode;
  source?: string;
  text?: string;
  placement?: 'before' | 'after';
  engineId?: string;
  rendererMode?: RendererMode;
}

interface PublicEngine { id: string; kind: string; name: string; ready: boolean; capabilities: { streaming: boolean } }
export interface PublicConfig {
  preferences: { sourceLanguage?: string; targetLanguage: string; displayMode: string; translationPosition: 'before' | 'after'; scanScope: ScanScope; rendererMode: RendererMode };
  activeEngineId: string;
  availableEngines: PublicEngine[];
}
interface ObserverChanges { added: HTMLElement[]; invalidated: ParagraphRecord[]; removed?: ParagraphRecord[] }

export interface ProgressState {
  status: 'idle' | 'translating' | 'complete' | 'partial' | 'error';
  completed: number;
  failed: number;
  total: number;
  engineId?: string;
}

export interface ContentControllerDependencies {
  addMessageListener(listener: (message: unknown) => Promise<unknown>): void;
  loadRule(): Promise<SiteRule>;
  scan(rule: SiteRule, scope: ScanScope): HTMLElement[];
  translate(request: TranslationRequest & { taskId: string; engineId: string }): Promise<TranslationResult[]>;
  cancel(taskId: string): Promise<void>;
  getConfig(): Promise<PublicConfig>;
  getPageLanguage(): string;
  showSelectionText(text: string): void;
  schedule(items: ParagraphRecord[][], worker: (paragraphs: ParagraphRecord[]) => Promise<void>, onFailure: (items: ParagraphRecord[], error: unknown) => void): Promise<SchedulerFailure<ParagraphRecord[]>[]>;
  hasWaiting(): boolean;
  beginRender(paragraph: ParagraphRecord): { taskId: string; expectedVersion: number };
  renderLoading(paragraph: ParagraphRecord): void;
  renderTranslation(paragraph: ParagraphRecord, translation: string, options: { mode: TranslationMode; placement?: 'before' | 'after'; taskId: string; expectedVersion: number }): boolean;
  renderError(paragraph: ParagraphRecord, error: string): void;
  restore(paragraph: ParagraphRecord): void;
  setRendererMode?(mode: RendererMode): void;
  cleanupPage(): void;
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
    const progress = { status, completed, failed, total: paragraphs.size, ...(lastCommand.engineId ? { engineId: lastCommand.engineId } : {}) };
    const key = `${status}:${completed}:${failed}:${progress.total}:${progress.engineId ?? ''}`;
    if (key === lastProgressKey) return;
    lastProgressKey = key;
    dependencies.report(progress);
  }

  function reportCurrent(): void {
    const completed = completedIds.size;
    const failed = failedIds.size;
    const isTranslating = dependencies.hasWaiting() || (completed + failed < paragraphs.size);
    report(isTranslating ? 'translating' : failed ? completed ? 'partial' : 'error' : 'complete', completed, failed);
  }

  async function resolveCommand(command: PageCommand): Promise<PageCommand> {
    const config = await dependencies.getConfig();
    const preferences = config.preferences;
    const sourceLanguage = normalizeLanguage(command.sourceLanguage ?? preferences.sourceLanguage ?? (dependencies.getPageLanguage() || 'auto'));
    const preferred = command.targetLanguage ?? preferences.targetLanguage;
    const targetLanguage = chooseTargetLanguage(sourceLanguage, preferred === 'auto' ? (preferences.targetLanguage === 'auto' ? 'en' : preferences.targetLanguage) : preferred);
    return {
      ...command,
      sourceLanguage,
      targetLanguage,
      mode: command.mode ?? (preferences.displayMode === 'translation' ? 'translation-only' : 'bilingual'),
      placement: command.placement ?? preferences.translationPosition,
      scope: command.scope ?? preferences.scanScope,
      engineId: command.engineId ?? config.activeEngineId,
      rendererMode: preferences.rendererMode ?? 'legacy',
    };
  }

  function readableError(error: unknown): string {
    return error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '翻译失败，请重试';
  }

  // 校验 token 是否仍是当前任务：taskId 与版本都必须匹配，缺失结果与渲染器拒绝
  // 均以同一把尺子判断，避免把旧任务的迟到结果/失败误算到新任务头上。
  function isCurrentToken(paragraph: ParagraphRecord, token: { taskId: string; expectedVersion: number }): boolean {
    return token.taskId === paragraph.currentTaskId && token.expectedVersion === paragraph.version;
  }

  function markFailed(items: ParagraphRecord[], message: string, tokens?: Map<string, { taskId: string; expectedVersion: number }>): void {
    const activeItems = items.filter((paragraph) => {
      if (!paragraphs.has(paragraph.id) || !paragraph.element.isConnected) return false;
      if (tokens) {
        const token = tokens.get(paragraph.id);
        if (!token || !isCurrentToken(paragraph, token)) return false;
      } else if (completedIds.has(paragraph.id)) return false;
      return true;
    });
    for (const paragraph of activeItems) dependencies.renderError(paragraph, message);
    for (const paragraph of activeItems) { completedIds.delete(paragraph.id); failedIds.add(paragraph.id); }
  }

  // 开启新翻译代际：作废旧队列与旧任务，返回代际号；已被新命令抢占时返回 undefined。
  async function beginSession(): Promise<number | undefined> {
    const currentGeneration = ++generation;
    const previousTaskId = activeTaskId;
    activeTaskId = undefined;
    if (previousTaskId || active) dependencies.stopObserver();
    if (previousTaskId) await dependencies.cancel(previousTaskId);
    return currentGeneration === generation ? currentGeneration : undefined;
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
    const failures = await dependencies.schedule(batches, async (batchParagraphs) => {
      if (currentGeneration !== generation) return;
      const activeBatch = batchParagraphs.filter((paragraph) => paragraphs.has(paragraph.id) && paragraph.element.isConnected);
      if (activeBatch.length === 0) return;
      const tokens = new Map(activeBatch.map((paragraph) => [paragraph.id, dependencies.beginRender(paragraph)]));
      let results: TranslationResult[];
      try {
        results = await dependencies.translate({
          taskId, engineId: lastCommand.engineId!, sourceLanguage: lastCommand.sourceLanguage ?? 'auto',
          targetLanguage: lastCommand.targetLanguage!, segments: activeBatch.map((paragraph) => ({ id: paragraph.id, text: paragraph.sourceText })),
        });
      } catch (error) {
        if (currentGeneration !== generation) return;
        markFailed(activeBatch, readableError(error), tokens);
        reportCurrent();
        return;
      }
      if (currentGeneration !== generation) return;
      const byId = new Map(results.map((result) => [result.id, result.text]));
      for (const paragraph of activeBatch) {
        if (!paragraphs.has(paragraph.id) || !paragraph.element.isConnected) continue;
        const token = tokens.get(paragraph.id)!;
        const isCurrent = isCurrentToken(paragraph, token);
        const text = byId.get(paragraph.id);
        // 缺失结果或渲染器拒绝时统一收口：stale token 静默忽略（由接管它的新任务收口），
        // 当前 token 被拒说明挂载已失效，必须明确错误收口，不得永久停留在 loading/translating。
        const accepted = text !== undefined && dependencies.renderTranslation(paragraph, text, { mode: lastCommand.mode!, placement: lastCommand.placement, ...token });
        if (!accepted) {
          if (!isCurrent) continue;
          dependencies.renderError(paragraph, '翻译失败，请重试');
          completedIds.delete(paragraph.id);
          failedIds.add(paragraph.id);
          failed += 1;
          continue;
        }
        failedIds.delete(paragraph.id);
        completedIds.add(paragraph.id);
        completed += 1;
      }
      if (currentGeneration === generation) reportCurrent();
    }, (items, error) => {
      // 批次请求失败（含滚动后才可见的晚批）即时渲染错误并刷新进度；
      // 代际已更替的旧队列失败在此被隔离，不会污染新任务。
      if (currentGeneration !== generation) return;
      markFailed(items, readableError(error));
      reportCurrent();
    });
    if (currentGeneration !== generation) return { completed: 0, failed: 0 };
    for (const failure of failures) markFailed(failure.item, readableError(failure.error));
    return { completed, failed: failed + failures.reduce((count, failure) => count + failure.item.length, 0) };
  }

  function createObserverHandler(currentGeneration: number, taskId: string): (changes: ObserverChanges) => Promise<void> {
    return async ({ added, invalidated, removed = [] }) => {
      if (currentGeneration !== generation) return;
      if (added.length === 0 && invalidated.length === 0 && removed.length === 0) return;
      const removedSet = new Set(removed);
      for (const paragraph of removed) { paragraphs.delete(paragraph.id); completedIds.delete(paragraph.id); failedIds.delete(paragraph.id); }
      const changed: ParagraphRecord[] = [];
      for (const paragraph of invalidated) {
        if (removedSet.has(paragraph) || !paragraph.element.isConnected) continue;
        completedIds.delete(paragraph.id); failedIds.delete(paragraph.id);
        dependencies.restore(paragraph);
        changed.push(store.refresh(paragraph.element));
      }
      for (const element of added) {
        if (!element.isConnected) continue;
        const paragraph = store.getOrCreate(element);
        if (paragraph.sourceText) changed.push(paragraph);
      }
      for (const paragraph of changed) { paragraphs.set(paragraph.id, paragraph); dependencies.renderLoading(paragraph); }
      if (currentGeneration === generation) reportCurrent();
      if (changed.length) await processParagraphs(changed, currentGeneration, taskId);
      if (currentGeneration === generation) reportCurrent();
    };
  }

  async function restore(): Promise<void> {
    generation += 1;
    dependencies.stopObserver();
    if (activeTaskId) await dependencies.cancel(activeTaskId);
    for (const paragraph of paragraphs.values()) dependencies.restore(paragraph);
    dependencies.cleanupPage();
    paragraphs.clear();
    completedIds.clear();
    failedIds.clear();
    active = false;
    activeTaskId = undefined;
    report('idle');
  }

  async function translate(command: PageCommand): Promise<void> {
    const currentGeneration = await beginSession();
    if (currentGeneration === undefined) return;
    command = await resolveCommand(command);
    if (currentGeneration !== generation) return;
    lastCommand = { ...lastCommand, ...command, type: 'translate-page' };
    // 渲染器模式在每次全新页面翻译时读取一次：会话内动态更新与重试固定本次模式。
    dependencies.setRendererMode?.(command.rendererMode ?? 'legacy');
    for (const paragraph of paragraphs.values()) dependencies.restore(paragraph);
    dependencies.cleanupPage();
    paragraphs.clear();
    store.clear();
    completedIds.clear();
    failedIds.clear();
    const taskId = `page-${currentGeneration}`;
    activeTaskId = taskId;
    const rule = await dependencies.loadRule();
    const elements = dependencies.scan(rule, command.scope ?? lastCommand.scope ?? 'main-content');
    for (const element of elements) {
      const paragraph = store.refresh(element);
      if (!paragraph.sourceText) continue;
      paragraphs.set(paragraph.id, paragraph);
      dependencies.renderLoading(paragraph);
    }
    active = true;
    dependencies.startObserver(rule, store, command.scope ?? 'main-content', createObserverHandler(currentGeneration, taskId));
    report('translating');

    try {
      await processParagraphs([...paragraphs.values()], currentGeneration, taskId);
      if (currentGeneration !== generation) return;
      reportCurrent();
    } catch (error) {
      if (currentGeneration !== generation) return;
      markFailed([...paragraphs.values()], readableError(error));
      report('error', 0, paragraphs.size);
    }
  }

  // 重试只重发失败段落：保留已成功译文与页面状态，避免整页重翻浪费资源。
  async function retryFailed(): Promise<void> {
    if (!active) return;
    const failedParagraphs = [...failedIds]
      .map((id) => paragraphs.get(id))
      .filter((paragraph): paragraph is ParagraphRecord => paragraph !== undefined);
    if (failedParagraphs.length === 0) return;
    const currentGeneration = await beginSession();
    if (currentGeneration === undefined) return;
    const taskId = `page-${currentGeneration}`;
    activeTaskId = taskId;
    const rule = await dependencies.loadRule();
    if (currentGeneration !== generation) return;

    // 在 await beginSession() 和 await dependencies.loadRule() 期间，可能某些失败节点已被 DOM 移除
    const activeFailedParagraphs: ParagraphRecord[] = [];
    for (const paragraph of failedParagraphs) {
      if (!paragraph.element.isConnected || !paragraphs.has(paragraph.id)) {
        paragraph.wrapper?.remove();
        paragraphs.delete(paragraph.id);
        completedIds.delete(paragraph.id);
        failedIds.delete(paragraph.id);
        store.delete(paragraph.element);
      } else {
        activeFailedParagraphs.push(paragraph);
      }
    }

    dependencies.startObserver(rule, store, lastCommand.scope ?? 'main-content', createObserverHandler(currentGeneration, taskId));
    if (activeFailedParagraphs.length === 0) {
      reportCurrent();
      return;
    }

    // 重试前刷新原文，段落文本若已变化则按当前文本重发。
    for (const paragraph of activeFailedParagraphs) {
      store.refresh(paragraph.element);
      dependencies.renderLoading(paragraph);
    }
    report('translating', completedIds.size, failedIds.size);
    try {
      await processParagraphs(activeFailedParagraphs, currentGeneration, taskId);
      if (currentGeneration !== generation) return;
      reportCurrent();
    } catch (error) {
      if (currentGeneration !== generation) return;
      markFailed(activeFailedParagraphs, readableError(error));
      reportCurrent();
    }
  }

  async function onMessage(message: unknown): Promise<unknown> {
    if (!isPageCommand(message)) return undefined;
    if (message.type === 'restore-page') return restore();
    if (message.type === 'toggle-page-translation') return active ? restore() : translate(message);
    if (message.type === 'translate-page') return translate(message);
    if (message.type === 'retry-page-translation') return retryFailed();
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
