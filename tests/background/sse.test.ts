import { describe, expect, it } from 'vitest';

import { SseParser } from '../../src/background/sse';

describe('SseParser', () => {
  it('处理跨数据块断开的 data 事件并累积 delta', () => {
    const parser = new SseParser();

    expect(parser.push('data: {"choices":[{"delta":{"content":"你'))
      .toEqual({ chunks: [], done: false, fallback: false });
    expect(parser.push('好"}}]}\n\n')).toEqual({ chunks: ['你好'], done: false, fallback: false });
    expect(parser.content).toBe('你好');
  });

  it('一次处理多个 data 事件并识别 DONE', () => {
    const parser = new SseParser();
    const result = parser.push([
      'data: {"choices":[{"delta":{"content":"A"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"B"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'));

    expect(result).toEqual({ chunks: ['A', 'B'], done: true, fallback: false });
    expect(parser.content).toBe('AB');
  });

  it('支持 CRLF 和多行 data 字段', () => {
    const parser = new SseParser();
    const result = parser.push('data: {"choices":[{"delta":\r\ndata: {"content":"A"}}]}\r\n\r\n');

    expect(result.chunks).toEqual(['A']);
  });

  it('错误 JSON 发出非流式回退信号', () => {
    const parser = new SseParser();

    expect(parser.push('data: {bad json}\n\n')).toEqual({ chunks: [], done: false, fallback: true });
  });

  it('正确处理跨 chunk 拆开的 CRLF', () => {
    const parser = new SseParser();

    expect(parser.push('data: {"choices":[{"delta":{"content":"A"}}]}\r'))
      .toEqual({ chunks: [], done: false, fallback: false });
    expect(parser.push('\n\r')).toEqual({ chunks: ['A'], done: false, fallback: false });
    expect(parser.push('\n')).toEqual({ chunks: [], done: false, fallback: false });
  });

  it('支持仅 CR 的事件分隔', () => {
    const parser = new SseParser();

    expect(parser.push('data: {"choices":[{"delta":{"content":"A"}}]}\r\r').chunks).toEqual(['A']);
  });

  it('finish 处理 EOF 时未带空行的残留事件', () => {
    const parser = new SseParser();
    parser.push('data: {"choices":[{"delta":{"content":"尾"}}]}');

    expect(parser.finish()).toEqual({ chunks: ['尾'], done: false, fallback: false });
  });

  it('多行 data 在 EOF 时拼接为单个 JSON 事件', () => {
    const parser = new SseParser();
    parser.push('data: {"choices":[{"delta":\ndata: {"content":"A"}}]}');

    expect(parser.finish().chunks).toEqual(['A']);
  });
});
