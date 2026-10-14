import { readdirSync, readFileSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (['.js', '.mjs'].includes(extname(path))) files.push(path);
  }
}
collect(resolve(root, 'src'));
collect(resolve(root, 'tools'));
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
if (!html.includes('lang="zh-CN"')) throw new Error('入口须声明中文语言。');
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)) {
  const target = resolve(root, match[1]);
  if (relative(root, target).startsWith('..')) throw new Error('入口引用超出项目目录。');
  readFileSync(target);
}
console.log(`通过：${files.length} 个 JavaScript 文件语法检查，以及入口本地资源检查。`);
