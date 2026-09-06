import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 校验一个发行目录：manifest 版本一致、必需入口存在、
 * manifest 声明的 content_scripts js/css 全部真实存在、无禁止文件。
 * 独立函数 + 可传目录，便于测试用临时 fixture 验证而不触碰真实 dist/。
 */
export function validateDist(dist, expectedVersion) {
  if (!existsSync(dist)) throw new Error('缺少 dist/，请先运行 npm run build');

  const manifestPath = resolve(dist, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('dist/ 根目录缺少 manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== expectedVersion) {
    throw new Error(`Manifest 版本 ${manifest.version} 与 package.json 版本 ${expectedVersion} 不一致`);
  }

  const required = ['background.js', 'popup.html', 'options.html', 'icons', '_locales', 'assets', 'rules'];
  for (const entry of required) {
    if (!existsSync(resolve(dist, entry))) throw new Error(`发行目录缺少 ${entry}`);
  }

  // 从 manifest 遍历 content_scripts：声明注入的每个脚本与样式都必须真实存在，
  // 新增内容脚本漏进构建或漏进发行包时在此拦截。
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  if (!contentScripts.length) throw new Error('manifest 未声明 content_scripts');
  for (const script of contentScripts) {
    for (const file of [...(script.js ?? []), ...(script.css ?? [])]) {
      if (!existsSync(resolve(dist, file))) throw new Error(`manifest content_scripts 缺少文件 ${file}`);
    }
  }

  const forbidden = [/^\.env(?:\.|$)/, /(?:^|\/)error\.log$/, /(?:^|\/)research(?:\/|$)/, /(?:^|\/)tests?(?:\/|$)/, /\.map$/];
  function walk(directory) {
    return readdirSync(directory).flatMap((entry) => {
      const path = resolve(directory, entry);
      return statSync(path).isDirectory() ? walk(path) : [relative(dist, path).split(sep).join('/')];
    });
  }
  for (const file of walk(dist)) {
    if (forbidden.some((pattern) => pattern.test(file))) throw new Error(`发行目录包含禁止文件：${file}`);
  }

  return manifest;
}

/**
 * 以仓库根为基准执行完整发行校验，返回版本信息供 CLI 输出。
 */
export function validateRelease(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const manifest = validateDist(resolve(root, 'dist'), packageJson.version);
  return { packageJson, manifest };
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const { packageJson } = validateRelease(root);
  const expectedTag = `v${packageJson.version}`;
  const suppliedTag = process.argv[2];

  if (suppliedTag && suppliedTag !== expectedTag) {
    throw new Error(`标签 ${suppliedTag} 与 package.json 版本 ${packageJson.version} 不一致，应为 ${expectedTag}`);
  }

  console.log(JSON.stringify({ version: packageJson.version, tag: expectedTag, packageName: `lexilayer-translator-${packageJson.version}-chrome-web-store.zip` }));
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
