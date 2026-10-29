import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Compose, docker, requireCompose, type ComposeConfig } from './docker.ts';

export const tar = (...args: string[]) => promisify(execFile)('tar', args);
export const FORMAT = 1;
export const ENV_NAME = 'tabularium.env';
export const APP_TARGET = '/data';
export const NOTES_TARGET = '/opt/couchdb/data';

interface FileEntry { name: string; size: number; sha256: string }
export interface DatabaseCounts { docs: number; deleted: number; local: number }
export interface SqliteInfo { integrity: string[]; foreignKeys: number; schema: number; vaults: { name: string; state: string }[]; sessions?: number }
export interface Manifest {
  format: number; id: string; createdAt: string; complete: boolean;
  source: { project: string; composeFile: string };
  versions: { compose: string; server: { image: string; version: string; node: string }; couchdb: { image: string; version: string } };
  sqlite: { schema: number; vaults: number; notReady: string[] };
  couchdb: Record<string, DatabaseCounts>;
  timing: { stoppedToExportedMs: number; exportMs: number };
  files: FileEntry[];
}
export interface DeploymentOptions { compose: string; envFile: string; project: string; output: string }
export interface BackupReport {
  backup: { ok: true; path: string; notReadyVaults: string[]; timing: Manifest['timing'] } | { ok: false; stage: string; error: string };
  source: { ok: true; running: { couchdb: boolean; server: boolean }; downtimeMs: number } | { ok: false; error: string } | { ok: true; resumed: false };
}

export async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function counts(compose: Compose) {
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
export async function inspectSqlite(image: string, volume: string, clearSessions: boolean) {
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
export async function serverVersion(image: string) {
  const [node, version] = (await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image,
    '-p', "process.version + ' ' + require('/app/package.json').version"])).trim().split(' ');
  return { node, version };
}
async function exportVolume(image: string, volume: string, directory: string, file: string) {
  await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'sh', '-v', `${volume}:/v:ro`, '-v', `${directory}:/out`, image,
    '-c', 'tar --numeric-owner -cpf "/out/$1" -C /v . && chown "$2" "/out/$1" && chmod 600 "/out/$1"', 'sh', file, `${process.getuid!()}:${process.getgid!()}`]);
}
export async function importVolume(image: string, volume: string, directory: string, file: string) {
  await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'tar', '-v', `${volume}:/v`, '-v', `${directory}:/in:ro`, image,
    '--numeric-owner', '-xpf', `/in/${file}`, '-C', '/v']);
}
export async function clearVolume(image: string, volume: string) {
  await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'find', '-v', `${volume}:/v`, image, '/v', '-mindepth', '1', '-delete']);
}
export function bindFiles(compose: Compose, config: ComposeConfig) {
  return Object.values(config.services).flatMap(service => service.volumes ?? []).filter(v => v.type === 'bind').map(v => {
    const path = relative(compose.directory, v.source);
    if (path.startsWith('..')) throw new Error(`Bind mount ${v.source} is outside the Compose directory`);
    return path;
  });
}
// Compares every database with the manifest and checks that each ready vault's database grants access to the sync user only.
export async function checkCouch(compose: Compose, config: ComposeConfig, manifest: Manifest, vaults: SqliteInfo['vaults']) {
  const syncUser = config.services.server.environment!.COUCHDB_SYNC_USER;
  const databases = await counts(compose);
  const mismatched = Object.entries(manifest.couchdb).filter(([name, expected]) => JSON.stringify(databases[name]) !== JSON.stringify(expected)).map(([name]) => name);
  if (mismatched.length) throw new Error(`CouchDB databases differ from backup: ${mismatched.join(', ')}`);
  for (const vault of vaults.filter(v => v.state === 'ready')) {
    if (!databases[vault.name]) throw new Error(`Vault database ${vault.name} is missing`);
    const security = await compose.couch(`/${vault.name}/_security`);
    if (JSON.stringify(security.members?.names) !== JSON.stringify([syncUser]) || security.admins?.names?.length) {
      throw new Error(`Vault database ${vault.name} has unexpected permissions`);
    }
  }
  return Object.keys(databases).length;
}

// With `resume: false` a successful backup leaves the source stopped, for callers that replace its data next.
export async function backup(options: DeploymentOptions, resume = true): Promise<BackupReport> {
  const composeVersion = await requireCompose();
  const compose = new Compose([options.compose], options.envFile, options.project);
  const config = await compose.config();
  const appVolume = compose.volume(config, 'server', APP_TARGET);
  const notesVolume = compose.volume(config, 'couchdb', NOTES_TARGET);
  const couchImage = config.services.couchdb.image!;
  const container = await compose.state('server');
  const couch = await compose.state('couchdb');
  if (!container || !couch) throw new Error(`Project ${options.project} has no server or couchdb container`);
  // A crash-looping gateway is briefly `running` between restarts, so only a healthy gateway counts as serving.
  const server = { ...container, running: container.healthy };
  const serverImage = (await docker(['inspect', '-f', '{{.Image}}', server.id])).trim();
  const report = { backup: { ok: false, stage: '', error: '' }, source: { ok: false, error: '' } } as BackupReport;
  const id = `tabularium-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const output = resolve(options.output);
  const partial = join(output, `${id}.partial`);
  let stage = 'stop server';
  let stoppedAt = 0;
  try {
    // A gateway that is not serving may still be restarting, so it is always stopped.
    if (server.running) stoppedAt = Date.now();
    await compose.run('stop', 'server');
    const stopped = await compose.state('server');
    if (stopped!.running || (server.running && stopped!.exitCode !== 0)) throw new Error(`Gateway exited with code ${stopped!.exitCode}`);
    stage = 'read CouchDB counts';
    if (!couch.running) await compose.run('start', '--wait', 'couchdb');
    const couchVersion = (await compose.couch('/')).version as string;
    const databases = await counts(compose);
    stage = 'stop couchdb';
    await compose.run('stop', 'couchdb');
    if ((await compose.state('couchdb'))!.running) throw new Error('CouchDB did not stop');
    stoppedAt ||= Date.now();

    const exportStarted = Date.now();
    stage = 'read SQLite';
    const sqlite = await inspectSqlite(serverImage, appVolume, false);
    const { node, version } = await serverVersion(serverImage);
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
      versions: { compose: composeVersion, server: { image: serverImage, version, node }, couchdb: { image: couchImage, version: couchVersion } },
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
  if (!resume && report.backup.ok) { report.source = { ok: true, resumed: false }; return report; }
  // `start` reuses the existing containers, so a newer image already tagged for the service is not picked up here.
  try {
    if (couch.running) await compose.run('start', '--wait', 'couchdb');
    if (server.running) await compose.run('start', '--wait', 'server');
    report.source = { ok: true, running: { couchdb: couch.running, server: server.running }, downtimeMs: stoppedAt ? Date.now() - stoppedAt : 0 };
  } catch (error) {
    report.source = { ok: false, error: (error as Error).message };
  }
  return report;
}

export async function verify(directory: string) {
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
