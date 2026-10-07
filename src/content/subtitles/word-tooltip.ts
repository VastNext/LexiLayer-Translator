// 字幕点词：词级释义悬浮层 + 一键加入生词本。
// 悬浮层为页面级宿主（与字幕 overlay 同风格），释义经当前翻译引擎查词，
// 收词复用后台 save-vocabulary-entry（生词本管线）。

export interface WordVocabEntry {
  word: string;
  sentence: string;
  translation?: string;
  targetLanguage: string;
}

export interface WordTooltipDeps {
  translateWord(word: string, sentence: string, targetLanguage: string): Promise<string>;
  saveToVocabulary(entry: WordVocabEntry): Promise<'created' | 'duplicate'>;
  getTargetLanguage(): Promise<string>;
}

export interface WordTooltip {
  open(word: string, sentence: string, rect: DOMRect): void;
  destroy(): void;
}

const STYLE_ID = 'lexiytds-wordtip-style';
const TIP_ATTR = 'data-lexiytds-wordtip';

function ensureStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${TIP_ATTR}]{position:absolute;z-index:2147483647;display:flex;flex-direction:column;gap:6px;
      padding:10px 12px;border-radius:10px;background:rgba(12,12,12,.92);color:#fff;font-size:14px;
      line-height:1.4;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
    [${TIP_ATTR}] [data-lexiytds-wordtip-word]{font-weight:700;font-size:15px}
    [${TIP_ATTR}] [data-lexiytds-wordtip-meaning]{color:#ffd75e;min-height:1em}
    [${TIP_ATTR}] button{align-self:flex-start;padding:4px 10px;border:0;border-radius:6px;background:#3568ff;
      color:#fff;font-size:13px;cursor:pointer}
    [${TIP_ATTR}] button:disabled{opacity:.6;cursor:default}
  `;
  (document.head ?? document.documentElement).append(style);
}

export function createWordTooltip(document: Document, deps: WordTooltipDeps): WordTooltip {
  ensureStyle(document);

  let tip: HTMLElement | undefined;
  let dismissHandlers: Array<() => void> = [];
  let sequence = 0;

  function close(): void {
    tip?.remove();
    tip = undefined;
    for (const remove of dismissHandlers) remove();
    dismissHandlers = [];
  }

  let openedAt = 0;

  function onOutsideClick(event: MouseEvent): void {
    // 打开瞬间的同一连击事件（mousedown/mouseup 后的合成 click 在 bubble 阶段
    // 迟到）不得立即关闭悬浮层：打开后 300ms 内的 outside click 忽略。
    if (Date.now() - openedAt < 300) return;
    if (tip && event.target instanceof Node && !tip.contains(event.target)) close();
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }

  return {
    open(word: string, sentence: string, rect: DOMRect): void {
      close();
      sequence += 1;
      const current = sequence;

      tip = document.createElement('div');
      tip.setAttribute(TIP_ATTR, '');
      const wordLine = document.createElement('div');
      wordLine.setAttribute('data-lexiytds-wordtip-word', '');
      wordLine.textContent = word;
      const meaningLine = document.createElement('div');
      meaningLine.setAttribute('data-lexiytds-wordtip-meaning', '');
      meaningLine.textContent = '…';
      const saveButton = document.createElement('button');
      saveButton.type = 'button';
      // 释义就绪前禁用：点词收词必须携带译文，且避免点击处理未挂载时静默无效。
      saveButton.disabled = true;
      saveButton.textContent = '加入生词本';
      tip.append(wordLine, meaningLine, saveButton);
      document.body.append(tip);

      // 位置：优先词正下方，空间不足放上方；左右钳制在视口内。
      const viewWidth = document.documentElement.clientWidth;
      const left = Math.min(Math.max(rect.left, 8), Math.max(8, viewWidth - 340));
      const top = rect.bottom + 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;

      const onScrollOrResize = () => close();
      document.addEventListener('click', onOutsideClick, { capture: true });
      document.addEventListener('keydown', onEscape);
      window.addEventListener('scroll', onScrollOrResize, { passive: true });
      window.addEventListener('resize', onScrollOrResize);
      openedAt = Date.now();
      dismissHandlers = [
        () => document.removeEventListener('click', onOutsideClick, { capture: true }),
        () => document.removeEventListener('keydown', onEscape),
        () => window.removeEventListener('scroll', onScrollOrResize),
        () => window.removeEventListener('resize', onScrollOrResize),
      ];

      void (async () => {
        const targetLanguage = await deps.getTargetLanguage().catch(() => 'en');
        if (current !== sequence) return;
        const meaning = await deps.translateWord(word, sentence, targetLanguage).catch(() => undefined);
        if (current !== sequence || !meaningLine.isConnected) return;
        meaningLine.textContent = meaning ?? '查词失败';
        if (!meaning) return;

        saveButton.disabled = false;
        saveButton.addEventListener('click', () => {
          saveButton.disabled = true;
          void (async () => {
            const status = await deps.saveToVocabulary({
              word, sentence, translation: meaning, targetLanguage,
            }).catch(() => undefined);
            if (current !== sequence || !saveButton.isConnected) return;
            saveButton.textContent = status === 'created' ? '已加入生词本'
              : status === 'duplicate' ? '已在生词本' : '加入失败';
          })();
        });
      })();
    },

    destroy(): void {
      close();
    },
  };
}
