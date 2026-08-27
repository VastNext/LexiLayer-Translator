import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('扩展入口体积预算', () => {
  it('content 与 background 原始 bundle 均小于 30KB', async () => {
    const root = resolve(import.meta.dirname, '../..');
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });
    for (const file of ['content.js', 'background.js']) {
      const bytes = statSync(resolve(root, 'dist', file)).size;
      expect(bytes, `${file} 为 ${bytes} bytes，超过 30KB 原始体积预算`).toBeLessThan(30 * 1024);
    }
  });
});
