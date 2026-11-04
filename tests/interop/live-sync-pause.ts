// Pausing live sync in real Obsidian: edits stay on the device until "Sync now" or resuming; the pause survives a restart.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianSession, type ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { connectTabularium, startTabularium, until } from './obsidian-runtime.ts';

const exec = promisify(execFile);
const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const initialPassword = process.env.TABULARIUM_PASSWORD!;
const password = randomBytes(12).toString('hex');
const passphrase = randomBytes(16).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const cli = resolve('../server/clients/cli/dist/index.cjs');
const temporary = await mkdtemp(join(process.env.BASELINE_RUN_DIR!, 'live-sync-pause-'));
const step = (name: string) => console.log(`[live-sync-pause] ${name}`);
/** Long enough for live sync to have sent an edit if it were running. */
const settle = () => new Promise((done) => setTimeout(done, 8000));

async function api(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(`${server}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const evaluate = <T>(session: ObsidianSession, code: string) => evalObsidianJson<T>(obsidianCli, `(async()=>{${code}})()`, session.cliEnv);
const state = (session: ObsidianSession) => evaluate<{ paused: boolean; liveSync: boolean; syncOnSave: boolean }>(session,
  "const p=app.plugins.plugins['tabularium'];const s=p.core.services.setting.currentSettings();return JSON.stringify({paused:p.livePause.paused,liveSync:s.liveSync,syncOnSave:s.syncOnSave});");
/** Runs a command the way the palette does; false when it is not available right now. */
const command = (session: ObsidianSession, id: string) => evaluate<boolean>(session,
  `const c=app.commands.findCommand('tabularium:${id}');return JSON.stringify(Boolean(c&&c.checkCallback(true)&&(c.checkCallback(false),true)));`);

let session: ObsidianSession | undefined;
let vault: TemporaryVault | undefined;
try {
  step('a device signs in; live sync is on');
  vault = await createTemporaryVault();
  session = await startTabularium(vault, obsidianCli);
  await connectTabularium(session, obsidianCli, { server, username, password: initialPassword, newPassword: password, vault: { create: 'pause' }, passphrase });
  assert.deepEqual(await state(session), { paused: false, liveSync: true, syncOnSave: false });
  assert.equal(await command(session, 'resume-live-sync'), false, 'resume is not offered while live sync runs');

  const token = (await api('/sessions', 'POST', { username, password })).token;
  const remote = (await api('/vaults', 'GET', undefined, token)).find((v: { name: string }) => v.name === 'pause');
  const device = await api(`/vaults/${remote.id}/devices`, 'POST', { name: 'verifier' }, token);
  const database = join(temporary, 'db'), copy = join(temporary, 'vault'), settingsPath = join(temporary, 'settings.json');
  await mkdir(database, { recursive: true });
  await exec(process.execPath, [cli, 'init-settings', settingsPath]);
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')),
    couchDB_URI: `${server}/sync`, couchDB_DBNAME: remote.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
    isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }), { mode: 0o600 });
  /** What the server holds, as another device would fetch it. */
  const onServer = async (path: string) => {
    await rm(copy, { recursive: true, force: true }); await mkdir(copy, { recursive: true });
    await exec(process.execPath, [cli, database, '--settings', settingsPath, '--vault', copy, 'fetch', '--force'], { timeout: 60_000 });
    return await readFile(join(copy, path), 'utf8').catch(() => undefined);
  };
  const edit = async (path: string, content: string) => {
    await mkdir(join(vault!.path, path, '..'), { recursive: true }); await writeFile(join(vault!.path, path), content);
  };

  step('pausing switches every automatic trigger off; an edit stays on the device');
  assert.equal(await command(session, 'pause-live-sync'), true);
  assert.deepEqual(await state(session), { paused: true, liveSync: false, syncOnSave: false });
  await edit('notes/暂停时.md', '# 暂停时\n');
  await settle();
  assert.equal(await onServer('notes/暂停时.md'), undefined, 'uploaded while paused');

  step('"Sync now" still sends it');
  await evaluate(session, "await app.plugins.plugins['tabularium'].core.services.replication.replicate(true);return JSON.stringify(true);");
  assert.equal(await until(() => onServer('notes/暂停时.md')), '# 暂停时\n');

  step('the pause survives a restart');
  await edit('notes/重启前.md', '# 重启前\n');
  await settle();
  await session.app.stop(); session = undefined;
  session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault });
  await until(() => evaluate<boolean>(session!, "return JSON.stringify(Boolean(app.plugins.plugins['tabularium']?.core?.services.appLifecycle.isReady()));"));
  assert.deepEqual(await state(session), { paused: true, liveSync: false, syncOnSave: false });
  assert.equal(await command(session, 'pause-live-sync'), false, 'pause is not offered while paused');
  await settle();
  assert.equal(await onServer('notes/重启前.md'), undefined, 'uploaded at start-up while paused');

  step('resuming restores live sync, sends what waited and keeps syncing live');
  assert.equal(await command(session, 'resume-live-sync'), true);
  assert.equal(await until(() => onServer('notes/重启前.md')), '# 重启前\n');
  assert.deepEqual(await state(session), { paused: false, liveSync: true, syncOnSave: false });
  await edit('notes/恢复后.md', '# 恢复后\n');
  assert.equal(await until(() => onServer('notes/恢复后.md')), '# 恢复后\n');
  await api('/sessions/current', 'DELETE', undefined, token);
  console.log('Live sync pause passed.');
} finally {
  if (session) await session.app.stop();
  if (vault) await vault.dispose();
  await rm(temporary, { recursive: true, force: true });
}
