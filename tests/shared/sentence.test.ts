import { describe, expect, it } from 'vitest';

import { extractSentence } from '../../src/shared/sentence';

describe('extractSentence', () => {
  it.each([
    ['  开头。\n  这是   目标 句子！  下一句？', '目标 句子', '这是 目标 句子！'],
    ['Intro. The QUICK brown fox jumps! Outro?', 'quick brown', 'The QUICK brown fox jumps!'],
  ])('规范化空白并返回包含选区的完整中英文句子', (blockText, selectedText, expected) => {
    expect(extractSentence(blockText, selectedText)).toBe(expected);
  });

  it.each([
    ['他说：“这是目标。” 然后离开。', '目标', '他说：“这是目标。”'],
    ['Read this (important!) Next sentence.', 'important', 'Read this (important!)'],
    ['第一句；第二句。', '第一句', '第一句；'],
  ])('把句末标点后的关闭引号或括号保留在句子中', (blockText, selectedText, expected) => {
    expect(extractSentence(blockText, selectedText)).toBe(expected);
  });

  it('拉丁字母查找大小写不敏感，同时按原文返回结果', () => {
    expect(extractSentence('Alpha BETA. 中文甲。', 'beta')).toBe('Alpha BETA.');
    expect(extractSentence('简体目标。繁體目標。', '繁體目標')).toBe('繁體目標。');
  });

  it('选区跨句时返回围绕首次匹配位置的限长安全片段', () => {
    const blockText = `0123456789 target. Second part ${'x'.repeat(30)} target. Second trailing`;
    const result = extractSentence(blockText, 'target. Second', 20);

    expect(result).toContain('target. Second');
    expect(result).not.toContain('trailing');
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('选区完全找不到时回退到规范化块文本的开头', () => {
    expect(extractSentence('  alpha   beta gamma delta  ', 'missing', 10)).toBe('alpha beta');
    expect(extractSentence('x'.repeat(250), 'missing')).toHaveLength(200);
  });

  it('完整句子超过 maxLength 时返回围绕首次匹配位置的片段', () => {
    const result = extractSentence(`prefix ${'x'.repeat(40)} target ${'y'.repeat(40)}.`, 'target', 24);

    expect(result).toContain('target');
    expect(result.length).toBeLessThanOrEqual(24);
  });

  it('限长时不留下未配对的 UTF-16 代理项', () => {
    const result = extractSentence('a😀bcdef', 'missing', 2);

    expect(result).toBe('a');
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it.each([
    ['', 'word'],
    ['   ', 'word'],
    ['Some text.', ''],
    ['Some text.', '   '],
  ])('块文本或选区为空时返回空字符串', (blockText, selectedText) => {
    expect(extractSentence(blockText, selectedText)).toBe('');
  });
});
