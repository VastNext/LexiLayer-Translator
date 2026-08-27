export interface TranslationSegment {
  id: string;
  text: string;
}

export interface TranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  segments: TranslationSegment[];
  userInstruction?: string;
}

export interface TranslationResult {
  id: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createTranslationMessages(request: TranslationRequest) {
  const instruction = [
    `将输入从 ${request.sourceLanguage} 翻译为 ${request.targetLanguage}。`,
    '保留每个 id，返回 {"translations":[{"id":"...","text":"..."}]}，不得添加其他内容。',
    request.userInstruction?.trim(),
  ].filter(Boolean).join('\n');

  return [
    { role: 'system' as const, content: instruction },
    { role: 'user' as const, content: JSON.stringify({ segments: request.segments }) },
  ];
}

export function parseTranslationResponse(content: string, expectedIds: string[]): TranslationResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('翻译响应不是有效 JSON');
  }

  if (!isRecord(parsed)) {
    throw new Error('翻译响应格式无效');
  }

  const translations = parsed.translations;
  if (!Array.isArray(translations)) {
    throw new Error('翻译响应格式无效');
  }

  const results: TranslationResult[] = translations.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string') {
      throw new Error('翻译响应格式无效');
    }
    return { id: item.id, text: item.text };
  });

  const actualIds = results.map(({ id }) => id);
  if (
    actualIds.length === 0
    || new Set(actualIds).size !== actualIds.length
    || actualIds.some((id) => !expectedIds.includes(id))
  ) {
    throw new Error('翻译响应 ID 不匹配');
  }

  return results;
}
