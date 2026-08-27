import { describe, expect, it } from 'vitest';

import { buildChatCompletionsUrl } from '../../src/shared/url';

describe('buildChatCompletionsUrl', () => {
  it.each([
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://example.com/v1/', 'https://example.com/v1/chat/completions'],
    ['https://example.com/v1/chat/completions', 'https://example.com/v1/chat/completions'],
    ['https://example.com/v1/chat/completions/', 'https://example.com/v1/chat/completions'],
  ])('规范化 %s', (input, expected) => {
    expect(buildChatCompletionsUrl(input)).toBe(expected);
  });

  it('拒绝非 HTTP(S) 地址', () => {
    expect(() => buildChatCompletionsUrl('file:///tmp/api')).toThrow('Base URL 必须使用 HTTP 或 HTTPS');
  });

  it.each([
    'http://api.example.com/v1',
    'http://192.168.1.10/v1',
  ])('拒绝远程 HTTP 地址 %s', (baseUrl) => {
    expect(() => buildChatCompletionsUrl(baseUrl)).toThrow('Base URL 仅允许 HTTPS，HTTP 仅限本机回环地址');
  });

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
  ])('允许本机回环 HTTP 地址 %s', (baseUrl) => {
    expect(buildChatCompletionsUrl(baseUrl)).toContain('/chat/completions');
  });
});
