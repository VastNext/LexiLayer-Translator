// YouTube timedtext 处理：URL 判别/规范化/重放地址构造 + JSON3 解析与轨道对齐。
// pot 门禁（2024-08 起）：部分视频的 timedtext baseUrl 带 exp=xpe 标记时，
// 不带 pot= 的请求返回 200 + 空 body；pot 由播放器运行时铸造，只能捕获-重放。

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface DualSubtitleCue extends SubtitleCue {
  translation?: string;
}

const TIMEDTEXT_PATH = '/api/timedtext';
const MIN_CUE_DURATION = 0.2;

export function isTimedtextUrl(url: string): boolean {
  try {
    return new URL(url, 'https://www.youtube.com').pathname === TIMEDTEXT_PATH;
  } catch {
    return false;
  }
}

// 轨道身份键：剥离 pot/potc/fmt/tlang/expire（会轮换或仅是格式差异），保留其余参数。
export function normKey(url: string): string | undefined {
  try {
    const parsed = new URL(url, 'https://www.youtube.com');
    if (parsed.pathname !== TIMEDTEXT_PATH || parsed.origin !== 'https://www.youtube.com') return undefined;
    const keep = new URLSearchParams();
    const drop = new Set(['pot', 'potc', 'fmt', 'tlang', 'expire']);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!drop.has(key)) keep.append(key, value);
    }
    keep.sort();
    return `${parsed.origin}${parsed.pathname}?${keep.toString()}`;
  } catch {
    return undefined;
  }
}

// 用捕获地址构造重放地址：强制 json3，可选 tlang 翻译轨；pot 等参数原样保留。
export function buildReplayUrl(capturedUrl: string, options: { tlang?: string }): string | undefined {
  try {
    const parsed = new URL(capturedUrl, 'https://www.youtube.com');
    if (parsed.pathname !== TIMEDTEXT_PATH || parsed.origin !== 'https://www.youtube.com') return undefined;
    parsed.searchParams.set('fmt', 'json3');
    if (options.tlang) parsed.searchParams.set('tlang', options.tlang);
    return parsed.href;
  } catch {
    return undefined;
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (_match, code: string) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    return String.fromCodePoint(code.startsWith('#x') ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  });
}

// 解析 json3 字幕：丢弃 aAppend 追加事件与空事件，拼接 segs，剥离 ASR 说话人标记。
// 空 body（pot 门禁静默失败）与坏 JSON 一律抛错，由调用方显式降级。
export function parseJson3(body: string): SubtitleCue[] {
  let parsed: { events?: Array<{ tStartMs?: number; dDurationMs?: number; aAppend?: number; segs?: Array<{ utf8?: string }> }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('字幕响应不是有效 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) throw new Error('字幕响应格式无效');
  const cues: SubtitleCue[] = [];
  for (const event of parsed.events) {
    if (event.aAppend === 1 || !Array.isArray(event.segs)) continue;
    const text = decodeEntities(event.segs.map((segment) => segment.utf8 ?? '').join(''))
      .replace(/>{2,}/gu, '')
      .replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    const start = (event.tStartMs ?? 0) / 1000;
    const end = Math.max(start + (event.dDurationMs ?? 0) / 1000, start + MIN_CUE_DURATION);
    cues.push({ start, end, text });
  }
  return cues;
}

// 翻译轨与原文轨按事件顺序配对；条数不一致即对齐失败（返回 undefined，走降级）。
export function zipCues(source: SubtitleCue[], translated: SubtitleCue[]): DualSubtitleCue[] | undefined {
  if (source.length !== translated.length) return undefined;
  return source.map((cue, index) => ({ ...cue, translation: translated[index]?.text || undefined }));
}

// 翻译轨与原文逐条相同视为未翻译（tlang 不支持该语言对时返回原轨内容）。
export function hasTranslation(source: SubtitleCue[], translated: SubtitleCue[]): boolean {
  if (source.length !== translated.length) return false;
  return translated.some((cue, index) => cue.text !== source[index]?.text);
}
