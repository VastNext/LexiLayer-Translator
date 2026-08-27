import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
