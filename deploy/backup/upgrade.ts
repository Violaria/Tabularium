import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Compose, docker, requireCompose, type ComposeConfig } from './docker.ts';
import {
  APP_TARGET, ENV_NAME, NOTES_TARGET, backup, bindFiles, checkCouch, composeFiles, clearVolume, importVolume, inspectSqlite, serverVersion, tar, verify,
  type DeploymentOptions,
} from './archive.ts';
import { restore } from './restore.ts';

// Compose falls back to `<project>-<service>` for a service that only declares `build`.
const serviceImage = (config: ComposeConfig, project: string) => config.services.server.image ?? `${project}-server`;
const failure = (error: unknown) => (error as Error).message;

export async function upgrade(options: DeploymentOptions & { image: string }) {
  await requireCompose();
  const compose = new Compose(options.compose, options.envFile, options.project);
  const config = await compose.config();
  const server = await compose.state('server');
  if (!server) throw new Error(`Project ${options.project} has no server container`);
  const previous = (await docker(['inspect', '-f', '{{.Image}}', server.id])).trim();
  const next = (await docker(['image', 'inspect', '-f', '{{.Id}}', options.image])).trim();
  if (next === previous) throw new Error(`${options.image} is the image already running`);
  const report: Record<string, unknown> = {
    ok: false,
    previous: { image: previous, version: (await serverVersion(previous)).version },
    next: { image: next, version: (await serverVersion(next)).version },
  };

  const saved = await backup(options);
  Object.assign(report, saved);
  if (!saved.backup.ok || !saved.source.ok) return report;
  const backupPath = saved.backup.path;
  const rollback = ['node', 'deploy/backup/cli.ts', 'rollback', backupPath, ...options.compose.flatMap(file => ['--compose', file]),
    '--env-file', options.envFile, '--project', options.project, '--output', options.output].join(' ');

  const trialProject = `${options.project}-upgrade-${Date.now()}`;
  const trialTarget = join(options.output, trialProject);
  try {
    const trial = await restore(backupPath, { project: trialProject, target: trialTarget, port: '', image: next });
    await trial.compose.run('stop', 'server');
    const migrated = await inspectSqlite(next, trial.appVolume, false);
    report.trial = { ok: true, schema: migrated.schema };
  } catch (error) {
    report.trial = { ok: false, error: failure(error) };
  } finally {
    // Each step on its own: a failed one must not leave the trial's copy of the environment file behind.
    await docker(['compose', '-p', trialProject, 'down', '-v']).catch(() => {});
    for (const volume of [`${trialProject}_application`, `${trialProject}_notes`]) await docker(['volume', 'rm', volume]).catch(() => {});
    await rm(trialTarget, { recursive: true, force: true });
  }
  if (!(report.trial as { ok: boolean }).ok) return report;

  const switched = Date.now();
  try {
    await compose.run('stop', 'server');
    await docker(['tag', next, serviceImage(config, options.project)]);
    // The sandbox's image too: the release Compose names the same one, the source Compose its own (<project>-sandbox).
    if (config.services.sandbox) await docker(['tag', next, config.services.sandbox.image ?? `${options.project}-sandbox`]);
    await compose.run('up', '-d', '--wait', '--no-build', '--no-deps', '--force-recreate', 'server');
    // The sandbox runs from the same image; when its profile is active it moves to the new version too.
    if (config.services.sandbox) await compose.run('up', '-d', '--no-build', '--no-deps', '--force-recreate', 'sandbox');
    report.switch = { ok: true, downtimeMs: Date.now() - switched };
    report.ok = true;
  } catch (error) {
    report.switch = { ok: false, error: failure(error), rollback };
  }
  return report;
}

export async function rollback(directory: string, options: DeploymentOptions) {
  const { path, manifest } = await verify(directory);
  if (manifest.source.project !== options.project) throw new Error(`Backup belongs to project ${manifest.source.project}, not ${options.project}`);
  await requireCompose();
  const compose = new Compose(options.compose, options.envFile, options.project);
  const config = await compose.config();
  const report: Record<string, unknown> = { ok: false, target: { backup: path, image: manifest.versions.server.image, version: manifest.versions.server.version } };
  const started = Date.now();

  const saved = await backup(options, false);
  Object.assign(report, { preRollbackBackup: saved.backup, source: saved.source });
  if (!saved.backup.ok) return report;

  let stage = 'stop services';
  try {
    await compose.run('stop', 'server', 'couchdb');
    stage = 'load image';
    await docker(['load', '-i', join(path, 'server-image.tar')]);
    await docker(['tag', manifest.versions.server.image, serviceImage(config, options.project)]);
    stage = 'replace volumes';
    const couchImage = manifest.versions.couchdb.image;
    for (const [volume, file] of [[compose.volume(config, 'server', APP_TARGET), 'application.tar'], [compose.volume(config, 'couchdb', NOTES_TARGET), 'notes.tar']]) {
      await clearVolume(couchImage, volume);
      await importVolume(couchImage, volume, path, file);
    }
    stage = 'check SQLite';
    const sqlite = await inspectSqlite(manifest.versions.server.image, compose.volume(config, 'server', APP_TARGET), true);
    if (sqlite.schema !== manifest.sqlite.schema) throw new Error(`SQLite schema ${sqlite.schema}, backup has ${manifest.sqlite.schema}`);
    stage = 'start CouchDB';
    // Checked before the server starts: its hosted clients write replication checkpoints as soon as they connect.
    await compose.run('up', '-d', '--wait', '--no-build', '--force-recreate', 'couchdb');
    stage = 'check CouchDB';
    await checkCouch(compose, config, manifest, sqlite.vaults);
    stage = 'start services';
    await compose.run('up', '-d', '--wait', '--no-build', '--force-recreate');
    report.ok = true;
    report.clearedSessions = sqlite.sessions;
    report.schema = sqlite.schema;
    report.downtimeMs = Date.now() - started;
  } catch (error) {
    report.stage = stage;
    report.error = failure(error);
    return report;
  }

  // Configuration is left to the operator; only report which files differ from the backup's copies.
  const extracted = await mkdtemp(join(tmpdir(), 'tabularium-rollback-'));
  try {
    await tar('-xf', join(path, 'config.tar'), '-C', extracted);
    const current: [string, string][] = [[ENV_NAME, compose.envFile],
      ...composeFiles(manifest).map(name => [name, compose.files.find(file => basename(file) === name) ?? join(compose.directory, name)] as [string, string]),
      ...bindFiles(compose, config).map(file => [file, join(compose.directory, file)] as [string, string])];
    const changed = [];
    for (const [name, file] of current) {
      const saved = await readFile(join(extracted, name)).catch(() => undefined);
      if (!saved?.equals(await readFile(file))) changed.push(name);
    }
    report.changedConfiguration = changed;
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
  return report;
}
