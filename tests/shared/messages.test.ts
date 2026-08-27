import { describe, expect, it } from 'vitest';

import { parseTranslationResponse } from '../../src/shared/messages';

describe('parseTranslationResponse', () => {
  it.each(['null', '[]', '42', '"text"'])('将 JSON 原始形状 %s 转换为受控协议错误', (content) => {
    expect(() => parseTranslationResponse(content, ['p1'])).toThrow('翻译响应格式无效');
  });

  it('接受期望 ID 的非空子集，让 content 按 ID 处理部分结果', () => {
    expect(parseTranslationResponse('{"translations":[{"id":"p2","text":"第二段"}]}', ['p1', 'p2']))
      .toEqual([{ id: 'p2', text: '第二段' }]);
  });

  it.each([
    '{"translations":[]}',
    '{"translations":[{"id":"other","text":"未知"}]}',
    '{"translations":[{"id":"p1","text":"一"},{"id":"p1","text":"重复"}]}',
  ])('仍拒绝空、未知或重复 ID：%s', (content) => {
    expect(() => parseTranslationResponse(content, ['p1', 'p2'])).toThrow('翻译响应 ID 不匹配');
  });
});
