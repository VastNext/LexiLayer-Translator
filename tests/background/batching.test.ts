import { describe, expect, it } from 'vitest';

import { createTranslationBatches, orderTranslationResults } from '../../src/background/batching';

describe('createTranslationBatches', () => {
  it('每批最多包含 8 段', () => {
    const segments = Array.from({ length: 9 }, (_, index) => ({ id: String(index), text: '文本' }));

    expect(createTranslationBatches(segments).map((batch) => batch.length)).toEqual([8, 1]);
  });

  it('每批累计最多 6000 字符', () => {
    const segments = [
      { id: 'a', text: 'a'.repeat(4000) },
      { id: 'b', text: 'b'.repeat(2001) },
      { id: 'c', text: 'c'.repeat(100) },
    ];

    expect(createTranslationBatches(segments).map((batch) => batch.map(({ id }) => id))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
  });

  it('拒绝超过默认字符上限的单段', () => {
    const segment = { id: 'long', text: 'a'.repeat(6001) };
    expect(() => createTranslationBatches([segment])).toThrow('段落 long 超过单段字符上限 6000');
  });

  it('拒绝超过自定义字符上限的单段', () => {
    const segment = { id: 'custom', text: 'abcd' };
    expect(() => createTranslationBatches([segment], 8, 3)).toThrow('段落 custom 超过单段字符上限 3');
  });

  it('按请求顺序返回部分结果且不填入 undefined', () => {
    const segments = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
    expect(orderTranslationResults(segments, [{ id: 'c', text: '丙' }, { id: 'a', text: '甲' }]))
      .toEqual([{ id: 'a', text: '甲' }, { id: 'c', text: '丙' }]);
  });
});
