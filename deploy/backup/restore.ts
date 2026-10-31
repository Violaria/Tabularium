import { chmod, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Compose, docker, requireCompose, volumeExists } from './docker.ts';
import { APP_TARGET, ENV_NAME, NOTES_TARGET, checkCouch, composeFiles, importVolume, inspectSqlite, tar, verify } from './archive.ts';

// An empty `port` lets Docker choose the loopback port; `image` replaces the backup's server image (used by upgrade trials).
export async function restore(directory: string, options: { project: string; target: string; port: string; image?: string }) {
  const { path, manifest } = await verify(directory);
  await requireCompose();
  if (!/^\d*$/.test(options.port)) throw new Error('Port must be a number');
  const image = options.image ?? manifest.versions.server.image;
  const target = resolve(options.target);
  const existing = await readdir(target).catch(() => undefined);
  if (existing?.length) throw new Error(`Target directory ${target} is not empty`);

  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.restore-`));
  // The staging folder holds a copy of the environment file: it goes if anything before it becomes the target fails.
  const cleanup = (error: unknown) => rm(staging, { recursive: true, force: true }).then(() => { throw error; });
  await tar('-xf', join(path, 'config.tar'), '-C', staging).catch(cleanup);
  const files = [...composeFiles(manifest).map(file => join(staging, file)), join(staging, 'compose.override.yaml')];
  await writeFile(files.at(-1)!, `services:
  server:
    build: !reset null
    image: ${image}
    pull_policy: never
    ports: !override
      - "127.0.0.1:${options.port}:3000"
    environment:
      # A restored copy or an upgrade trial must not write into, or prune, the original's scheduled backups.
      TABULARIUM_BACKUP_DIR: ""
`);
  let compose = new Compose(files, join(staging, ENV_NAME), options.project);
  let config = await compose.config().catch(cleanup);
  const appVolume = compose.volume(config, 'server', APP_TARGET);
  const notesVolume = compose.volume(config, 'couchdb', NOTES_TARGET);
  for (const volume of [appVolume, notesVolume]) {
    if (await volumeExists(volume)) { await rm(staging, { recursive: true }); throw new Error(`Volume ${volume} already exists`); }
  }
  if ((await compose.run('ps', '-a', '-q')).trim()) { await rm(staging, { recursive: true }); throw new Error(`Project ${options.project} already has containers`); }
  if (existing) await rmdir(target).catch(cleanup);
  await rename(staging, target).catch(cleanup);
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
  const databases = await checkCouch(compose, config, manifest, sqlite.vaults);
  return {
    report: { ok: true, project: options.project, target, port: Number(options.port), vaults: sqlite.vaults.length, clearedSessions: sqlite.sessions, databases },
    compose, appVolume, notesVolume,
  };
}
