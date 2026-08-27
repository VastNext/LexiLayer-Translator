import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

interface BuiltManifest {
  action?: { default_popup?: string };
  options_page?: string;
  background?: { service_worker?: string };
  content_scripts?: Array<{ js?: string[]; css?: string[] }>;
  web_accessible_resources?: Array<{ resources: string[]; matches: string[] }>;
  icons?: Record<string, string>;
  default_locale?: string;
}

describe('生产构建', () => {
  it('popup 与 options 文档声明简体中文语言', () => {
    const root = resolve(import.meta.dirname, '../..');
    for (const entry of ['popup.html', 'options.html']) {
      expect(readFileSync(resolve(root, entry), 'utf8')).toContain('<html lang="zh-CN">');
    }
  });

  it('生成 manifest 引用的全部扩展入口文件', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const outputDirectory = resolve(root, 'dist');
    rmSync(outputDirectory, { recursive: true, force: true });

    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });

    const manifestPath = resolve(outputDirectory, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuiltManifest;
    const references = [
      manifest.action?.default_popup,
      manifest.options_page,
      manifest.background?.service_worker,
      ...manifest.content_scripts?.flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]) ?? [],
    ].filter((reference): reference is string => Boolean(reference));

    expect(references.length).toBeGreaterThanOrEqual(4);
    for (const reference of references) {
      expect(reference, `${reference} 不得引用源码目录`).not.toMatch(/^src\//);
      expect(existsSync(resolve(outputDirectory, reference)), `缺少构建文件 ${reference}`).toBe(true);
    }
  });

  it('生成并仅公开八个站点规则动态 chunk', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const outputDirectory = resolve(root, 'dist');
    rmSync(outputDirectory, { recursive: true, force: true });
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });

    const manifest = JSON.parse(readFileSync(resolve(outputDirectory, 'manifest.json'), 'utf8')) as BuiltManifest;
    const resources = manifest.web_accessible_resources?.[0]?.resources ?? [];
    const contentBundle = readFileSync(resolve(outputDirectory, 'content.js'), 'utf8');
    const siteIds = [
      'google-search', 'bing-search', 'github', 'youtube',
      'reddit', 'x', 'stackoverflow', 'substack',
    ];

    expect(resources).toHaveLength(siteIds.length);
    for (const siteId of siteIds) {
      const pattern = `rules/${siteId}.json`;
      expect(resources).toContain(pattern);
      expect(existsSync(resolve(outputDirectory, pattern))).toBe(true);
    }
    expect(contentBundle).toContain('rules/');
    expect(contentBundle).not.toContain('import.meta');
    expect(contentBundle).not.toMatch(/^\s*import\b/m);
  });

  it('复制图标、SVG 源图和中英本地化资源', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const outputDirectory = resolve(root, 'dist');
    rmSync(outputDirectory, { recursive: true, force: true });
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });
    const manifest = JSON.parse(readFileSync(resolve(outputDirectory, 'manifest.json'), 'utf8')) as BuiltManifest;
    expect(manifest.default_locale).toBe('zh_CN');
    for (const size of [16, 32, 48, 128]) {
      const icon = manifest.icons?.[String(size)];
      expect(icon).toBe(`icons/icon-${size}.png`);
      expect(existsSync(resolve(outputDirectory, icon!))).toBe(true);
    }
    expect(existsSync(resolve(outputDirectory, 'icons/vast-translator.svg'))).toBe(true);
    for (const locale of ['zh_CN', 'en']) {
      const path = resolve(outputDirectory, `_locales/${locale}/messages.json`);
      expect(existsSync(path)).toBe(true);
      const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { message: string }>;
      expect(messages.extensionName?.message).toBeTruthy();
      expect(messages.extensionDescription?.message).toBeTruthy();
      expect(messages.commandTranslatePage?.message).toBeTruthy();
    }
  });
});
