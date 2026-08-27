import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('扩展入口体积预算', () => {
  it('content 至少保留 500B、background 保持低于 30KiB', async () => {
    const root = resolve(import.meta.dirname, '../..');
    await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent' });
    for (const file of ['content.js', 'background.js'] as const) {
      const bytes = statSync(resolve(root, 'dist', file)).size;
      const limit = 30 * 1024 - (file === 'content.js' ? 500 : 0);
      expect(bytes, `${file} 为 ${bytes} bytes，超过 ${limit} bytes 原始体积预算`).toBeLessThanOrEqual(limit);
    }
  });
});
