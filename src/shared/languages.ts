export const SUPPORTED_LANGUAGES = [
  'zh-Hans',
  'zh-Hant',
  'en',
  'ja',
  'ko',
  'fr',
  'it',
  'de',
  'es',
  'pt',
  'ru',
  'ar',
] as const;

const supportedLanguages = new Set<string>(SUPPORTED_LANGUAGES);

export const languageOptions = [
  { value: 'auto', label: '自动判断' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'ar', label: 'العربية' },
] as const;

export function normalizeLanguage(language: string): string {
  const normalized = language.trim().replace('_', '-');
  const lower = normalized.toLowerCase();

  if (lower.startsWith('zh')) {
    return /-(tw|hk|mo|hant)(?:-|$)/i.test(normalized) ? 'zh-Hant' : 'zh-Hans';
  }

  return lower.split('-')[0];
}

export function mapChromeUiLanguage(uiLanguage: string): string {
  const language = normalizeLanguage(uiLanguage);
  return supportedLanguages.has(language) ? language : 'en';
}

export function chooseTargetLanguage(pageLanguage: string, preferredTarget: string): string {
  const page = normalizeLanguage(pageLanguage);
  const target = normalizeLanguage(preferredTarget === 'auto' ? 'en' : preferredTarget);

  if (page !== target) {
    return preferredTarget;
  }

  return target === 'en' ? 'zh-Hans' : 'en';
}
