// Tabularium and the original Self-hosted LiveSync in one vault on one device: each synchronises with its own server,
// neither reads the other's local database, device values or flag files.
// Needs the upstream plug-ins built by tests/interop/prepare-upstream-plugins.sh.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianSession, type ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { createE2eCouchDbPluginData, createE2eObsidianDeviceLocalState } from '../../apps/obsidian/test/e2e-obsidian/runner/syncWorkflow.ts';
import { connectTabularium, startTabularium, until } from './obsidian-runtime.ts';

const exec = promisify(execFile);
const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const initialPassword = process.env.TABULARIUM_PASSWORD!;
const couch = { uri: process.env.UPSTREAM_COUCHDB_URI!, username: process.env.UPSTREAM_COUCHDB_USER!, password: process.env.UPSTREAM_COUCHDB_PASSWORD! };
const password = randomBytes(12).toString('hex');
const passphrase = randomBytes(16).toString('hex');
const livesyncPassphrase = randomBytes(16).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const cli = resolve('src/apps/cli/dist/index.cjs');
const upstreamPlugin = resolve('../../.test-runs/upstream-plugins/obsidian-livesync');
if (!existsSync(join(upstreamPlugin, 'main.js'))) throw new Error(`Missing ${upstreamPlugin}; run tests/interop/prepare-upstream-plugins.sh`);
const temporary = await mkdtemp(join(process.env.BASELINE_RUN_DIR!, 'coexistence-'));
const livesyncDatabase = `coexistence-livesync-${randomBytes(4).toString('hex')}`;
const step = (name: string) => console.log(`[coexistence] ${name}`);

async function api(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(`${server}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const evaluate = <T>(session: ObsidianSession, code: string) => evalObsidianJson<T>(obsidianCli, `(async()=>{${code}})()`, session.cliEnv);

/** A CLI client on its own database directory, configured against one of the two servers. */
async function client(name: string, settings: Record<string, unknown>) {
  const base = join(temporary, name), database = join(base, 'db'), vault = join(base, 'vault'), settingsPath = join(base, 'settings.json');
  await mkdir(database, { recursive: true }); await mkdir(vault, { recursive: true });
  await exec(process.execPath, [cli, 'init-settings', settingsPath]);
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')), isConfigured: true, encrypt: true, E2EEAlgorithm: 'v2',
    usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false, ...settings }), { mode: 0o600 });
  const run = (...args: string[]) => exec(process.execPath, [cli, database, '--settings', settingsPath, '--vault', vault, ...args], { timeout: 60_000 });
  return {
    vault,
    /** Writes a note into this client's vault and sends it to its server. */
    async write(path: string, content: string) {
      await mkdir(join(vault, path, '..'), { recursive: true }); await writeFile(join(vault, path), content);
      await run('push', join(vault, path), path); await run('sync');
    },
    /** Fetches everything from its server and returns the note, once it is there. */
    async read(path: string) {
      return await until(async () => { await run('fetch', '--force'); return await readFile(join(vault, path), 'utf8').catch(() => undefined); });
    },
  };
}

/** Enables the original plug-in in the running vault; Obsidian's plug-in API, since the test session enables only Tabularium. */
async function enableLiveSync(session: ObsidianSession) {
  await evaluate(session, "await app.plugins.loadManifests();await app.plugins.enablePluginAndSave('obsidian-livesync');return JSON.stringify(true);");
  await until(() => evaluate<boolean>(session, "const c=app.plugins.plugins['obsidian-livesync']?.core;return JSON.stringify(Boolean(c&&c.services.database.isDatabaseReady()&&c.services.appLifecycle.isReady()));"));
}

const readiness = (session: ObsidianSession, id: string) => evaluate<{ ready: boolean; suspended: boolean; database: string }>(session,
  `const c=app.plugins.plugins['${id}'].core;return JSON.stringify({ready:c.services.appLifecycle.isReady(),suspended:c.services.appLifecycle.isSuspended(),database:c.localDatabase.localDatabase.name});`);

let session: ObsidianSession | undefined;
let vault: TemporaryVault | undefined;
try {
  step('Tabularium logs in and uploads a new vault');
  vault = await createTemporaryVault();
  await mkdir(join(vault.path, 'notes'), { recursive: true });
  await writeFile(join(vault.path, 'notes/本机.md'), '# 本机\n\n写在共存的笔记库里。\n');
  session = await startTabularium(vault, obsidianCli);
  await connectTabularium(session, obsidianCli, { server, username, password: initialPassword, newPassword: password, vault: { create: 'coexistence' }, deviceName: 'Obsidian', passphrase });
  const token = (await api('/sessions', 'POST', { username, password })).token;
  const remote = (await api('/vaults', 'GET', undefined, token)).find((v: { name: string }) => v.name === 'coexistence');
  const device = await api(`/vaults/${remote.id}/devices`, 'POST', { name: 'verifier' }, token);
  const viaTabularium = await client('tabularium', { couchDB_URI: `${server}/sync`, couchDB_DBNAME: remote.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password, passphrase });

  step('Self-hosted LiveSync is installed beside it, connected to its own CouchDB database with its own passphrase');
  // A device that set up the original plug-in gets the Obsidian app id as its database suffix, as upstream assigns it.
  const appId = await evaluate<string>(session, 'return JSON.stringify(app.appId);');
  const pluginDir = join(vault.path, '.obsidian/plugins/obsidian-livesync');
  await mkdir(pluginDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join(upstreamPlugin, file), join(pluginDir, file));
  await writeFile(join(pluginDir, 'data.json'), JSON.stringify(createE2eCouchDbPluginData({ ...couch, dbName: livesyncDatabase },
    { encrypt: true, passphrase: livesyncPassphrase, usePathObfuscation: true, liveSync: true, additionalSuffixOfDatabaseName: appId,
      // Reviewed by the original's Config Doctor (whose rules in 1.0.40 are still those of 1.0.33), as on a device that has been running it.
      doctorProcessedVersion: '1.0.33' })));
  const marker = createE2eObsidianDeviceLocalState(vault.name, appId, '');
  await evaluate(session, `for(const [k,v] of Object.entries(${JSON.stringify(marker)}))localStorage.setItem(k,v);return JSON.stringify(true);`);
  await enableLiveSync(session);
  await evaluate(session, [
    "const c=app.plugins.plugins['obsidian-livesync'].core;const s=c.services.setting.currentSettings();const r=c.services.replicator.getActiveReplicator();",
    "await r.tryCreateRemoteDatabase(s);await r.markRemoteResolved(s);",
    "for(let i=0;i<80&&!(await r.ensurePBKDF2Salt(s,false,false));i++)await new Promise(x=>setTimeout(x,250));",
    // A one-shot replication would stop the live one it shares the replicator with; applying the settings restarts live sync.
    "await c.services.fileProcessing.commitPendingFileEvents();await c.services.control.applySettings();return JSON.stringify(true);",
  ].join(''));
  const viaLiveSync = await client('livesync', { couchDB_URI: couch.uri, couchDB_DBNAME: livesyncDatabase, couchDB_USER: couch.username, couchDB_PASSWORD: couch.password, passphrase: livesyncPassphrase,
    // The values the original plug-in stored on its remote, which a client has to match.
    customChunkSize: 60, encryptInternalMetadata: false });

  step('the two plug-ins use different local databases and Tabularium keeps its device values to itself');
  const tabularium = await readiness(session, 'tabularium'), livesync = await readiness(session, 'obsidian-livesync');
  assert.notEqual(tabularium.database, livesync.database, `local databases: ${tabularium.database} / ${livesync.database}`);
  const keys = await evaluate<string[]>(session, 'return JSON.stringify(Object.keys(localStorage));');
  assert(keys.includes('tabularium:ls-setting-passphrase') && !keys.includes('ls-setting-passphrase'),
    `Tabularium's settings key outside its prefix: ${keys.filter(k => !k.startsWith('tabularium:')).join(', ')}`);
  assert.equal(tabularium.database, `${vault.name}-tabularium-livesync-v2`);

  step('a note written through each server reaches the vault, and the vault note reaches both servers');
  await viaTabularium.write('notes/经 Tabularium.md', '# 经 Tabularium\n');
  await viaLiveSync.write('notes/经 LiveSync.md', '# 经 LiveSync\n');
  for (const path of ['notes/经 Tabularium.md', 'notes/经 LiveSync.md'])
    await until(async () => await readFile(join(vault!.path, path), 'utf8').catch(() => undefined), 120_000).catch(async (error) => {
      // What the two plug-ins are doing, and any dialogue waiting for an answer.
      const state = await evaluate(session!, "return JSON.stringify({dialogues:[...document.querySelectorAll('.modal')].map(m=>m.textContent?.slice(0,300)),"
        + "plugins:Object.fromEntries(await Promise.all(['tabularium','obsidian-livesync'].map(async id=>{const c=app.plugins.plugins[id]?.core;const s=c?.services.setting.currentSettings();"
        + "return [id,{ready:c?.services.appLifecycle.isReady(),suspended:c?.services.appLifecycle.isSuspended(),liveSync:s?.liveSync,status:c?.services.replicator.getActiveReplicator()?.syncStatus??null,docs:c?(await c.localDatabase.localDatabase.info()).doc_count:null,"
        + "watching:!s?.suspendFileWatching,parsing:!s?.suspendParseReplicationResult}]})))});").catch(String);
      throw new Error(`${path}: ${(error as Error).message}\n${JSON.stringify(state)}`);
    });
  assert.equal(await viaTabularium.read('notes/本机.md'), '# 本机\n\n写在共存的笔记库里。\n');
  assert.equal(await viaLiveSync.read('notes/本机.md'), '# 本机\n\n写在共存的笔记库里。\n');

  step("the original plug-in's flag file does not stop Tabularium");
  await writeFile(join(vault.path, 'redflag.md'), '');
  await session.app.stop(); session = undefined;
  session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault });
  await until(() => evaluate<boolean>(session!, "return JSON.stringify(Boolean(app.plugins.plugins['tabularium']?.core?.services.appLifecycle.isReady()));"));
  assert.equal((await readiness(session, 'tabularium')).suspended, false, 'Tabularium suspended by redflag.md');
  await viaTabularium.write('notes/重启之后.md', '# 重启之后\n');
  await until(async () => await readFile(join(vault!.path, 'notes/重启之后.md'), 'utf8').catch(() => undefined), 120_000);
  await rm(join(vault.path, 'redflag.md'));
  await api('/sessions/current', 'DELETE', undefined, token);
  console.log('Coexistence passed.');
} finally {
  if (session) await session.app.stop();
  if (vault) await vault.dispose();
  await rm(temporary, { recursive: true, force: true });
}
