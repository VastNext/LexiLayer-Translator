import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

// 各注入脚本独立预算：新脚本必须有自己的上限，避免在 content.js 之下静默膨胀。
// content-main.js 承载原 content.js 的装配层（渲染器/观察器/调度），
// content-inline.js 是内联渲染器与样式。分脚本预算只约束单个文件，不能掩盖总量。
const budgets = {
  'content.js': 38 * 1024,
  'content-main.js': 38 * 1024,
  'content-inline.js': 8 * 1024,
  'background.js': 32 * 1024,
} as const;

// 真实累计：三个 content 脚本按 manifest 顺序常驻于每个网页的同一个隔离世界，
// 浏览器实际下载并执行的 JS 总量是三者之和（content.css 与 content-inline.css
// 为独立样式注入，不计入 JS 预算）。
// 0.10.7 经用户确认将项目内部累计预算由 48KiB 调整为 52KiB，容纳挂载归属与
// 任务生命周期修复；各入口上限不变。本预算不是 Chrome Web Store 的限制。
const contentScripts = ['content.js', 'content-inline.js', 'content-main.js'] as const;
const contentTotalBudget = 52 * 1024;

describe('扩展入口体积预算', () => {
  it('每个注入脚本保持各自的原始体积预算', async () => {
    const root = resolve(import.meta.dirname, '../..');
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });
    for (const [file, limit] of Object.entries(budgets)) {
      const bytes = statSync(resolve(root, 'dist', file)).size;
      expect(bytes, `${file} 为 ${bytes} bytes，超过 ${limit} bytes 原始体积预算`).toBeLessThanOrEqual(limit);
    }
  });

  it('content 相关脚本真实累计不超过 52KiB，避免拆分掩盖总量膨胀', async () => {
    const root = resolve(import.meta.dirname, '../..');
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });
    const sizes = contentScripts.map((file) => statSync(resolve(root, 'dist', file)).size);
    const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
    expect(total, `content 相关脚本累计 ${sizes.join(' + ')} = ${total} bytes，超过 ${contentTotalBudget} bytes 总预算`).toBeLessThanOrEqual(contentTotalBudget);
  });
});
