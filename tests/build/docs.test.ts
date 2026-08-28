import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const requiredLocaleKeys = [
  'builtinEngines', 'googleDefaultFree', 'bingBackup', 'builtin', 'activeDefault', 'enabled', 'setDefault',
  'customAiEngines', 'customAiDescription', 'engineName', 'saveEngine', 'moveUp', 'moveDown', 'deleteEngine',
  'confirmDeleteEngine', 'confirmDeleteEngineAction', 'addCustomAi', 'newCustomAi', 'engineOriginChanged',
  'instructionCustomOnly', 'savePreferences', 'statusEngineSaved', 'statusEngineUpdated', 'statusActiveChanged',
  'statusOrderSaved', 'statusEngineDeleted', 'importApplied',
] as const;

describe('文档发布契约', () => {
  it('设计文档不包含绝对本机路径', async () => {
    const design = await readFile(resolve('docs/plans/2026-08-27-vast-translator-design.md'), 'utf8');

    expect(design).not.toMatch(/[A-Za-z]:\\/);
  });

  it('隐私说明准确描述页面进度的浏览器会话存储', async () => {
    const privacy = await readFile(resolve('PRIVACY.md'), 'utf8');

    expect(privacy).toContain('`chrome.storage.session`');
    expect(privacy).toMatch(/浏览器会话/);
    expect(privacy).toMatch(/不(?:写入|保存到).*`chrome\.storage\.(?:sync|local)`/);
  });

  it('中英文 locale 完整覆盖多实例 Options 文案', async () => {
    const [zh, en] = await Promise.all([
      readFile(resolve('public/_locales/zh_CN/messages.json'), 'utf8').then(JSON.parse),
      readFile(resolve('public/_locales/en/messages.json'), 'utf8').then(JSON.parse),
    ]);

    for (const key of requiredLocaleKeys) {
      expect(zh, `简体中文缺少 ${key}`).toHaveProperty(`${key}.message`);
      expect(en, `英文缺少 ${key}`).toHaveProperty(`${key}.message`);
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('0.3.0 文档说明默认/备用/多 custom、端点、429、测试代理、迁移和能力差异', async () => {
    const [pkg, readme, privacy, design, implementation] = await Promise.all([
      readFile(resolve('package.json'), 'utf8'),
      readFile(resolve('README.md'), 'utf8'),
      readFile(resolve('PRIVACY.md'), 'utf8'),
      readFile(resolve('docs/plans/2026-08-27-vast-translator-design.md'), 'utf8'),
      readFile(resolve('docs/plans/2026-08-27-vast-translator-implementation.md'), 'utf8'),
    ]);
    const all = [readme, privacy, design, implementation].join('\n');

    expect(JSON.parse(pkg)).toHaveProperty('version', '0.3.0');
    expect(readme).toContain('0.3.0');
    expect(privacy).toContain('0.3.0');
    expect(all).toMatch(/Google.*默认/s);
    expect(all).toMatch(/Bing.*备用/s);
    expect(all).toMatch(/多个.*自定义 AI|多.*custom/i);
    expect(privacy).toContain('https://translate.googleapis.com/translate_a/t');
    expect(privacy).toContain('https://edge.microsoft.com/translate/translatetext');
    expect(privacy).not.toContain('/translate_a/single');
    expect(privacy).not.toContain('api-edge.cognitive.microsofttranslator.com');
    expect(all).toMatch(/429/);
    expect(all).toMatch(/代理.*仅.*测试|仅.*测试.*代理/s);
    expect(all).toMatch(/迁移/);
    expect(all).toMatch(/流式.*自定义 AI|自定义 AI.*流式/s);
  });

  it('Chrome Web Store 上架资料覆盖权限、隐私、审核、素材和发布门禁', async () => {
    const files = await Promise.all([
      'README.md', 'store-listing.md', 'privacy-and-review.md', 'release-checklist.md',
    ].map((file) => readFile(resolve('docs/chrome-web-store', file), 'utf8')));
    const all = files.join('\n');

    expect(all).toContain('<all_urls>');
    expect(all).toContain('`scripting`');
    expect(all).toContain('Limited Use');
    expect(all).toMatch(/Remote Code.{0,20}(?:No|否)/s);
    expect(all).toContain('Authentication information');
    expect(all).toContain('Website content');
    expect(all).toContain('Trader / Non-Trader');
    expect(all).toContain('1280×800');
    expect(all).toContain('440×280');
    expect(all).toContain('PUBLIC_REVIEW_FIXTURE_URL');
    expect(all).toMatch(/Google\/Bing.*许可|Google\/Bing.*服务条款/s);
    expect(all).toMatch(/ZIP.*manifest\.json/s);
    expect(all).not.toMatch(/[A-Za-z]:\\/);
  });
});
