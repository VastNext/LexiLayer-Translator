import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSubtitleRenderer } from '../../../src/content/youtube/renderer';

// 播放器内双语 overlay：页面级 host + 双行渲染 + 拖动位置持久化。

describe('createSubtitleRenderer', () => {
  let player: HTMLElement;
  let stored: { x?: number; y?: number };
  let setPosition: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '<div class="html5-video-player" id="movie_player"></div>';
    player = document.getElementById('movie_player')!;
    stored = {};
    setPosition = vi.fn(async (position: { x: number; y: number }) => { stored.x = position.x; stored.y = position.y; });
  });

  it('show 渲染原文与译文两行，挂载在播放器内部', () => {
    const renderer = createSubtitleRenderer(player);
    renderer.show('Hello', '你好');
    const host = player.querySelector('[data-lexiytds-host]');
    expect(host).not.toBeNull();
    expect(player.textContent).toContain('Hello');
    expect(player.textContent).toContain('你好');
  });

  it('译文缺省时只显示原文行', () => {
    const renderer = createSubtitleRenderer(player);
    renderer.show('Hello', undefined);
    const host = player.querySelector('[data-lexiytds-host]')!;
    expect(host.textContent).toContain('Hello');
    expect(host.querySelectorAll('[data-lexiytds-translation]')).toHaveLength(0);
  });

  it('clear 清空内容，showNotice 显示状态提示', () => {
    const renderer = createSubtitleRenderer(player);
    renderer.show('Hello', '你好');
    renderer.clear();
    const host = player.querySelector('[data-lexiytds-host]')!;
    expect(host.querySelectorAll('[data-lexiytds-source]')).toHaveLength(0);
    renderer.showNotice('字幕翻译不可用');
    expect(host.textContent).toContain('字幕翻译不可用');
  });

  it('destroy 移除宿主节点', () => {
    const renderer = createSubtitleRenderer(player);
    renderer.show('Hello', '你好');
    renderer.destroy();
    expect(player.querySelector('[data-lexiytds-host]')).toBeNull();
  });

  it('拖动 host 后按百分比持久化位置', () => {
    player.getBoundingClientRect = vi.fn(() => ({ width: 1000, height: 500, left: 0, top: 0, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => undefined }) as DOMRect);
    const renderer = createSubtitleRenderer(player, { setPosition: setPosition as (position: { x: number; y: number }) => Promise<void> | void });
    renderer.show('Hello', '你好');
    const host = player.querySelector('[data-lexiytds-host]') as HTMLElement;
    host.getBoundingClientRect = vi.fn(() => ({ width: 200, height: 60, left: 400, top: 200, right: 600, bottom: 260, x: 400, y: 200, toJSON: () => undefined }) as DOMRect);
    host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 450, clientY: 210 }));
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300 }));
    document.dispatchEvent(new MouseEvent('pointerup'));
    expect(setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 0.35, y: 0.64 }));
  });
});
