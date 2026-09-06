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
  schedule(items: ParagraphRecord[][], worker: (paragraphs: ParagraphRecord[]) => Promise<void>): Promise<SchedulerFailure<ParagraphRecord[]>[]>;
  hasWaiting(): boolean;
  beginRender(paragraph: ParagraphRecord): { taskId: string; expectedVersion: number };
  renderLoading(paragraph: ParagraphRecord): void;
  renderTranslation(paragraph: ParagraphRecord, translation: string, options: { mode: TranslationMode; placement?: 'before' | 'after'; taskId: string; expectedVersion: number }): void;
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
    report(dependencies.hasWaiting() ? 'translating' : failed ? completed ? 'partial' : 'error' : 'complete', completed, failed);
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

  // 提取面向用户的稳定错误消息，避免把英文异常或敏感内容渲染到页面。
  function readableError(error: unknown): string {
    return error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '翻译失败，请重试';
  }

  function markFailed(items: ParagraphRecord[], message: string): void {
    for (const paragraph of items) dependencies.renderError(paragraph, message);
    for (const paragraph of items) { completedIds.delete(paragraph.id); failedIds.add(paragraph.id); }
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
    const failures = await dependencies.schedule(batches, async (paragraphs) => {
      if (currentGeneration !== generation) return;
      const tokens = new Map(paragraphs.map((paragraph) => [paragraph.id, dependencies.beginRender(paragraph)]));
      const results = await dependencies.translate({
        taskId, engineId: lastCommand.engineId!, sourceLanguage: lastCommand.sourceLanguage ?? 'auto',
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
    for (const failure of failures) markFailed(failure.item, readableError(failure.error));
    return { completed, failed: failed + failures.reduce((count, failure) => count + failure.item.length, 0) };
  }

  function createObserverHandler(currentGeneration: number, taskId: string): (changes: ObserverChanges) => Promise<void> {
    return async ({ added, invalidated, removed = [] }) => {
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
    dependencies.startObserver(rule, store, lastCommand.scope ?? 'main-content', createObserverHandler(currentGeneration, taskId));
    // 重试前刷新原文，段落文本若已变化则按当前文本重发。
    for (const paragraph of failedParagraphs) {
      store.refresh(paragraph.element);
      dependencies.renderLoading(paragraph);
    }
    report('translating', completedIds.size, failedIds.size);
    try {
      await processParagraphs(failedParagraphs, currentGeneration, taskId);
      if (currentGeneration !== generation) return;
      reportCurrent();
    } catch (error) {
      if (currentGeneration !== generation) return;
      markFailed(failedParagraphs, readableError(error));
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
