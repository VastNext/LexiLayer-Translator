import { describe, expect, it } from 'vitest';

import { formatShortcut, resolvePageTranslationShortcut } from '../../src/shared/shortcuts';

describe('页面翻译快捷键状态', () => {
  it('按命令名查找并格式化已分配的快捷键', () => {
    expect(resolvePageTranslationShortcut([
      { name: 'other', shortcut: 'Alt+A', description: '翻译网页' },
      { name: 'translate_page', shortcut: 'Ctrl+Shift+Y', description: '任意本地化描述' },
    ])).toEqual({ status: 'assigned', shortcut: 'Ctrl+Shift+Y', displayShortcut: 'Ctrl + Shift + Y' });
    expect(formatShortcut('Command+Shift+P')).toBe('Command + Shift + P');
  });

  it('仅把精确空字符串识别为未分配', () => {
    expect(resolvePageTranslationShortcut([{ name: 'translate_page', shortcut: '' }])).toEqual({ status: 'unassigned' });
    expect(resolvePageTranslationShortcut([{ name: 'translate_page', shortcut: ' ' }])).toEqual({ status: 'unavailable', reason: 'invalid-shortcut' });
  });

  it.each([
    ['命令缺失', [], 'command-missing'],
    ['只有其他命令', [{ name: 'other', shortcut: 'Ctrl+A' }], 'command-missing'],
    ['shortcut 缺失', [{ name: 'translate_page' }], 'invalid-shortcut'],
    ['shortcut 非字符串', [{ name: 'translate_page', shortcut: 1 }], 'invalid-shortcut'],
    ['命令项非法', [null], 'invalid-command'],
  ])('%s 时返回不可用', (_name, commands, reason) => {
    expect(resolvePageTranslationShortcut(commands)).toEqual({ status: 'unavailable', reason });
  });
});
