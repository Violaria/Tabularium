// A device of 0.26.6 moves its data to the names of 1.0 on the device. A device set up with the released 0.25.0 plug-in,
// whose local data had the original plug-in's names, is
// upgraded to this build: it fetches once into its own names without asking, keeps local edits made while it was closed,
// and continues to synchronise. The old local databases are removed, unless the original plug-in is installed in the vault.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianSession, type ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { connectTabularium, pinObsidianRuntime, until } from './obsidian-runtime.ts';

const exec = promisify(execFile);
const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const initialPassword = process.env.TABULARIUM_PASSWORD!;
const password = randomBytes(12).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const cli = resolve('src/apps/cli/dist/index.cjs');
const released = resolve('../../release/0.25.0/obsidian/tabularium');
const released026 = resolve('../../release/0.26.6/obsidian/tabularium');
const upstreamPlugin = resolve('../../.test-runs/upstream-plugins/obsidian-livesync');
for (const needed of [join(released, 'main.js'), join(released026, 'main.js'), join(upstreamPlugin, 'manifest.json')])
  if (!existsSync(needed)) throw new Error(`Missing ${needed}; build release 0.25.0 and run tests/interop/prepare-upstream-plugins.sh`);
const temporary = await mkdtemp(join(process.env.BASELINE_RUN_DIR!, 'namespace-migration-'));
const step = (name: string) => console.log(`[namespace-migration] ${name}`);
let signedIn = false;

async function api(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(`${server}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const evaluate = <T>(session: ObsidianSession, code: string) => evalObsidianJson<T>(obsidianCli, `(async()=>{${code}})()`, session.cliEnv);
/** What the plug-in keeps on the device: its local database, IndexedDB databases and localStorage keys. */
const deviceState = (session: ObsidianSession) => evaluate<{ database: string; databases: string[]; keys: string[]; ready: boolean; pending: string }>(session, [
  "const c=app.plugins.plugins['tabularium'].core;",
  "const pending=c.services.setting.config?await c.services.setting.config.getValue('namespace-migration',''):'';",
  "return JSON.stringify({database:c.localDatabase.localDatabase.name,databases:(await indexedDB.databases()).map(d=>d.name),",
  "keys:Object.keys(localStorage),ready:c.services.appLifecycle.isReady(),pending});",
].join(''));

/** One device: set up with 0.25.0, closed, changed on both sides, then started with this build. */
async function upgrade(name: string, withUpstream: boolean) {
  let session: ObsidianSession | undefined;
  let vault: TemporaryVault | undefined;
  try {
    step(`${name}: a device signs in with 0.25.0${withUpstream ? '; the original plug-in is installed but not enabled' : ''}`);
    vault = await createTemporaryVault();
    await mkdir(join(vault.path, 'notes'), { recursive: true });
    await writeFile(join(vault.path, 'notes/升级前.md'), '# 升级前\n');
    await pinObsidianRuntime(vault);
    session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault, artifactRoot: released, pluginData: {} });
    await until(() => evaluate<boolean>(session!, "return JSON.stringify(Boolean(app.plugins.plugins['tabularium']?.tabularium));"));
    assert.equal(await evaluate<string>(session, "return JSON.stringify(app.plugins.manifests['tabularium'].version);"), '0.25.0');
    await connectTabularium(session, obsidianCli, { server, username, password: signedIn ? password : initialPassword,
      ...(signedIn ? {} : { newPassword: password }), vault: { create: name }, deviceName: 'Obsidian', passphrase: randomBytes(16).toString('hex') });
    signedIn = true;
    const passphrase = await evaluate<string>(session, "return JSON.stringify(app.plugins.plugins['tabularium'].core.services.setting.currentSettings().passphrase);");
    const appId = await evaluate<string>(session, 'return JSON.stringify(app.appId);');
    const before = await deviceState(session);
    assert.equal(before.database, `${vault.name}-${appId}-livesync-v2`, 'the released plug-in names its database like the original');

    const token = (await api('/sessions', 'POST', { username, password })).token;
    const remote = (await api('/vaults', 'GET', undefined, token)).find((v: { name: string }) => v.name === name);
    const device = await api(`/vaults/${remote.id}/devices`, 'POST', { name: 'verifier' }, token);
    const base = join(temporary, name), database = join(base, 'db'), copy = join(base, 'vault'), settingsPath = join(base, 'settings.json');
    await mkdir(database, { recursive: true }); await mkdir(copy, { recursive: true });
    await exec(process.execPath, [cli, 'init-settings', settingsPath]);
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')),
      couchDB_URI: `${server}/sync`, couchDB_DBNAME: remote.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
      isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }), { mode: 0o600 });
    const run = (...args: string[]) => exec(process.execPath, [cli, database, '--settings', settingsPath, '--vault', copy, ...args], { timeout: 60_000 });
    /** The note as the server holds it, fetched by another device. */
    const onServer = async (path: string) => {
      await rm(copy, { recursive: true, force: true }); await mkdir(copy, { recursive: true });
      await run('fetch', '--force');
      return await readFile(join(copy, path), 'utf8').catch(() => undefined);
    };
    assert.equal(await until(() => onServer('notes/升级前.md')), '# 升级前\n');

    if (withUpstream) {
      const dir = join(vault.path, '.obsidian/plugins/obsidian-livesync');
      await mkdir(dir, { recursive: true });
      for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(join(upstreamPlugin, file), join(dir, file));
    }
    step(`${name}: while it is closed, another device adds a note and this one is edited`);
    await session.app.stop(); session = undefined;
    const other = join(base, '关闭期间.md');
    await writeFile(other, '# 关闭期间\n');
    await run('push', other, 'notes/关闭期间.md'); await run('sync');
    await writeFile(join(vault.path, 'notes/升级前.md'), '# 升级前\n\n关闭期间在本机改过。\n');

    // The plug-in's log goes to a note in the vault, to read when something fails.
    const dataPath = join(vault.path, '.obsidian/plugins/tabularium/data.json');
    await writeFile(dataPath, JSON.stringify({ ...JSON.parse(await readFile(dataPath, 'utf8')), writeLogToTheFile: true }));
    step(`${name}: this build starts, fetches once into its own names and continues`);
    session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault });
    const after = await until(async () => {
      const state = await deviceState(session!).catch(() => undefined);
      return state?.ready && !state.pending ? state : undefined;
    }, 180_000).catch(async (error) => {
      const dialogues = await evaluate(session!, "return JSON.stringify([...document.querySelectorAll('.modal')].map(m=>m.textContent?.slice(0,400)));").catch(String);
      throw new Error(`${(error as Error).message}\nOpen dialogues: ${JSON.stringify(dialogues)}`);
    });
    assert.equal(after.database, `${vault.name}-tabularium-localdb`);
    assert.equal(await until(async () => await readFile(join(vault!.path, 'notes/关闭期间.md'), 'utf8').catch(() => undefined)), '# 关闭期间\n');
    assert.equal(await readFile(join(vault.path, 'notes/升级前.md'), 'utf8'), '# 升级前\n\n关闭期间在本机改过。\n', 'the local edit was kept');
    assert.equal(await until(async () => (await onServer('notes/升级前.md'))?.includes('关闭期间在本机改过') || undefined).catch(async (error) => {
      // Whether the edit reached the local database, and whether live sync runs.
      const state = await evaluate(session!, [
        "const c=app.plugins.plugins['tabularium'].core;const s=c.services.setting.currentSettings();",
        "const d=await c.databaseFileAccess.fetch('notes/升级前.md');",
        "return JSON.stringify({db:d&&d.body?await d.body.text?.():null,mtime:d?.stat?.mtime,liveSync:s.liveSync,watching:!s.suspendFileWatching,parsing:!s.suspendParseReplicationResult,",
        "status:c.services.replicator.getActiveReplicator()?.syncStatus??null,flag:await c.storageAccess.isExists('tabularium-fetch.md'),",
        "});",
      ].join('')).catch(String);
      const { readdir } = await import('node:fs/promises');
      const logs = (await readdir(vault!.path)).filter((f) => f.startsWith('tabularium-log-'));
      const log = logs.length ? (await readFile(join(vault!.path, logs[logs.length - 1]), 'utf8')).split('\n').slice(-80).join('\n') : 'no log';
      throw new Error(`${(error as Error).message}\n${JSON.stringify(state)}\n${log}`);
    }), true);
    // The edit kept its base revision, so it was stored on top of it instead of as a conflicting branch.
    const { readdir } = await import('node:fs/promises');
    const logs = await Promise.all((await readdir(vault.path)).filter((f) => f.startsWith('tabularium-log-')).map((f) => readFile(join(vault!.path, f), 'utf8')));
    assert.match(logs.join('\n'), /Carried over the base revisions of 1 files from /);
    assert.doesNotMatch(logs.join('\n'), /conflict\(s\) found:notes\/升级前\.md/);
    await writeFile(join(vault.path, 'notes/升级后.md'), '# 升级后\n');
    assert.equal(await until(() => onServer('notes/升级后.md')), '# 升级后\n');

    // PouchDB prefixes the IndexedDB name of the local database.
    const oldNames = [before.database, `${vault.name}-${appId}-livesync-kv`];
    const present = (name: string) => after.databases.some((database) => database === name || database === `_pouch_${name}`);
    const oldDeviceName = `obsidian-live-sync-vaultanddevicename-${vault.name}-${appId}`;
    assert(after.keys.includes('tabularium:ls-setting-passphrase'));
    if (withUpstream) {
      for (const old of oldNames) assert(present(old), `${old} kept for the original plug-in: ${after.databases.join(', ')}`);
      assert(after.keys.includes(oldDeviceName));
    } else {
      for (const old of oldNames) assert(!present(old), `${old} removed: ${after.databases.join(', ')}`);
      assert(!after.keys.includes(oldDeviceName));
    }
    await api('/sessions/current', 'DELETE', undefined, token);
  } finally {
    if (session) await session.app.stop();
    if (vault) await vault.dispose();
  }
}

/** A device of 0.26 (Tabularium's own names, before 1.0 renamed its databases) moves its data on the device. */
async function rename026() {
  let session: ObsidianSession | undefined;
  let vault: TemporaryVault | undefined;
  const name = 'rename-026';
  try {
    step(`${name}: a device signs in with 0.26.6 and synchronises a note`);
    vault = await createTemporaryVault();
    await mkdir(join(vault.path, 'notes'), { recursive: true });
    await writeFile(join(vault.path, 'notes/改名前.md'), '# 改名前\n');
    await pinObsidianRuntime(vault);
    session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault, artifactRoot: released026, pluginData: {} });
    await until(() => evaluate<boolean>(session!, "return JSON.stringify(Boolean(app.plugins.plugins['tabularium']?.tabularium));"));
    assert.equal(await evaluate<string>(session, "return JSON.stringify(app.plugins.manifests['tabularium'].version);"), '0.26.6');
    await connectTabularium(session, obsidianCli, { server, username, password: signedIn ? password : initialPassword,
      ...(signedIn ? {} : { newPassword: password }), vault: { create: name }, deviceName: 'Laptop', passphrase: randomBytes(16).toString('hex') });
    signedIn = true;
    const before = await until(async () => {
      const state = await deviceState(session!).catch(() => undefined);
      return state?.ready ? state : undefined;
    }, 120_000);
    assert.equal(before.database, `${vault.name}-tabularium-livesync-v2`);
    const documents = await until(() => evaluate<number>(session!, "const n=(await app.plugins.plugins['tabularium'].core.localDatabase.localDatabase.info()).doc_count;return JSON.stringify(n>0?n:0);"));
    await session.app.stop(); session = undefined;
    const dataPath = join(vault.path, '.obsidian/plugins/tabularium/data.json');
    await writeFile(dataPath, JSON.stringify({ ...JSON.parse(await readFile(dataPath, 'utf8')), writeLogToTheFile: true }));

    step(`${name}: this build starts with the device's data moved to the current names, without fetching`);
    session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault });
    const after = await until(async () => {
      const state = await deviceState(session!).catch(() => undefined);
      return state?.ready ? state : undefined;
    }, 120_000);
    assert.equal(after.database, `${vault.name}-tabularium-localdb`);
    assert.equal(after.pending, '');
    for (const old of [`_pouch_${vault.name}-tabularium-livesync-v2`, `${vault.name}-tabularium-livesync-kv`])
      assert(!after.databases.includes(old), `${old} removed: ${after.databases.join(', ')}`);
    assert(after.keys.includes(`tabularium:device-name-${vault.name}-tabularium`), 'the device name moved');
    assert(!after.keys.some((key) => key.includes('obsidian-live-sync-vaultanddevicename')));
    const moved = await evaluate<number>(session, "return JSON.stringify((await app.plugins.plugins['tabularium'].core.localDatabase.localDatabase.info()).doc_count);");
    assert(moved >= documents, `documents moved: ${moved} of ${documents}`);
    assert.equal(await evaluate<boolean>(session, "return JSON.stringify(await app.vault.adapter.exists('tabularium-fetch.md'));"), false, 'nothing is fetched again');
    // The file watcher runs on the moved database: a note written now is stored in it.
    await writeFile(join(vault.path, 'notes/改名后.md'), '# 改名后\n');
    await until(() => evaluate<boolean>(session!, "const d=await app.plugins.plugins['tabularium'].core.serviceModules.databaseFileAccess.fetch('notes/改名后.md');return JSON.stringify(Boolean(d)||undefined);"), 60_000);
    const { readdir } = await import('node:fs/promises');
    const logs = await Promise.all((await readdir(vault.path)).filter((f) => f.startsWith('tabularium-log-')).map((f) => readFile(join(vault!.path, f), 'utf8')));
    assert.match(logs.join('\n'), /Moved \d+ documents from /);
  } finally {
    if (session) await session.app.stop();
    if (vault) await vault.dispose();
  }
}

try {
  await rename026();
  await upgrade('migration', false);
  await upgrade('migration-beside-upstream', true);
  console.log('Namespace migration passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
