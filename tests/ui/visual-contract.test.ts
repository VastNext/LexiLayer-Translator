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

  it('BrandMark 使用 VastNext 路线、地平线与珊瑚信标并保留 aria', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../src/BrandMark.tsx'), 'utf8');
    expect(source).toContain('logo-horizon');
    expect(source).toContain('logo-route');
    expect(source).toContain('logo-beacon');
    expect(source).toContain('aria-label');
  });
});
