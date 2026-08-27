import { describe, expect, it } from 'vitest';

import { manifest } from '../../src/manifest';

describe('manifest', () => {
  it('声明完整的 Manifest V3 入口、权限与快捷键', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toContain('<all_urls>');
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'contextMenus']));
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
        'rules/substack.json',
      ],
      matches: ['<all_urls>'],
    }]);
    expect(manifest.commands?.translate_page?.suggested_key?.default).toBe('Alt+Shift+A');
  });

  it('声明 0.2.0、本地化名称描述和全尺寸原创图标', () => {
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    expect(manifest.default_locale).toBe('zh_CN');
    expect(manifest.icons).toEqual({
      16: 'icons/icon-16.png', 32: 'icons/icon-32.png',
      48: 'icons/icon-48.png', 128: 'icons/icon-128.png',
    });
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    expect(manifest.commands.translate_page.description).toBe('__MSG_commandTranslatePage__');
  });
});
