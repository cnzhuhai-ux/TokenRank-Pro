import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'miniprogram/assets/badges');
const target = join(root, 'server/public/app/assets/badges');
for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
  const parent = entry.parentPath || entry.path;
  const relative = parent.slice(source.length);
  mkdirSync(join(target, relative), { recursive: true });
  cpSync(join(parent, entry.name), join(target, relative, entry.name));
}
console.log('飞书网页奖章已从小程序 PNG 资源同步。');
