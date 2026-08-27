export type DisplayMode = 'bilingual' | 'translation';

export interface TranslatorConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  displayMode: DisplayMode;
  userInstruction: string;
  translationPosition: 'before' | 'after';
  scanScope: 'main-content' | 'whole-page';
  selectionContext: boolean;
}

export type SafeTranslatorConfig = Omit<TranslatorConfig, 'apiKey'>;

export const DEFAULT_CONFIG: TranslatorConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLanguage: 'en',
  displayMode: 'bilingual',
  userInstruction: '',
  translationPosition: 'after',
  scanScope: 'main-content',
  selectionContext: true,
};

const CONFIG_FIELDS = new Set<keyof TranslatorConfig>([
  'baseUrl', 'apiKey', 'model', 'targetLanguage', 'displayMode', 'userInstruction', 'translationPosition', 'scanScope', 'selectionContext',
]);

export function parseConfigImport(config: unknown): Partial<SafeTranslatorConfig> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('配置必须是对象');
  }
  const value = config as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !CONFIG_FIELDS.has(key as keyof TranslatorConfig));
  if (unknown.length) throw new Error(`配置包含未知字段：${unknown.join('、')}`);
  if ('apiKey' in value) throw new Error('导入配置不能包含 API Key');

  const imported: Partial<SafeTranslatorConfig> = {};
  for (const key of ['baseUrl', 'model', 'targetLanguage', 'displayMode', 'userInstruction', 'translationPosition', 'scanScope', 'selectionContext'] as const) {
    if (key in value) Object.assign(imported, { [key]: value[key] });
  }
  const errors = validateConfig({ ...DEFAULT_CONFIG, apiKey: '导入校验占位', ...imported });
  if (errors.length) throw new Error(errors.join('；'));
  return imported;
}

export function validateConfig(config: unknown): string[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return ['配置必须是对象'];
  }

  const value = config as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) {
    errors.push('Base URL 不能为空');
  } else {
    try {
      assertSafeBaseUrl(value.baseUrl);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Base URL 无效');
    }
  }
  if (typeof value.apiKey !== 'string' || !value.apiKey.trim()) errors.push('API Key 不能为空');
  if (typeof value.model !== 'string' || !value.model.trim()) errors.push('模型不能为空');
  if (typeof value.targetLanguage !== 'string' || !value.targetLanguage.trim()) errors.push('目标语言不能为空');
  if (value.displayMode !== 'bilingual' && value.displayMode !== 'translation') errors.push('显示模式无效');
  if (typeof value.userInstruction !== 'string') errors.push('用户要求必须是字符串');
  if (value.translationPosition !== 'before' && value.translationPosition !== 'after') errors.push('译文位置无效');
  if (value.scanScope !== 'main-content' && value.scanScope !== 'whole-page') errors.push('翻译范围无效');
  if (typeof value.selectionContext !== 'boolean') errors.push('有限上下文配置无效');
  return errors;
}

export function exportSafeConfig(config: TranslatorConfig): SafeTranslatorConfig {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    targetLanguage: config.targetLanguage,
    displayMode: config.displayMode,
    userInstruction: config.userInstruction,
    translationPosition: config.translationPosition,
    scanScope: config.scanScope,
    selectionContext: config.selectionContext,
  };
}
import { assertSafeBaseUrl } from './url';
