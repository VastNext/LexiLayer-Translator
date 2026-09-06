import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateDist } from '../../scripts/validate-release.mjs';

// 使用独立临时 fixture 校验发行目录，不删除或触碰真实 dist/（其他构建测试依赖它）。
const FIXTURE_VERSION = '9.9.9';

function createFixtureDist(): string {
  const dist = mkdtempSync(resolve(tmpdir(), 'lexilayer-release-validator-'));
  for (const entry of ['icons', '_locales/zh_CN', 'assets', 'rules']) {
    mkdirSync(resolve(dist, entry), { recursive: true });
  }
  writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify({
    version: FIXTURE_VERSION,
    background: { service_worker: 'background.js' },
    content_scripts: [{
      matches: ['<all_urls>'],
      js: ['content.js', 'content-inline.js', 'content-main.js'],
      css: ['content.css', 'content-inline.css'],
    }],
  }));
  writeFileSync(resolve(dist, 'background.js'), '');
  writeFileSync(resolve(dist, 'popup.html'), '');
  writeFileSync(resolve(dist, 'options.html'), '');
  for (const file of ['content.js', 'content-inline.js', 'content-main.js', 'content.css', 'content-inline.css']) {
    writeFileSync(resolve(dist, file), '');
  }
  return dist;
}

describe('发行校验器', () => {
  it('完整 fixture 通过：manifest 声明的 content_scripts js/css 全部存在', () => {
    const dist = createFixtureDist();
    try {
      expect(() => validateDist(dist, FIXTURE_VERSION)).not.toThrow();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('content_scripts 缺少任一脚本或样式即失败（新增脚本漏构建被拦截）', () => {
    for (const missing of ['content.js', 'content-inline.js', 'content-main.js', 'content.css', 'content-inline.css']) {
      const dist = createFixtureDist();
      try {
        rmSync(resolve(dist, missing));
        expect(() => validateDist(dist, FIXTURE_VERSION)).toThrow(new RegExp(`缺少文件 ${missing}`));
      } finally {
        rmSync(dist, { recursive: true, force: true });
      }
    }
  });

  it('manifest 版本与期望版本不一致即失败', () => {
    const dist = createFixtureDist();
    try {
      expect(() => validateDist(dist, '0.0.1')).toThrow(/Manifest 版本/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('缺少必需入口（background.js）即失败', () => {
    const dist = createFixtureDist();
    try {
      rmSync(resolve(dist, 'background.js'));
      expect(() => validateDist(dist, FIXTURE_VERSION)).toThrow(/发行目录缺少 background\.js/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('发行目录包含禁止文件即失败', () => {
    const dist = createFixtureDist();
    try {
      writeFileSync(resolve(dist, 'error.log'), '');
      expect(() => validateDist(dist, FIXTURE_VERSION)).toThrow(/发行目录包含禁止文件/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
