import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface LockEntry { version?: string; license?: string; licenses?: { type: string }[]; dev?: boolean; devOptional?: boolean; resolved?: string; link?: boolean }
// Packages of the plug-in workspace itself, under the plug-in's MIT licence,
// and dependencies whose package metadata omits a licence their files state.
const known: Record<string, string> = {
  'tabularium-cli': 'MIT',
  'webpeer': 'MIT',
  // A Mermaid dependency whose package.json names no licence; its licence file is MIT.
  'khroma': 'MIT',
};

/** Licence list for the plug-in's production dependencies and the runtime images; fails on an unidentified licence. */
export async function licenceList(root: string, images: { nodeImage: string; couchImage: string }) {
  const lock = JSON.parse(await readFile(join(root, 'apps/obsidian/package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> };
  const groups = new Map<string, string[]>();
  const copyleft: string[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || entry.dev || entry.devOptional) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    // A workspace package is a link without version or licence in the lock file; its own entry has them.
    if (entry.link) Object.assign(entry, lock.packages[entry.resolved!]);
    // The lock file drops the old `licenses` array, so fall back to the installed package metadata.
    const installed = entry.license ? undefined : JSON.parse(await readFile(join(root, 'apps/obsidian', path, 'package.json'), 'utf8')) as LockEntry;
    const licence = known[name] ?? entry.license ?? installed?.license ?? installed?.licenses?.map(l => l.type).join(' OR ');
    if (!licence) throw new Error(`No licence recorded for ${name}`);
    groups.set(licence, [...(groups.get(licence) ?? []), `${name}@${entry.version}`]);
    if (/MPL|GPL/.test(licence)) {
      const meta = JSON.parse(await readFile(join(root, 'apps/obsidian', path, 'package.json'), 'utf8'));
      const repository = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
      copyleft.push(`- ${name}@${entry.version}（${licence}）：未经修改，源码见 ${repository ?? entry.resolved}`);
    }
  }
  const sections = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([licence, names]) => `### ${licence}\n\n${names.sort().map(n => `- ${n}`).join('\n')}`);
  // The server image: the gateway's runtime packages from the root lock file, and the CLI packages collected for Tabularius.
  const serverLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry & { link?: boolean }> };
  const server = new Map<string, string[]>();
  const serverCopyleft: string[] = [];
  const add = (licence: string | undefined, name: string, version: string | undefined, repository?: string | null) => {
    if (!licence) throw new Error(`No licence recorded for ${name}`);
    server.set(licence, [...(server.get(licence) ?? []), `${name}@${version}`]);
    if (/MPL|GPL/.test(licence)) serverCopyleft.push(`- ${name}@${version}（${licence}）：未经修改，源码见 ${repository}`);
  };
  // The closure of the server workspace's dependencies, resolved the way npm lays them out (nested first, then hoisted).
  const seen = new Set<string>();
  const visit = (dependencies: Record<string, string> | undefined, from: string) => {
    for (const name of Object.keys(dependencies ?? {})) {
      const candidates = [];
      for (let dir = from; ; dir = dir.includes('/node_modules/') ? dir.slice(0, dir.lastIndexOf('/node_modules/')) : '') {
        candidates.push(`${dir ? `${dir}/` : ''}node_modules/${name}`);
        if (!dir) break;
      }
      const path = candidates.find(candidate => serverLock.packages[candidate]);
      if (!path) throw new Error(`${name} is not in package-lock.json`);
      if (seen.has(path)) continue;
      seen.add(path);
      const entry = serverLock.packages[path] as LockEntry & { dependencies?: Record<string, string> };
      // Older packages (ssh2) declare `licenses: [{ type }]`, which the lock file does not record.
      const legacy = () => (JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as { licenses?: { type: string }[] }).licenses?.map(l => l.type).join(' OR ');
      add(entry.license ?? legacy(), name, entry.version, entry.resolved);
      visit(entry.dependencies, path);
    }
  };
  visit((serverLock.packages['apps/server'] as { dependencies?: Record<string, string> }).dependencies, '');
  const cli = JSON.parse(await readFile(join(root, 'apps/server/cli-dist/packages.json'), 'utf8')) as { name: string; version: string; license: string | null; repository: string | null }[];
  for (const entry of cli) add(entry.license ?? undefined, entry.name, entry.version, entry.repository);
  const serverSections = [...server].sort(([a], [b]) => a.localeCompare(b)).map(([licence, names]) => `### ${licence}\n\n${[...new Set(names)].sort().map(n => `- ${n}`).join('\n')}`);
  return `# 第三方组件许可

## Obsidian 插件

插件以 MIT 许可发布（插件目录中的 LICENSE）。插件与同步核心 \`@tabularium/sync-core\` 的部分代码派生自 vorotamoroz 的 MIT 代码（Copyright (c) 2021、2022 vorotamoroz），版权与许可声明见插件目录中的 NOTICE.md。下表列出插件工程的全部生产依赖，打包进 \`main.js\` 的是其中被插件引用的部分。

${copyleft.length ? `需要单独说明的组件：\n\n${copyleft.join('\n')}\n\n` : ''}${sections.join('\n\n')}

## 服务器镜像

- 运行时基础镜像 \`${images.nodeImage}\`：Node.js（MIT，附带组件见镜像内 /usr/local/share/doc 与 Node.js 的 LICENSE），Debian bookworm 基础系统（各软件包许可见镜像内 /usr/share/doc/*/copyright）。
- CouchDB \`${images.couchImage}\`：Apache License 2.0，以官方镜像独立运行，未经修改。
- npm 运行时依赖：网关用于 Tabularius 的提供商 SDK 与口令校验，以及 Tabularius 托管客户端使用的命令行客户端（MIT，与插件同源）及其依赖。

${serverCopyleft.length ? `需要单独说明的组件：\n\n${[...new Set(serverCopyleft)].join('\n')}\n\n` : ''}${serverSections.join('\n\n')}
`;
}
