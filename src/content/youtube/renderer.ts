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
  setPosition?(position: SubtitlePosition): Promise<void> | void;
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
    [${HOST_ID_ATTR}] [data-lexiytds-source]{white-space:pre-wrap}
    [${HOST_ID_ATTR}] [data-lexiytds-translation]{color:#ffd75e;white-space:pre-wrap}
    [${HOST_ID_ATTR}][data-lexiytds-dragging]{cursor:grabbing}
    [${HOST_ID_ATTR}] [data-lexiytds-notice]{font-size:13px;color:#bbb}
  `;
  document.head.append(style);
}

export function createSubtitleRenderer(
  player: HTMLElement,
  storage: SubtitleRendererStorage = {},
): SubtitleRenderer {
  const ownerDocument = player.ownerDocument;
  ensureStyle(ownerDocument);

  const host = ownerDocument.createElement('div');
  host.setAttribute(HOST_ID_ATTR, '');
  host.style.display = 'none';
  player.append(host);

  let restorePosition = false;
  let dragOffset = { x: 0, y: 0 };
  let dragging = false;

  function applyStoredPosition(position: SubtitlePosition): void {
    host.style.left = `${Math.min(Math.max(position.x, 0), 1) * 100}%`;
    host.style.bottom = 'auto';
    host.style.top = `${Math.min(Math.max(position.y, 0), 1) * 100}%`;
    host.style.transform = 'translate(-50%, -50%)';
    restorePosition = true;
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

  function renderLine(kind: 'source' | 'translation', text: string | undefined): HTMLElement {
    let line = kind === 'source' ? sourceLine() : translationLine();
    if (!line) {
      line = ownerDocument.createElement('div');
      line.setAttribute(`data-lexiytds-${kind}`, '');
      host.append(line);
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
    },
  };
}
