// 字幕翻译管线：youtube-tlang（重放 tlang 轨，同文检测）→ current-engine（复用后台
// translate-batch，分批渐进回调）→ 双失败仅原文。全链路显式检测静默失败（pot 空 body）。

import { buildReplayUrl, hasTranslation, parseJson3, zipCues, type SubtitleCue, type DualSubtitleCue } from './timedtext';
import type { VideoSubtitleEngine } from '../../shared/config';

export interface SubtitleSegment { id: string; text: string }

export interface SubtitleTranslateDeps {
  fetchText(url: string): Promise<string>;
  // 由装配层实现：调用后台 translate-batch（taskId 用于页面级任务隔离），结果按 segment id 回传。
  translateBatch(segments: SubtitleSegment[], sourceLanguage: string, targetLanguage: string, engineId: string, taskId: string, onPartial: (translations: Map<string, string>) => void): Promise<void>;
}

export interface SubtitleTranslateOptions {
  engine: VideoSubtitleEngine;
  engineId: string;
  taskIdPrefix: string;
  capturedUrl: string;
  sourceLanguage: string;
  targetLanguage: string;
  cues: SubtitleCue[];
  onPartial?: (translations: Map<number, string>) => void;
}

export interface SubtitleTranslateResult {
  status: 'translated' | 'untranslated';
  cues: DualSubtitleCue[];
}

const MAX_BATCH_SEGMENTS = 8;
const MAX_BATCH_CHARACTERS = 6000;

// current-engine：分批（8 段/6000 字符，与页面控制器一致）顺序调用后台；
// 单批失败该批保持未翻译，不中断后续批次。
async function translateWithEngine(
  deps: SubtitleTranslateDeps,
  options: SubtitleTranslateOptions,
): Promise<Map<number, string>> {
  const translations = new Map<number, string>();
  let batchSequence = 0;
  let batch: SubtitleSegment[] = [];
  let indexes: number[] = [];
  let characters = 0;

  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const currentSegments = batch;
    const currentIndexes = indexes;
    batch = [];
    indexes = [];
    characters = 0;
    batchSequence += 1;
    try {
      await deps.translateBatch(currentSegments, options.sourceLanguage, options.targetLanguage, options.engineId, `${options.taskIdPrefix}-${batchSequence}`, (partial) => {
        const mapped = new Map<number, string>();
        partial.forEach((text, id) => {
          const position = currentSegments.findIndex((segment) => segment.id === id);
          if (position < 0) return;
          translations.set(currentIndexes[position], text);
          mapped.set(currentIndexes[position], text);
        });
        if (mapped.size) options.onPartial?.(mapped);
      });
    } catch {
      // 批次失败：该批保持未翻译，继续后续批次。
    }
  };

  for (const [index, cue] of options.cues.entries()) {
    if (batch.length >= MAX_BATCH_SEGMENTS || characters + cue.text.length > MAX_BATCH_CHARACTERS) await flush();
    batch.push({ id: `yt-${index}`, text: cue.text });
    indexes.push(index);
    characters += cue.text.length;
  }
  await flush();
  return translations;
}

export async function translateSubtitles(deps: SubtitleTranslateDeps, options: SubtitleTranslateOptions): Promise<SubtitleTranslateResult> {
  const apply = (translations: Map<number, string>): DualSubtitleCue[] =>
    options.cues.map((cue, index) => ({ ...cue, translation: translations.get(index) || undefined }));

  if (options.engine === 'youtube-tlang') {
    const url = buildReplayUrl(options.capturedUrl, { tlang: options.targetLanguage });
    if (url) {
      try {
        const body = await deps.fetchText(url);
        if (body) {
          const translated = parseJson3(body);
          const zipped = zipCues(options.cues, translated);
          if (zipped && hasTranslation(options.cues, translated)) {
            return { status: 'translated', cues: zipped };
          }
        }
      } catch {
        // tlang 不可用（空 body/限流/格式）：降级 current-engine，不做请求内重试。
      }
    }
  }

  try {
    const translations = await translateWithEngine(deps, options);
    if (translations.size) return { status: 'translated', cues: apply(translations) };
  } catch {
    // 引擎整体不可用：落到仅原文。
  }
  return { status: 'untranslated', cues: options.cues.map((cue) => ({ ...cue })) };
}
