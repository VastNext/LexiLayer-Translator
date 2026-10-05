const KANA = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/u;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/u;
const CJK = /\p{Script=Han}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

export function detectSpeechLanguage(text: string): string | undefined {
  if (KANA.test(text)) {
    return 'ja-JP';
  }
  if (HANGUL.test(text)) {
    return 'ko-KR';
  }
  if (CJK.test(text)) {
    return 'zh-CN';
  }
  if (CYRILLIC.test(text)) {
    return 'ru-RU';
  }

  return undefined;
}

function getGlobalSynthesis(): SpeechSynthesis | undefined {
  return typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis;
}

function getUtteranceConstructor(): typeof SpeechSynthesisUtterance | undefined {
  return typeof SpeechSynthesisUtterance === 'undefined' ? undefined : SpeechSynthesisUtterance;
}

function findVoice(synthesis: SpeechSynthesis, language: string): SpeechSynthesisVoice | undefined {
  const normalizedLanguage = language.toLowerCase();
  const languagePrefix = normalizedLanguage.split('-')[0];
  const voices = synthesis.getVoices();

  return voices.find(({ lang }) => lang.toLowerCase() === normalizedLanguage)
    ?? voices.find(({ lang }) => lang.toLowerCase().startsWith(`${normalizedLanguage}-`))
    ?? voices.find(({ lang }) => lang.toLowerCase().split('-')[0] === languagePrefix);
}

export function createSpeechController(synthesis?: SpeechSynthesis): {
  speak(text: string, languageHint?: string): boolean;
  stop(): void;
  isSpeaking(): boolean;
} {
  const speechApi = synthesis ?? getGlobalSynthesis();
  let speaking = false;
  let taskId = 0;

  function reset(): void {
    taskId += 1;
    speaking = false;
  }

  return {
    speak(text, languageHint) {
      reset();
      speechApi?.cancel();

      const normalizedText = text.trim();
      const Utterance = getUtteranceConstructor();
      if (!speechApi || !normalizedText || !Utterance) {
        return false;
      }

      const utterance = new Utterance(normalizedText);
      const language = languageHint?.trim() || detectSpeechLanguage(normalizedText);
      if (language) {
        utterance.lang = language;
        utterance.voice = findVoice(speechApi, language) ?? null;
      }

      const currentTaskId = taskId;
      const finish = (): void => {
        if (taskId === currentTaskId) {
          speaking = false;
        }
      };
      utterance.onend = finish;
      utterance.onerror = finish;

      speaking = true;
      try {
        speechApi.speak(utterance);
        return true;
      } catch {
        finish();
        return false;
      }
    },

    stop() {
      reset();
      speechApi?.cancel();
    },

    isSpeaking() {
      return speaking;
    },
  };
}
