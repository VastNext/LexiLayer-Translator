import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const expectedTag = `v${packageJson.version}`;
const suppliedTag = process.argv[2];

if (suppliedTag && suppliedTag !== expectedTag) {
  throw new Error(`标签 ${suppliedTag} 与 package.json 版本 ${packageJson.version} 不一致，应为 ${expectedTag}`);
}

const dist = resolve(root, 'dist');
if (!existsSync(dist)) throw new Error('缺少 dist/，请先运行 npm run build');

const manifestPath = resolve(dist, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('dist/ 根目录缺少 manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== packageJson.version) {
  throw new Error(`Manifest 版本 ${manifest.version} 与 package.json 版本 ${packageJson.version} 不一致`);
}

const required = ['background.js', 'content.js', 'popup.html', 'options.html', 'icons', '_locales', 'assets', 'rules'];
for (const entry of required) {
  if (!existsSync(resolve(dist, entry))) throw new Error(`发行目录缺少 ${entry}`);
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

console.log(JSON.stringify({ version: packageJson.version, tag: expectedTag, packageName: `vast-translator-${packageJson.version}-chrome-web-store.zip` }));
