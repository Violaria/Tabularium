// Restoring a scheduled backup point (written by the server, see apps/server/src/backup/) into a new Compose project.
// The point's chain is checked from its full point; CouchDB gets every exported revision tree in order (`new_edits:false`,
// so deleted documents and conflict branches come back as they were), the application database is the point's snapshot.
// Configuration does not travel with scheduled backups: the Compose files and the environment file of the deployment
// are copied into the target.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { Compose, docker, requireCompose, volumeExists } from './docker.ts';
import { APP_TARGET, ENV_NAME, bindFiles, inspectSqlite } from './archive.ts';

const FORMAT = 'tabularium-scheduled-1';
interface PointManifest {
  format: string; id: string; type: 'full' | 'incremental'; chain: string; previous: string | null; createdAt: string;
  server: { version: string; schema: number };
  databases: Record<string, { since: string; lastSeq: string; revisions: number; local: number }>;
  files: { name: string; size: number; sha256: string }[];
}
const databaseFile = (name: string, kind: 'docs' | 'local' | 'security') =>
  `couch/${encodeURIComponent(name)}.${kind === 'docs' ? 'ndjson.gz' : `${kind}.json`}`;

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyPoint(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as PointManifest;
  if (manifest.format !== FORMAT) throw new Error(`${directory}: not a scheduled backup point`);
  for (const file of manifest.files) {
    const path = join(directory, file.name);
    if ((await stat(path)).size !== file.size || await sha256(path) !== file.sha256) throw new Error(`${directory}: ${file.name} does not match the manifest`);
  }
  return manifest;
}
/** The points from the chain's full point to `id`, each verified. */
export async function chainOf(root: string, id: string) {
  const chain: PointManifest[] = [];
  for (let next: string | null = id; next;) {
    const point: PointManifest = await verifyPoint(join(root, next)).catch((error: Error) => { throw new Error(`Backup point ${next}: ${error.message}`); });
    chain.unshift(point);
    if (point.type === 'full') return chain;
    next = point.previous;
  }
  throw new Error(`Backup point ${id} has no full point before it`);
}

async function* lines(path: string) {
  const reader = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of reader) if (line) yield line;
}

/** A CouchDB request: path, method and JSON body; resolves to the parsed response, throws on an error status. */
export type CouchRequest = (path: string, method: string, body?: unknown) => Promise<unknown>;

/** Writes the CouchDB databases of a chain's last point: every point's revisions in order, then the last point's `_local` documents and security. */
export async function importCouch(couch: CouchRequest, root: string, chain: PointManifest[]) {
  const point = chain.at(-1)!;
  const restored: Record<string, { revisions: number; local: number }> = {};
  for (const name of Object.keys(point.databases)) {
    const db = `/${encodeURIComponent(name)}`;
    await couch(db, 'PUT');
    let revisions = 0;
    for (const step of chain) {
      if (!step.databases[name]) continue;
      let batch: unknown[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const results = await couch(`${db}/_bulk_docs`, 'POST', { docs: batch, new_edits: false }) as { error?: string; id: string; reason?: string }[];
        const failed = results.filter(result => result.error);
        if (failed.length) throw new Error(`CouchDB ${name}: ${failed[0].id} ${failed[0].error} ${failed[0].reason}`);
        revisions += batch.length; batch = [];
      };
      for await (const line of lines(join(root, step.id, databaseFile(name, 'docs')))) {
        batch.push(JSON.parse(line));
        if (batch.length >= 500) await flush();
      }
      await flush();
    }
    const local = JSON.parse(await readFile(join(root, point.id, databaseFile(name, 'local')), 'utf8')) as ({ _id: string; _rev?: string } & Record<string, unknown>)[];
    for (const { _rev, ...doc } of local) await couch(`${db}/${doc._id.split('/').map(encodeURIComponent).join('/')}`, 'PUT', doc);
    await couch(`${db}/_security`, 'PUT', JSON.parse(await readFile(join(root, point.id, databaseFile(name, 'security')), 'utf8')));
    const expected = chain.reduce((sum, step) => sum + (step.databases[name]?.revisions ?? 0), 0);
    if (revisions !== expected) throw new Error(`CouchDB ${name}: ${revisions} revisions restored, the chain has ${expected}`);
    restored[name] = { revisions, local: local.length };
  }
  return restored;
}

/** Restores point `id` of the scheduled backups in `root` into a new project at `target`, configured like the given deployment. */
export async function restoreScheduled(root: string, id: string, options: { compose: string[]; envFile: string; project: string; target: string; port: string; image: string }) {
  const chain = await chainOf(resolve(root), id);
  const point = chain.at(-1)!;
  await requireCompose();
  if (!/^\d*$/.test(options.port)) throw new Error('Port must be a number');
  const target = resolve(options.target);
  if ((await readdir(target).catch(() => []))?.length) throw new Error(`Target directory ${target} is not empty`);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const file of options.compose) {
    if (files.some(existing => basename(existing) === basename(file))) throw new Error('Compose files must have different names');
    await copyFile(file, join(target, basename(file)));
    files.push(join(target, basename(file)));
  }
  await copyFile(options.envFile, join(target, ENV_NAME));
  await chmod(join(target, ENV_NAME), 0o600);
  // Configuration files the services mount from the Compose directory (CouchDB's couchdb.ini) go along: without them
  // Docker would create empty directories in their place.
  const source = new Compose(options.compose, options.envFile, options.project);
  for (const file of bindFiles(source, await source.config())) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(source.directory, file), join(target, file));
  }
  files.push(join(target, 'compose.override.yaml'));
  // CouchDB is reachable from this host only while the backup is imported, on its loopback address. Its own network is
  // internal, and Docker publishes no ports there, so for the import it also joins a bridge network of the restore's own.
  const override = (couchPort: boolean) => writeFile(files.at(-1)!, `services:
  server:
    build: !reset null
    image: ${options.image}
    pull_policy: never
    ports: !override
      - "127.0.0.1:${options.port}:3000"
    environment:
      # The restored copy must not write into, or prune, the original's scheduled backups.
      TABULARIUM_BACKUP_DIR: ""
${couchPort ? `  couchdb:
    ports: !override
      - "127.0.0.1::5984"
    networks: [database, restore]
networks:
  restore: {}
` : ''}`);
  await override(true);
  const compose = new Compose(files, join(target, ENV_NAME), options.project);
  const config = await compose.config();
  const appVolume = compose.volume(config, 'server', APP_TARGET);
  if (await volumeExists(appVolume)) throw new Error(`Volume ${appVolume} already exists`);
  if ((await compose.run('ps', '-a', '-q')).trim()) throw new Error(`Project ${options.project} already has containers`);
  await compose.run('create', '--no-build');
  await compose.run('up', '-d', '--wait', '--no-build', 'couchdb');

  // CouchDB, over its loopback port with the administrator the server is configured with.
  const server = config.services.server.environment!;
  const port = (await compose.run('port', 'couchdb', '5984')).trim().split(':').at(-1);
  const authorization = `Basic ${Buffer.from(`${server.COUCHDB_ADMIN_USER}:${server.COUCHDB_ADMIN_PASSWORD}`).toString('base64')}`;
  const couch = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`CouchDB ${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<unknown>;
  };
  const restored = await importCouch(couch, root, chain);

  // The application database: the point's snapshot, owned by the server's user.
  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.sqlite-`));
  await pipeline(createReadStream(join(root, point.id, 'app.sqlite.gz')), createGunzip(), createWriteStream(join(staging, 'app.sqlite')));
  const database = config.services.server.environment?.TABULARIUM_DATABASE ?? `${APP_TARGET}/tabularium.sqlite`;
  await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'sh', '-v', `${appVolume}:${APP_TARGET}`, '-v', `${staging}:/in:ro`, options.image,
    '-c', 'cp /in/app.sqlite "$1" && chown node:node "$1" && chmod 600 "$1"', 'sh', database]);
  await rm(staging, { recursive: true });
  const sqlite = await inspectSqlite(options.image, appVolume, true);
  if (sqlite.schema !== point.server.schema) throw new Error(`SQLite schema ${sqlite.schema}, backup has ${point.server.schema}`);
  await override(false);
  await compose.run('up', '-d', '--wait', '--no-build');
  // CouchDB left the import's network when it was recreated; the network itself stays unless removed.
  await docker(['network', 'rm', `${options.project}_restore`]);
  return { ok: true, project: options.project, target, port: Number(options.port), point: point.id, chain: chain.map(step => step.id), vaults: sqlite.vaults.length, clearedSessions: sqlite.sessions, databases: restored };
}
