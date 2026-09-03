import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import enMessages from '../../public/_locales/en/messages.json';
import zhMessages from '../../public/_locales/zh_CN/messages.json';
import { OptionsApp, type OptionsApi } from '../../src/options/OptionsApp';
import { PopupApp, type PopupApi } from '../../src/popup/PopupApp';
import { createTranslator, type Translator } from '../../src/shared/i18n';
import { DEFAULT_SETTINGS } from '../../src/shared/config';

type Messages = Record<string, { message: string }>;

function translatorFor(messages: Messages): Translator {
  return createTranslator((key: string) => messages[key]?.message ?? '');
}

const en = translatorFor(enMessages as Messages);
const zh = translatorFor(zhMessages as Messages);

const popupApi: PopupApi = {
  getConfig: async () => ({}),
  sendToPage: async () => undefined,
  setTranslationBadge: async () => undefined,
  openOptions: () => undefined,
  getProgress: async () => undefined,
  subscribeProgress: () => () => undefined,
};

const optionsApiStub = {
  load: async () => DEFAULT_SETTINGS,
  getEngineApiKey: async () => '',
  savePreferences: async () => undefined,
  upsertEngine: async () => undefined,
  deleteEngine: async () => undefined,
  setActiveEngine: async () => undefined,
  setEngineEnabled: async () => undefined,
  reorderEngines: async () => undefined,
  testEngine: async () => undefined,
  clearEngineApiKey: async () => undefined,
  importSettings: async () => undefined,
  clearCache: async () => undefined,
  exportSettings: () => undefined,
  saveTheme: async () => undefined,
} as unknown as OptionsApi;

describe('品牌文案运行时本地化', () => {
  it('中英文 locale 提供完整品牌、短品牌和 Options 窗口标题', () => {
    expect(zhMessages.extensionName.message).toBe('语层翻译');
    expect(enMessages.extensionName.message).toBe('LexiLayer Translator');
    expect(zhMessages.brandShort.message).toBe('语层');
    expect(enMessages.brandShort.message).toBe('LexiLayer');
    expect(zhMessages.optionsDocumentTitle.message).toBe('语层翻译设置');
    expect(enMessages.optionsDocumentTitle.message).toBe('LexiLayer Translator Settings');
  });

  it('Popup 品牌区按当前语言渲染完整品牌和 BrandMark aria', () => {
    const enView = render(<PopupApp api={popupApi} t={en} />);
    expect(screen.getByText('LexiLayer Translator', { exact: true })).toBeVisible();
    expect(screen.getByRole('img', { name: 'LexiLayer Translator' })).toBeInTheDocument();
    enView.unmount();

    const zhView = render(<PopupApp api={popupApi} t={zh} />);
    expect(screen.getByText('语层翻译', { exact: true })).toBeVisible();
    expect(screen.getByRole('img', { name: '语层翻译' })).toBeInTheDocument();
    zhView.unmount();
  });

  it('Options 品牌区按当前语言渲染完整品牌和 BrandMark aria', () => {
    const enView = render(<OptionsApp api={optionsApiStub} t={en} />);
    expect(screen.getAllByText('LexiLayer Translator', { exact: true })).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'LexiLayer Translator' })).toBeInTheDocument();
    enView.unmount();

    const zhView = render(<OptionsApp api={optionsApiStub} t={zh} />);
    expect(screen.getAllByText('语层翻译', { exact: true })).toHaveLength(2);
    expect(screen.getByRole('img', { name: '语层翻译' })).toBeInTheDocument();
    zhView.unmount();
  });

  it('Options masthead 眉题按当前语言渲染完整品牌，不硬编码', () => {
    const enView = render(<OptionsApp api={optionsApiStub} t={en} />);
    expect(enView.container.querySelector('.masthead .eyebrow')?.textContent).toBe('LexiLayer Translator');
    enView.unmount();

    const zhView = render(<OptionsApp api={optionsApiStub} t={zh} />);
    expect(zhView.container.querySelector('.masthead .eyebrow')?.textContent).toBe('语层翻译');
    zhView.unmount();
  });

  it('入口通过 i18n 键设置窗口标题，不硬编码语言', () => {
    const popupEntry = readFileSync(resolve(import.meta.dirname, '../../src/popup/index.tsx'), 'utf8');
    const optionsEntry = readFileSync(resolve(import.meta.dirname, '../../src/options/index.tsx'), 'utf8');
    expect(popupEntry).toContain("document.title = t('extensionName')");
    expect(optionsEntry).toContain("document.title = t('optionsDocumentTitle')");
    expect(popupEntry).not.toMatch(/document\.title\s*=\s*['"`][^'"`]*['"`]/);
    expect(optionsEntry).not.toMatch(/document\.title\s*=\s*['"`][^'"`]*['"`]/);
  });
});
