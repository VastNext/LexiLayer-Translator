import type { TranslationResult, TranslationSegment } from '../shared/messages';

export function createTranslationBatches(
  segments: TranslationSegment[],
  maxSegments = 8,
  maxCharacters = 6000,
): TranslationSegment[][] {
  const batches: TranslationSegment[][] = [];
  let batch: TranslationSegment[] = [];
  let characters = 0;

  for (const segment of segments) {
    if (segment.text.length > maxCharacters) {
      throw new Error(`段落 ${segment.id} 超过单段字符上限 ${maxCharacters}`);
    }
    if (batch.length > 0 && (batch.length >= maxSegments || characters + segment.text.length > maxCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(segment);
    characters += segment.text.length;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function orderTranslationResults(
  segments: TranslationSegment[],
  results: TranslationResult[],
): TranslationResult[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return segments.flatMap((segment) => {
    const result = byId.get(segment.id);
    return result ? [result] : [];
  });
}
