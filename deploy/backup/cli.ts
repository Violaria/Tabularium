import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Compose, docker, requireCompose, volumeExists, type ComposeConfig } from './docker.ts';

const tar = (...args: string[]) => promisify(execFile)('tar', args);
const FORMAT = 1;
const ENV_NAME = 'tabularium.env';
const APP_TARGET = '/data';
const NOTES_TARGET = '/opt/couchdb/data';

interface FileEntry { name: string; size: number; sha256: string }
interface DatabaseCounts { docs: number; deleted: number; local: number }
interface SqliteInfo { integrity: string[]; foreignKeys: number; schema: number; vaults: { name: string; state: string }[]; sessions?: number }
interface Manifest {
  format: number; id: string; createdAt: string; complete: boolean;
  source: { project: string; composeFile: string };
  versions: { compose: string; server: { image: string; version: string; node: string }; couchdb: { image: string; version: string } };
  sqlite: { schema: number; vaults: number; notReady: string[] };
  couchdb: Record<string, DatabaseCounts>;
  timing: { stoppedToExportedMs: number; exportMs: number };
  files: FileEntry[];
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function counts(compose: Compose) {
  const result: Record<string, DatabaseCounts> = {};
  for (const name of await compose.couch('/_all_dbs') as string[]) {
    const db = `/${encodeURIComponent(name)}`;
    const info = await compose.couch(db);
    const local = await compose.couch(`${db}/_local_docs`);
    result[name] = { docs: info.doc_count, deleted: info.doc_del_count, local: local.rows.length };
  }
  return result;
}
// Reads the application database with the server image's own Node runtime; `clearSessions` is the restore policy.
async function inspectSqlite(image: string, volume: string, clearSessions: boolean) {
  const script = `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.TABULARIUM_DATABASE);
const out = {
  integrity: db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all().length,
  schema: db.prepare('PRAGMA user_version').get().user_version,
  vaults: db.prepare('SELECT database_name AS name, state FROM vaults').all(),
};
if (${clearSessions}) out.sessions = Number(db.prepare('DELETE FROM sessions').run().changes);
db.close();
console.log(JSON.stringify(out));`;
  const info = JSON.parse(await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', '-v', `${volume}:${APP_TARGET}`, image, '-e', script])) as SqliteInfo;
  if (info.integrity.join() !== 'ok' || info.foreignKeys) throw new Error(`SQLite check failed: ${info.integrity.join('; ')}, ${info.foreignKeys} foreign key violations`);
  return info;
}
async function exportVolume(image: string, volume: string, directory: string, file: string) {
  await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'sh', '-v', `${volume}:/v:ro`, '-v', `${directory}:/out`, image,
    '-c', 'tar --numeric-owner -cpf "/out/$1" -C /v . && chown "$2" "/out/$1" && chmod 600 "/out/$1"', 'sh', file, `${process.getuid!()}:${process.getgid!()}`]);
}
async function importVolume(image: string, volume: string, directory: string, file: string) {
  await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'tar', '-v', `${volume}:/v`, '-v', `${directory}:/in:ro`, image,
    '--numeric-owner', '-xpf', `/in/${file}`, '-C', '/v']);
}
function bindFiles(compose: Compose, config: ComposeConfig) {
  return Object.values(config.services).flatMap(service => service.volumes ?? []).filter(v => v.type === 'bind').map(v => {
    const path = relative(compose.directory, v.source);
    if (path.startsWith('..')) throw new Error(`Bind mount ${v.source} is outside the Compose directory`);
    return path;
  });
}

async function backup(options: { compose: string; envFile: string; project: string; output: string }) {
  const composeVersion = await requireCompose();
  const compose = new Compose([options.compose], options.envFile, options.project);
  const config = await compose.config();
  const appVolume = compose.volume(config, 'server', APP_TARGET);
  const notesVolume = compose.volume(config, 'couchdb', NOTES_TARGET);
  const couchImage = config.services.couchdb.image!;
  const server = await compose.state('server');
  const couch = await compose.state('couchdb');
  if (!server || !couch) throw new Error(`Project ${options.project} has no server or couchdb container`);
  const serverImage = (await docker(['inspect', '-f', '{{.Image}}', server.id])).trim();
  const report: Record<string, unknown> = { backup: { ok: false }, source: { ok: false } };
  const id = `tabularium-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const output = resolve(options.output);
  const partial = join(output, `${id}.partial`);
  let stage = 'stop server';
  let stoppedAt = 0;
  try {
    if (server.running) {
      stoppedAt = Date.now();
      await compose.run('stop', 'server');
      const stopped = await compose.state('server');
      if (stopped!.running || stopped!.exitCode !== 0) throw new Error(`Gateway exited with code ${stopped!.exitCode}`);
    }
    stage = 'read CouchDB counts';
    if (!couch.running) await compose.run('up', '-d', '--wait', '--no-build', 'couchdb');
    const couchVersion = (await compose.couch('/')).version as string;
    const databases = await counts(compose);
    stage = 'stop couchdb';
    await compose.run('stop', 'couchdb');
    if ((await compose.state('couchdb'))!.running) throw new Error('CouchDB did not stop');
    stoppedAt ||= Date.now();

    const exportStarted = Date.now();
    stage = 'read SQLite';
    const sqlite = await inspectSqlite(serverImage, appVolume, false);
    const [node, serverVersion] = (await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', serverImage,
      '-p', "process.version + ' ' + require('/app/package.json').version"])).trim().split(' ');
    stage = 'export volumes';
    await mkdir(output, { recursive: true });
    await mkdir(partial, { mode: 0o700 });
    await exportVolume(couchImage, appVolume, partial, 'application.tar');
    await exportVolume(couchImage, notesVolume, partial, 'notes.tar');
    stage = 'export configuration';
    const staging = join(partial, '.config');
    await mkdir(staging);
    for (const file of [basename(compose.files[0]), ...bindFiles(compose, config)]) {
      await mkdir(dirname(join(staging, file)), { recursive: true });
      await cp(join(compose.directory, file), join(staging, file));
    }
    await cp(compose.envFile, join(staging, ENV_NAME));
    await tar('-cf', join(partial, 'config.tar'), '-C', staging, '.');
    await rm(staging, { recursive: true });
    stage = 'export server image';
    await docker(['save', '-o', join(partial, 'server-image.tar'), serverImage]);

    stage = 'write manifest';
    const files: FileEntry[] = [];
    for (const name of ['application.tar', 'notes.tar', 'config.tar', 'server-image.tar']) {
      const path = join(partial, name);
      await chmod(path, 0o600);
      files.push({ name, size: (await stat(path)).size, sha256: await sha256(path) });
    }
    const manifest: Manifest = {
      format: FORMAT, id, createdAt: new Date().toISOString(), complete: true,
      source: { project: options.project, composeFile: basename(compose.files[0]) },
      versions: { compose: composeVersion, server: { image: serverImage, version: serverVersion, node }, couchdb: { image: couchImage, version: couchVersion } },
      sqlite: { schema: sqlite.schema, vaults: sqlite.vaults.length, notReady: sqlite.vaults.filter(v => v.state !== 'ready').map(v => v.name) },
      couchdb: databases,
      timing: { stoppedToExportedMs: Date.now() - stoppedAt, exportMs: Date.now() - exportStarted },
      files,
    };
    await writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await rename(partial, join(output, id));
    report.backup = { ok: true, path: join(output, id), notReadyVaults: manifest.sqlite.notReady, timing: manifest.timing };
  } catch (error) {
    report.backup = { ok: false, stage, error: (error as Error).message };
  }
  try {
    if (couch.running) await compose.run('up', '-d', '--wait', '--no-build', 'couchdb');
    if (server.running) await compose.run('up', '-d', '--wait', '--no-build', 'server');
    report.source = { ok: true, running: { couchdb: couch.running, server: server.running }, downtimeMs: stoppedAt ? Date.now() - stoppedAt : 0 };
  } catch (error) {
    report.source = { ok: false, error: (error as Error).message };
  }
  return report;
}

async function verify(directory: string) {
  const path = resolve(directory);
  if (path.endsWith('.partial')) throw new Error('Incomplete backup (.partial directory)');
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.complete !== true) throw new Error('Backup manifest is not marked complete');
  if (manifest.format !== FORMAT) throw new Error(`Unsupported backup format ${manifest.format}`);
  for (const file of manifest.files) {
    const size = (await stat(join(path, file.name))).size;
    if (size !== file.size) throw new Error(`${file.name}: size ${size}, expected ${file.size}`);
    if (await sha256(join(path, file.name)) !== file.sha256) throw new Error(`${file.name}: checksum mismatch`);
  }
  return { path, manifest };
}

async function restore(directory: string, options: { project: string; target: string; port: string }) {
  const { path, manifest } = await verify(directory);
  await requireCompose();
  if (!/^\d+$/.test(options.port)) throw new Error('Port must be a number');
  const target = resolve(options.target);
  const existing = await readdir(target).catch(() => undefined);
  if (existing?.length) throw new Error(`Target directory ${target} is not empty`);

  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.restore-`));
  await tar('-xf', join(path, 'config.tar'), '-C', staging);
  const files = [join(staging, manifest.source.composeFile), join(staging, 'compose.override.yaml')];
  await writeFile(files[1], `services:
  server:
    build: !reset null
    image: ${manifest.versions.server.image}
    pull_policy: never
    ports: !override
      - "127.0.0.1:${options.port}:3000"
`);
  let compose = new Compose(files, join(staging, ENV_NAME), options.project);
  let config = await compose.config();
  const appVolume = compose.volume(config, 'server', APP_TARGET);
  const notesVolume = compose.volume(config, 'couchdb', NOTES_TARGET);
  for (const volume of [appVolume, notesVolume]) {
    if (await volumeExists(volume)) { await rm(staging, { recursive: true }); throw new Error(`Volume ${volume} already exists`); }
  }
  if ((await compose.run('ps', '-a', '-q')).trim()) { await rm(staging, { recursive: true }); throw new Error(`Project ${options.project} already has containers`); }
  if (existing) await rmdir(target);
  await rename(staging, target);
  await chmod(target, 0o700);
  await chmod(join(target, ENV_NAME), 0o600);
  compose = new Compose(files.map(file => join(target, basename(file))), join(target, ENV_NAME), options.project);
  config = await compose.config();

  await docker(['load', '-i', join(path, 'server-image.tar')]);
  await compose.run('create', '--no-build');
  const couchImage = manifest.versions.couchdb.image;
  await importVolume(couchImage, appVolume, path, 'application.tar');
  await importVolume(couchImage, notesVolume, path, 'notes.tar');
  const sqlite = await inspectSqlite(manifest.versions.server.image, appVolume, true);
  if (sqlite.schema !== manifest.sqlite.schema) throw new Error(`SQLite schema ${sqlite.schema}, backup has ${manifest.sqlite.schema}`);
  await compose.run('up', '-d', '--wait', '--no-build');

  const syncUser = config.services.server.environment!.COUCHDB_SYNC_USER;
  const databases = await counts(compose);
  const mismatched = Object.entries(manifest.couchdb).filter(([name, expected]) => JSON.stringify(databases[name]) !== JSON.stringify(expected)).map(([name]) => name);
  if (mismatched.length) throw new Error(`CouchDB databases differ from backup: ${mismatched.join(', ')}`);
  for (const vault of sqlite.vaults.filter(v => v.state === 'ready')) {
    if (!databases[vault.name]) throw new Error(`Vault database ${vault.name} is missing`);
    const security = await compose.couch(`/${vault.name}/_security`);
    if (JSON.stringify(security.members?.names) !== JSON.stringify([syncUser]) || security.admins?.names?.length) {
      throw new Error(`Vault database ${vault.name} has unexpected permissions`);
    }
  }
  return { ok: true, project: options.project, target, port: Number(options.port), vaults: sqlite.vaults.length, clearedSessions: sqlite.sessions, databases: Object.keys(databases).length };
}

const usage = `Usage:
  node deploy/backup/cli.ts backup  --compose <file> --env-file <file> --project <name> --output <dir>
  node deploy/backup/cli.ts verify  <backup-dir>
  node deploy/backup/cli.ts restore <backup-dir> --project <name> --target <dir> --port <port>`;
const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
  compose: { type: 'string' }, 'env-file': { type: 'string' }, project: { type: 'string' },
  output: { type: 'string' }, target: { type: 'string' }, port: { type: 'string' },
} });
function need(name: keyof typeof values) {
  if (!values[name]) { console.error(usage); process.exit(2); }
  return values[name] as string;
}
try {
  if (command === 'backup') {
    const report = await backup({ compose: need('compose'), envFile: need('env-file'), project: need('project'), output: need('output') });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = (report.backup as { ok: boolean }).ok && (report.source as { ok: boolean }).ok ? 0 : 1;
  } else if (command === 'verify' && positionals.length === 1) {
    const { path, manifest } = await verify(positionals[0]);
    console.log(JSON.stringify({ ok: true, path, id: manifest.id, files: manifest.files.length }, null, 2));
  } else if (command === 'restore' && positionals.length === 1) {
    console.log(JSON.stringify(await restore(positionals[0], { project: need('project'), target: need('target'), port: need('port') }), null, 2));
  } else { console.error(usage); process.exitCode = 2; }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
  process.exitCode = 1;
}
