const DEFAULT_MAX_LENGTH = 200;
const SENTENCE_END = /[.!?。！？；;]/u;
const SENTENCE_TRAILER = /[.!?。！？；;"'”’」』》〉）】〕}\])]/u;
const LATIN_CHARACTER = /\p{Script=Latin}/u;

type TextRange = {
  start: number;
  end: number;
};

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function normalizeMaxLength(maxLength: number): number {
  return Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : DEFAULT_MAX_LENGTH;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createSelectionPattern(selectedText: string): RegExp {
  const pattern = Array.from(selectedText, (character) => {
    if (!LATIN_CHARACTER.test(character)) {
      return escapeRegExp(character);
    }

    const variants = [...new Set([
      character,
      character.toLocaleLowerCase('en-US'),
      character.toLocaleUpperCase('en-US'),
    ])];

    return variants.length === 1
      ? escapeRegExp(character)
      : `(?:${variants.map(escapeRegExp).join('|')})`;
  }).join('');

  return new RegExp(pattern, 'u');
}

function findSelection(blockText: string, selectedText: string): TextRange | undefined {
  const match = createSelectionPattern(selectedText).exec(blockText);
  if (!match || match.index === undefined) {
    return undefined;
  }

  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

function trimRange(text: string, start: number, end: number): TextRange | undefined {
  while (start < end && text[start] === ' ') {
    start += 1;
  }
  while (end > start && text[end - 1] === ' ') {
    end -= 1;
  }

  return start < end ? { start, end } : undefined;
}

function splitSentenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const width = character.length;

    if (!SENTENCE_END.test(character)) {
      index += width;
      continue;
    }

    let end = index + width;
    while (end < text.length) {
      const trailingCharacter = String.fromCodePoint(text.codePointAt(end) ?? 0);
      if (!SENTENCE_TRAILER.test(trailingCharacter)) {
        break;
      }
      end += trailingCharacter.length;
    }

    const range = trimRange(text, start, end);
    if (range) {
      ranges.push(range);
    }
    start = end;
    index = end;
  }

  const finalRange = trimRange(text, start, text.length);
  if (finalRange) {
    ranges.push(finalRange);
  }

  return ranges;
}

function safeSlice(text: string, start: number, end: number): string {
  let safeStart = Math.max(0, start);
  let safeEnd = Math.min(text.length, end);

  if (safeStart > 0) {
    const firstCodeUnit = text.charCodeAt(safeStart);
    if (firstCodeUnit >= 0xDC00 && firstCodeUnit <= 0xDFFF) {
      safeStart += 1;
    }
  }

  if (safeEnd > safeStart) {
    const lastCodeUnit = text.charCodeAt(safeEnd - 1);
    if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) {
      safeEnd -= 1;
    }
  }

  return text.slice(safeStart, safeEnd).trim();
}

function extractFragment(
  text: string,
  match: TextRange,
  maxLength: number,
  bounds: TextRange = { start: 0, end: text.length },
): string {
  if (maxLength === 0 || bounds.start >= bounds.end) {
    return '';
  }

  const matchLength = match.end - match.start;
  const contextLength = Math.max(0, maxLength - Math.min(matchLength, maxLength));
  let start = match.start - Math.floor(contextLength / 2);
  let end = matchLength >= maxLength ? match.start + maxLength : match.end + Math.ceil(contextLength / 2);

  if (start < bounds.start) {
    end = Math.min(bounds.end, end + bounds.start - start);
    start = bounds.start;
  }
  if (end > bounds.end) {
    start = Math.max(bounds.start, start - (end - bounds.end));
    end = bounds.end;
  }

  return safeSlice(text, start, end);
}

export function extractSentence(blockText: string, selectedText: string, maxLength = DEFAULT_MAX_LENGTH): string {
  const normalizedBlock = normalizeWhitespace(blockText);
  const normalizedSelection = normalizeWhitespace(selectedText);
  const lengthLimit = normalizeMaxLength(maxLength);

  if (!normalizedBlock || !normalizedSelection || lengthLimit === 0) {
    return '';
  }

  const match = findSelection(normalizedBlock, normalizedSelection);
  if (!match) {
    return safeSlice(normalizedBlock, 0, lengthLimit);
  }

  const sentence = splitSentenceRanges(normalizedBlock).find(
    ({ start, end }) => match.start >= start && match.end <= end,
  );

  if (sentence && sentence.end - sentence.start <= lengthLimit) {
    return normalizedBlock.slice(sentence.start, sentence.end);
  }

  return extractFragment(normalizedBlock, match, lengthLimit, sentence);
}
