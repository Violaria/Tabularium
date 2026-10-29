import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compose, docker, requireCompose, type ComposeConfig } from './docker.ts';
import {
  APP_TARGET, ENV_NAME, NOTES_TARGET, backup, bindFiles, checkCouch, clearVolume, importVolume, inspectSqlite, serverVersion, tar, verify,
  type DeploymentOptions,
} from './archive.ts';
import { restore } from './restore.ts';

// Compose falls back to `<project>-<service>` for a service that only declares `build`.
const serviceImage = (config: ComposeConfig, project: string) => config.services.server.image ?? `${project}-server`;
const failure = (error: unknown) => (error as Error).message;

export async function upgrade(options: DeploymentOptions & { image: string }) {
  await requireCompose();
  const compose = new Compose([options.compose], options.envFile, options.project);
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
  const rollback = ['node', 'deploy/backup/cli.ts', 'rollback', backupPath, '--compose', options.compose,
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
    await docker(['compose', '-p', trialProject, 'down', '-v']);
    for (const volume of [`${trialProject}_application`, `${trialProject}_notes`]) await docker(['volume', 'rm', volume]).catch(() => {});
    await rm(trialTarget, { recursive: true, force: true });
  }
  if (!(report.trial as { ok: boolean }).ok) return report;

  const switched = Date.now();
  try {
    await compose.run('stop', 'server');
    await docker(['tag', next, serviceImage(config, options.project)]);
    await compose.run('up', '-d', '--wait', '--no-build', '--no-deps', '--force-recreate', 'server');
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
  const compose = new Compose([options.compose], options.envFile, options.project);
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
    stage = 'start services';
    await compose.run('up', '-d', '--wait', '--no-build', '--force-recreate');
    stage = 'check CouchDB';
    await checkCouch(compose, config, manifest, sqlite.vaults);
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
      ...[manifest.source.composeFile, ...bindFiles(compose, config)].map(file => [file, join(compose.directory, file)] as [string, string])];
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
