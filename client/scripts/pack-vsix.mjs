// pack-vsix.mjs —— 跨平台打包 Trae 采集扩展 VSIX（纯 Node，无 npm 依赖）。
// 与 build.ps1 等价：输出 zip 结构 VSIX（正斜杠路径、固定时间戳的可复现构建），
// 供 Windows 本地打包与镜像构建（Dockerfile dist 阶段）共用；产物不入库（.gitignore 已排除）。
//
// 用法：node scripts/pack-vsix.mjs [输出目录]（默认 ../server/public/dl/trae-extension/<version>/）
// 输出：<out>/trae-credits-poc-<version>.vsix + .sha256 + 上级目录的 latest.json
import { deflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'trae-extension');
const pkg = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = `trae-credits-poc-${VERSION}.vsix`;

// 固定 DOS 时间戳（2026-01-01 00:00:00）保证同源码产出逐字节一致
const DOS_TIME = ((0 << 9) | (1 << 5) | 0) & 0xffff;        // hh:mm:ss
const DOS_DATE = (((2026 - 1980) << 9) | (1 << 5) | 1) & 0xffff; // yy:mm:dd

/** 生成 manifest（与扩展 ID/publisher 一致，版本取 package.json） */
export function manifestXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="trae-credits-poc" Version="${VERSION}" Publisher="local-poc"/>
    <DisplayName>Trae Credits 采集扩展</DisplayName>
    <Description xml:space="preserve">Read-only per-session credits query via icube.common.getToken; writes a local daily snapshot. No token logging.</Description>
    <Tags>credits,usage</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.70.0"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="cjs" ContentType="text/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
</Types>
`;

const EXTENSION_FILES = ['package.json', 'extension.js', 'model-resolve.cjs', 'README.md'];

/** 极简 zip 写入：本地头 + 中央目录 + EOCD，DEFLATE 压缩、正斜杠路径。 */
export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dos = ((DOS_DATE << 16) | DOS_TIME) >>> 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(dos, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);          // version made by
    entry.writeUInt16LE(20, 6);          // version needed
    entry.writeUInt16LE(0, 8);           // flags
    entry.writeUInt16LE(8, 10);          // deflate（与本地头一致）
    entry.writeUInt32LE(dos, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30);          // extra
    entry.writeUInt16LE(0, 32);          // comment
    entry.writeUInt16LE(0, 34);          // disk
    entry.writeUInt16LE(0, 36);          // internal attrs
    entry.writeUInt32LE(0, 38);          // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 解析中央目录列出条目（测试与自校验用）。 */
export function readEntries(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip: missing EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  let at = eocd - size;
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

export function pack({ outDir } = {}) {
  const files = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['extension.vsixmanifest', manifestXml()],
    ...EXTENSION_FILES.map((name) => [`extension/${name}`, readFileSync(join(EXT, name), 'utf8')]),
  ];
  const missing = EXTENSION_FILES.filter((name) => !existsSync(join(EXT, name)));
  if (missing.length) throw new Error(`扩展源文件缺失：${missing.join(', ')}`);
  if (manifestXml().match(/<Identity[^>]*Version="([^"]+)"/)[1] !== VERSION) {
    throw new Error('manifest 版本与 package.json 不一致');
  }
  const vsix = buildZip(files);
  const dir = outDir || join(ROOT, '..', 'server', 'public', 'dl', 'trae-extension', VERSION);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, NAME), vsix);
  const sha256 = createHash('sha256').update(vsix).digest('hex');
  writeFileSync(join(dir, `${NAME}.sha256`), `${sha256}\n`);
  writeFileSync(join(dirname(dir), 'latest.json'), JSON.stringify({
    name: 'trae-credits-poc', version: VERSION,
    vsix: `/dl/trae-extension/${VERSION}/${NAME}`,
    sha256, size: vsix.length, published_at: new Date().toISOString(), min_host: '1.90.0',
  }, null, 2) + '\n');
  return { file: join(dir, NAME), sha256, size: vsix.length, version: VERSION, entries: readEntries(vsix) };
}

// 直接执行时打包到默认目录
if (process.argv[1] && process.argv[1].endsWith('pack-vsix.mjs')) {
  const result = pack(process.argv[2] ? { outDir: process.argv[2] } : {});
  console.log(`已打包扩展 ${result.version}：${result.file}（${result.size} 字节，${result.entries.length} 个条目）`);
  console.log(`sha256 ${result.sha256}`);
}
