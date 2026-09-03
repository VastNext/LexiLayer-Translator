import { describe, expect, it } from 'vitest';

import { manifest } from '../../src/manifest';
import packageJson from '../../package.json' with { type: 'json' };
import enMessages from '../../public/_locales/en/messages.json' with { type: 'json' };
import zhMessages from '../../public/_locales/zh_CN/messages.json' with { type: 'json' };

describe('manifest', () => {
  it('声明完整的 Manifest V3 入口、权限与快捷键', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toContain('<all_urls>');
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'contextMenus', 'scripting']));
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.options_page).toBe('options.html');
    expect(manifest.background?.service_worker).toBe('background.js');
    expect(manifest.content_scripts).toEqual([
      expect.objectContaining({
        matches: ['<all_urls>'],
        js: ['content.js'],
      }),
    ]);
    expect(manifest.web_accessible_resources).toEqual([{
      resources: [
        'rules/google-search.json',
        'rules/bing-search.json',
        'rules/github.json',
        'rules/youtube.json',
        'rules/reddit.json',
        'rules/x.json',
        'rules/stackoverflow.json',
         'rules/substack.json', 'experts.json',
      ],
      matches: ['<all_urls>'],
    }]);
    expect(manifest.commands?.translate_page?.suggested_key?.default).toBe('Alt+A');
  });

  it('声明当前包版本、本地化名称描述和全尺寸原创图标', () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    expect(manifest.default_locale).toBe('zh_CN');
    expect(zhMessages.extensionName.message).toBe('语层翻译');
    expect(enMessages.extensionName.message).toBe('LexiLayer Translator');
     expect(manifest.icons).toEqual({
       16: 'icons/icon-16.png', 32: 'icons/icon-32.png',
       48: 'icons/icon-48.png', 128: 'icons/icon-128.png',
     });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(manifest.commands.translate_page.description).toBe('__MSG_commandTranslatePage__');
  });
});
