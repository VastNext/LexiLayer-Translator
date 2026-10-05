import { extractSentence } from '../shared/sentence';
import { createSpeechController } from '../shared/speech';

export interface SelectionFeatures {
  speak(text: string, languageHint?: string): boolean;
  stopSpeaking(): void;
  isSpeaking(): boolean;
  addVocabulary(input: { word: string; blockText?: string; translation: string; targetLanguage: string }): Promise<'created' | 'duplicate'>;
}

const speech = createSpeechController();
const selectionFeatures: SelectionFeatures = {
  speak: (text, languageHint) => speech.speak(text, languageHint),
  stopSpeaking: () => speech.stop(),
  isSpeaking: () => speech.isSpeaking(),
  async addVocabulary({ word, blockText = '', translation, targetLanguage }) {
    const { href: sourceUrl, protocol } = document.location;
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('Unsupported source URL');
    const response = await chrome.runtime.sendMessage({
      type: 'save-vocabulary-entry',
      draft: {
        word,
        sentence: extractSentence(blockText, word),
        translation,
        sourceUrl,
        pageTitle: document.title,
        sourceLanguage: 'auto',
        targetLanguage,
      },
    }) as { ok?: boolean; data?: { status?: 'created' | 'duplicate' }; error?: string };
    if (!response?.ok || !response.data?.status) throw new Error(response?.error);
    return response.data.status;
  },
};

(globalThis as typeof globalThis & {
  __vastSelectionFeatures?: SelectionFeatures;
}).__vastSelectionFeatures = selectionFeatures;
