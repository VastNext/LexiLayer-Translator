// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpeechController, detectSpeechLanguage } from '../../src/shared/speech';

class MockUtterance {
  readonly text: string;
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }

  finish(): void {
    this.onend?.({} as SpeechSynthesisEvent);
  }

  fail(): void {
    this.onerror?.({} as SpeechSynthesisErrorEvent);
  }
}

class MockSynthesis {
  readonly cancel = vi.fn();
  readonly spoken: MockUtterance[] = [];
  readonly speak = vi.fn((utterance: SpeechSynthesisUtterance) => {
    this.spoken.push(utterance as unknown as MockUtterance);
  });
  readonly getVoices = vi.fn(() => this.voices);

  constructor(readonly voices: SpeechSynthesisVoice[] = []) {}
}

function voice(lang: string, name = lang): SpeechSynthesisVoice {
  return {
    default: false,
    lang,
    localService: true,
    name,
    voiceURI: name,
  };
}

function installUtteranceMock(): void {
  vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectSpeechLanguage', () => {
  it.each([
    ['中文かな한글', 'ja-JP'],
    ['中文한글', 'ko-KR'],
    ['纯中文', 'zh-CN'],
    ['Привет мир', 'ru-RU'],
    ['Plain latin text', undefined],
    ['', undefined],
  ])('按文字范围优先级检测 %s', (text, expected) => {
    expect(detectSpeechLanguage(text)).toBe(expected);
  });
});

describe('createSpeechController', () => {
  it('开始前取消旧任务，使用检测语言并按语言前缀选择 voice', () => {
    installUtteranceMock();
    const synthesis = new MockSynthesis([
      voice('en-US', 'English'),
      voice('ja-JP', 'Japanese'),
    ]);
    const controller = createSpeechController(synthesis as unknown as SpeechSynthesis);

    expect(controller.speak('日本語です')).toBe(true);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(synthesis.spoken).toHaveLength(1);
    expect(synthesis.spoken[0]).toMatchObject({
      text: '日本語です',
      lang: 'ja-JP',
      voice: expect.objectContaining({ name: 'Japanese' }),
    });
    expect(controller.isSpeaking()).toBe(true);
  });

  it('languageHint 优先于检测结果，并可匹配同前缀 voice', () => {
    installUtteranceMock();
    const synthesis = new MockSynthesis([
      voice('fr-FR', 'French'),
      voice('en-GB', 'British English'),
    ]);
    const controller = createSpeechController(synthesis as unknown as SpeechSynthesis);

    expect(controller.speak('かな', 'en-US')).toBe(true);
    expect(synthesis.spoken[0]).toMatchObject({
      lang: 'en-US',
      voice: expect.objectContaining({ name: 'British English' }),
    });
  });

  it('完成或错误后重置朗读状态', () => {
    installUtteranceMock();
    const synthesis = new MockSynthesis();
    const controller = createSpeechController(synthesis as unknown as SpeechSynthesis);

    expect(controller.speak('first')).toBe(true);
    synthesis.spoken[0].finish();
    expect(controller.isSpeaking()).toBe(false);

    expect(controller.speak('second')).toBe(true);
    synthesis.spoken[1].fail();
    expect(controller.isSpeaking()).toBe(false);
  });

  it('新任务开始后忽略旧 utterance 的迟到结束事件', () => {
    installUtteranceMock();
    const synthesis = new MockSynthesis();
    const controller = createSpeechController(synthesis as unknown as SpeechSynthesis);

    expect(controller.speak('first')).toBe(true);
    const first = synthesis.spoken[0];
    expect(controller.speak('second')).toBe(true);
    first.finish();

    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(controller.isSpeaking()).toBe(true);
  });

  it('stop 取消任务并立即重置状态', () => {
    installUtteranceMock();
    const synthesis = new MockSynthesis();
    const controller = createSpeechController(synthesis as unknown as SpeechSynthesis);

    expect(controller.speak('hello')).toBe(true);
    controller.stop();

    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(controller.isSpeaking()).toBe(false);
  });

  it('空文本和缺少 SpeechSynthesisUtterance 时安全返回 false', () => {
    installUtteranceMock();
    const synthesis = new MockSynthesis();
    const controller = createSpeechController(synthesis as unknown as SpeechSynthesis);

    expect(controller.speak('   ')).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(1);
    expect(synthesis.spoken).toHaveLength(0);

    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    expect(controller.speak('hello')).toBe(false);
    expect(synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(controller.isSpeaking()).toBe(false);
  });

  it('没有注入或全局 speechSynthesis 时安全返回 false', () => {
    installUtteranceMock();
    vi.stubGlobal('speechSynthesis', undefined);

    const controller = createSpeechController();

    expect(controller.speak('hello')).toBe(false);
    expect(controller.isSpeaking()).toBe(false);
    expect(() => controller.stop()).not.toThrow();
  });
});
