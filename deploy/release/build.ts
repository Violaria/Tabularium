// Builds release/<version>/: server image archive, deployment directory, Obsidian plug-in package, licence list and checksums.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { licenceList } from './licences.ts';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const run = async (command: string, args: string[], cwd = root) => (await exec(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const allowDirty = process.argv.includes('--allow-dirty');

const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version as string;
const dirty = (await run('git', ['status', '--porcelain'])) !== '';
if (dirty && !allowDirty) {
  console.error('The working tree has uncommitted changes. Commit them, or pass --allow-dirty for a test build.');
  process.exit(1);
}
const commit = await run('git', ['rev-parse', 'HEAD']);
const out = join(root, 'release', version);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

console.log(`Building Tabularium ${version} (${commit.slice(0, 12)}${dirty ? ', dirty' : ''})`);
const tag = `tabularium-server:${version}`;
// The image takes the web notes page and the CLI for Tabularius prebuilt from apps/server/notes-dist and cli-dist.
await run('npm', ['run', 'build:notes']);
await run('npm', ['run', 'build:cli']);
await run('docker', ['build', '-q', '-f', 'apps/server/Dockerfile', '-t', tag, '.']);
const imageId = await run('docker', ['image', 'inspect', '-f', '{{.Id}}', tag]);
await run('docker', ['save', '-o', join(out, `tabularium-server-${version}.tar`), tag]);

// The release Compose file runs the loaded image instead of building from source.
const deploy = join(out, 'deploy');
await mkdir(deploy);
const compose = await readFile(join(root, 'deploy/local/compose.yaml'), 'utf8');
const build = '    build:\n      context: ../..\n      dockerfile: apps/server/Dockerfile\n';
if (!compose.includes(build)) throw new Error('deploy/local/compose.yaml no longer has the expected build block');
await writeFile(join(deploy, 'compose.yaml'), compose.replace(build, '    image: tabularium-server\n    pull_policy: never\n'));
await cp(join(root, 'deploy/local/couchdb.ini'), join(deploy, 'couchdb.ini'));
await cp(join(root, 'deploy/local/.env.example'), join(deploy, '.env.example'));
await mkdir(join(deploy, 'backup'));
for (const file of await readdir(join(root, 'deploy/backup'))) await cp(join(root, 'deploy/backup', file), join(deploy, 'backup', file));
const couchImage = compose.match(/image: (couchdb:\S+)/)![1];
const nodeImage = (await readFile(join(root, 'apps/server/Dockerfile'), 'utf8')).match(/^FROM (\S+) AS build/m)![1];

await run('npm', ['run', 'build', '--prefix', 'apps/obsidian']);
const plugin = join(out, 'obsidian', 'tabularium');
await mkdir(plugin, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css', 'LICENSE']) await cp(join(root, 'apps/obsidian', file), join(plugin, file));
const manifest = JSON.parse(await readFile(join(plugin, 'manifest.json'), 'utf8'));
if (manifest.id !== 'tabularium' || manifest.version !== version) throw new Error(`Plug-in manifest is ${manifest.id} ${manifest.version}`);
await run('zip', ['-q', '-r', join(out, `tabularium-obsidian-${version}.zip`), 'tabularium'], join(out, 'obsidian'));

await writeFile(join(out, 'THIRD_PARTY_LICENSES.md'), await licenceList(root, { nodeImage, couchImage }));
await writeFile(join(out, 'RELEASE.json'), JSON.stringify({
  version, commit, dirty, builtAt: new Date().toISOString(),
  server: { image: tag, id: imageId, base: nodeImage }, couchdb: couchImage, plugin: { id: manifest.id, version: manifest.version },
}, null, 2) + '\n');

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(directory, e.name)) : [join(directory, e.name)]))).flat();
}
const sums = [];
for (const file of (await files(out)).sort()) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  sums.push(`${hash.digest('hex')}  ${relative(out, file)}`);
}
await writeFile(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`Release written to ${out} (${(await stat(join(out, `tabularium-server-${version}.tar`))).size} byte image archive)`);
