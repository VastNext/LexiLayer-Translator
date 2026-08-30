import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import enMessages from '../../public/_locales/en/messages.json';
import zhMessages from '../../public/_locales/zh_CN/messages.json';

describe('界面视觉契约', () => {
  it('多引擎控件具备中英本地化标签', () => {
    expect(zhMessages.translationEngine.message).toBe('翻译引擎');
    expect(enMessages.translationEngine.message).toBe('Translation engine');
  });

  it('使用共享语义 token 驱动五套明显不同主题', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/ui.css'), 'utf8');
    for (const theme of ['pearl-reader', 'command-translator', 'sage-global', 'editorial-lingua', 'precision-blue']) {
      expect(css).toContain(`[data-theme="${theme}"]`);
    }
    for (const token of ['--page', '--panel', '--ink', '--muted', '--line', '--accent', '--focus', '--primary', '--radius-panel']) {
      expect(css).toContain(token);
    }
    expect(css.match(/\.popup\s*\{/g)).toHaveLength(1);
    expect(css).toMatch(/max-width:\s*1000px/);
    expect(css).toMatch(/\.popup\s*\{[^}]*width:\s*360px/s);
    expect(css).toContain('#07080a');
    expect(css).toContain('#e9eee7');
    expect(css).toContain('Georgia');
    expect(css).toContain('#0f62fe');
    expect(css).toMatch(/focus-visible/);
  });

  it('Pearl Reader 为 Popup 和 Options 提高基础字号与控件字号', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/ui.css'), 'utf8');
    expect(css).toMatch(/--ui-body-size:\s*16px/);
    expect(css).toMatch(/--ui-control-size:\s*14px/);
    expect(css).toMatch(/body\s*\{[^}]*font-size:\s*var\(--ui-body-size\)/s);
  });

  it('Options 使用固定双栏、右侧独立滚动、固定 Toast 和统一字号', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/ui.css'), 'utf8');
    expect(css).toMatch(/\.options\s*\{[^}]*height:\s*calc\(100vh - 48px\)[^}]*max-height:\s*calc\(100vh - 48px\)/s);
    expect(css).toMatch(/\.options-nav\s*\{[^}]*height:\s*100%/s);
    expect(css).toMatch(/\.options-content\s*\{[^}]*height:\s*100%[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.status-toast\s*\{[^}]*position:\s*fixed[^}]*top:\s*16px[^}]*right:\s*16px/s);
    expect(css).toMatch(/\.options-nav nav button\s*\{[^}]*font-size:\s*14px/s);
    expect(css).toMatch(/\.field\s*\{[^}]*font-size:\s*13px/s);
    expect(css).toMatch(/\.field input:not\(\[type="checkbox"\]\), \.field select, \.field textarea\s*\{[^}]*font-size:\s*15px/s);
    expect(css).toMatch(/\.options-action\s*\{[^}]*min-height:\s*32px[^}]*padding:\s*5px 8px[^}]*font-size:\s*13px/s);
  });

  it('BrandMark 使用 VastNext 路线、地平线与珊瑚信标并保留 aria', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../src/BrandMark.tsx'), 'utf8');
    expect(source).toContain('logo-horizon');
    expect(source).toContain('logo-route');
    expect(source).toContain('logo-beacon');
    expect(source).toContain('aria-label');
  });

  it('扩展 SVG 图标使用蓝粉晚霞渐变和白色主标', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../public/icons/vast-translator.svg'), 'utf8');
    expect(source).toContain('#3568ff');
    expect(source).toContain('#f06f92');
    expect(source).toContain('linearGradient');
    expect(source).toMatch(/stroke="#fff"/);
    expect(source).toMatch(/fill="#fff"/);
    expect(source.match(/<circle/g)).toHaveLength(3);
    expect(source).toContain('三点 V 形星座');
  });
});
