import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('界面视觉契约', () => {
  it('仅使用暖白、墨黑与酸绿色，不引入额外强调色', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/ui.css'), 'utf8');

    const colors = new Set(css.match(/#[0-9a-f]{6}/gi)?.map((color) => color.toLowerCase()));

    expect(css).not.toMatch(/--(?:focus|error):/);
    expect(colors).toEqual(new Set(['#f7f2e8', '#fffdf7', '#171713', '#58574f', '#b8b3a8', '#77736a', '#b8ff2c']));
  });
});
