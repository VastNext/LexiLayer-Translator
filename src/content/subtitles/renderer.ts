// 播放器内双语字幕 overlay：页面级宿主节点 + 双行渲染 + 拖动位置持久化。
// 不用 Shadow DOM：控制栏适配依赖 .ytp-autohide 全局类选择器（与同行实现一致），
// 样式经 data 属性与独特类名隔离，避免与播放器样式互扰。

export interface SubtitlePosition { x: number; y: number }

export interface SubtitleRenderer {
  show(source: string, translation: string | undefined): void;
  showNotice(message: string): void;
  clear(): void;
  destroy(): void;
}

export interface SubtitleRendererStorage {
  getPosition?(): Promise<SubtitlePosition | undefined>;
  setPosition?(position: SubtitlePosition): Promise<void> | void;
  // 字幕点词（Phase 3）：设置后原文行按词分片渲染，点击词触发回调（rect 为词的视口位置）。
  onWordClick?(word: string, sentence: string, rect: DOMRect): void;
}

// 原文行按空白分词；拉丁词可点击查词，整行无空白（CJK）时退化为整句一个可点击单元。
export function splitWordTokens(text: string): Array<{ word: string; isWord: boolean }> {
  return text.split(/(\s+)/u).filter((token) => token.length > 0).map((token) => ({ word: token, isWord: /\S/u.test(token) }));
}

const STYLE_ID = 'lexiytds-style';
const HOST_ID_ATTR = 'data-lexiytds-host';

function ensureStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${HOST_ID_ATTR}]{position:absolute;z-index:59;left:50%;transform:translateX(-50%);bottom:10%;
      display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 14px;border-radius:8px;
      background:rgba(8,8,8,.75);color:#fff;font-size:18px;line-height:1.45;text-align:center;
      max-width:90%;cursor:default;user-select:none;pointer-events:auto}
    .ytp-autohide [${HOST_ID_ATTR}]{bottom:3%}
    .lexiytds-hide-native .ytp-caption-window-container{opacity:0 !important}
    [${HOST_ID_ATTR}] [data-lexiytds-source]{white-space:pre-wrap}
    [${HOST_ID_ATTR}] [data-lexiytds-translation]{color:#ffd75e;white-space:pre-wrap}
    [${HOST_ID_ATTR}][data-lexiytds-dragging]{cursor:grabbing}
    [${HOST_ID_ATTR}] [data-lexiytds-word]{cursor:pointer}
    [${HOST_ID_ATTR}] [data-lexiytds-word]:hover{text-decoration:underline}
    [${HOST_ID_ATTR}] [data-lexiytds-notice]{font-size:13px;color:#bbb}
  `;
  // document_start 时 head 可能尚未就绪，追加到 documentElement 兜底。
  (document.head ?? document.documentElement).append(style);
}

export function createSubtitleRenderer(
  player: HTMLElement,
  storage: SubtitleRendererStorage = {},
): SubtitleRenderer {
  const { onWordClick } = storage;
  const ownerDocument = player.ownerDocument;
  ensureStyle(ownerDocument);

  // 替换原生字幕显示：捕获链路依赖 CC 开启，但原生渲染需隐藏避免原文重复出现两遍。
  player.classList.add('lexiytds-hide-native');

  const host = ownerDocument.createElement('div');
  host.setAttribute(HOST_ID_ATTR, '');
  host.style.display = 'none';
  player.append(host);

  let dragOffset = { x: 0, y: 0 };
  let dragging = false;

  void storage.getPosition?.().then((position) => {
    if (position) applyStoredPosition(position);
  }).catch(() => undefined);

  function applyStoredPosition(position: SubtitlePosition): void {
    host.style.left = `${Math.min(Math.max(position.x, 0), 1) * 100}%`;
    host.style.bottom = 'auto';
    host.style.top = `${Math.min(Math.max(position.y, 0), 1) * 100}%`;
    host.style.transform = 'translate(-50%, -50%)';
  }

  function sourceLine(): HTMLElement | null {
    return host.querySelector('[data-lexiytds-source]');
  }

  function translationLine(): HTMLElement | null {
    return host.querySelector('[data-lexiytds-translation]');
  }

  function noticeLine(): HTMLElement | null {
    return host.querySelector('[data-lexiytds-notice]');
  }

  function renderLine(kind: 'source' | 'translation' | 'notice', text: string | undefined): HTMLElement {
    let line = kind === 'source' ? sourceLine() : translationLine();
    if (!line) {
      line = ownerDocument.createElement('div');
      line.setAttribute(`data-lexiytds-${kind}`, '');
      host.append(line);
    }
    if (kind === 'source' && onWordClick && text !== undefined) {
      // 点词模式：按词分片渲染，保留空白文本节点；点击词回调给装配层查词/收生词。
      line.replaceChildren(...splitWordTokens(text).map((token) => {
        if (!token.isWord) return ownerDocument.createTextNode(token.word);
        const span = ownerDocument.createElement('span');
        span.setAttribute('data-lexiytds-word', token.word);
        span.textContent = token.word;
        return span;
      }));
      return line;
    }
    line.textContent = text ?? '';
    return line;
  }

  function onPointerDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const hostRect = host.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    dragging = true;
    host.setAttribute('data-lexiytds-dragging', '');
    dragOffset = { x: event.clientX - hostRect.left, y: event.clientY - hostRect.top };
    event.preventDefault();
    void playerRect;
  }

  function onPointerMove(event: MouseEvent): void {
    if (!dragging) return;
    const playerRect = player.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const centerX = event.clientX - dragOffset.x + hostRect.width / 2;
    const centerY = event.clientY - dragOffset.y + hostRect.height / 2;
    const x = Math.min(Math.max((centerX - playerRect.left) / playerRect.width, 0), 1);
    const y = Math.min(Math.max((centerY - playerRect.top) / playerRect.height, 0), 1);
    applyStoredPosition({ x, y });
    void storage.setPosition?.({ x, y });
  }

  function onPointerUp(): void {
    if (!dragging) return;
    dragging = false;
    host.removeAttribute('data-lexiytds-dragging');
  }

  host.addEventListener('pointerdown', onPointerDown);
  ownerDocument.addEventListener('pointermove', onPointerMove);
  ownerDocument.addEventListener('pointerup', onPointerUp);
  host.addEventListener('click', (event) => {
    if (!onWordClick) return;
    const target = event.target instanceof Element ? event.target.closest('[data-lexiytds-word]') : null;
    if (!(target instanceof HTMLElement)) return;
    event.stopPropagation();
    const sentence = sourceLine()?.textContent ?? '';
    onWordClick(target.getAttribute('data-lexiytds-word') ?? '', sentence, target.getBoundingClientRect());
  });

  return {
    show(source: string, translation: string | undefined): void {
      const notice = noticeLine();
      if (notice) notice.remove();
      renderLine('source', source);
      if (translation !== undefined) {
        renderLine('translation', translation);
      } else {
        translationLine()?.remove();
      }
      host.style.display = 'flex';
    },

    showNotice(message: string): void {
      renderLine('notice', message);
      host.style.display = 'flex';
    },

    clear(): void {
      sourceLine()?.remove();
      translationLine()?.remove();
      noticeLine()?.remove();
      host.style.display = 'none';
    },

    destroy(): void {
      host.removeEventListener('pointerdown', onPointerDown);
      ownerDocument.removeEventListener('pointermove', onPointerMove);
      ownerDocument.removeEventListener('pointerup', onPointerUp);
      host.remove();
      player.classList.remove('lexiytds-hide-native');
    },
  };
}
