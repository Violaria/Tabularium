// Real clients continue against a restored deployment: current CLI (Commonlib 0.2.1), legacy CLI (0.2.0), desktop Obsidian and Fast Fetch.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const runId = `restore-${Date.now()}`;
const runDir = join(root, 'test-runs', runId);
const COMPOSE = join(root, 'deploy/local/compose.yaml');
const BACKUP = join(root, 'deploy/backup/cli.ts');
const cliPath = join(root, 'apps/server/clients/cli/dist/index.cjs');
const legacyPath = join(root, '.test-runs/legacy/src/apps/cli/dist/index.cjs');
const app = join(root, 'apps/obsidian');
const binaryRoot = join(app, '_testdata/obsidian-1.14.5/squashfs-root');
const passphrase = randomBytes(24).toString('hex');
const secrets = [passphrase];
const report = { runId, node: process.version, commonlib: '0.2.1', legacyCommonlib: '0.2.0', obsidian: '1.14.5', command: 'npm run test:backup:clients', scenarios: [] };
const projects = [];
let serverImage;

const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[secret]'), text);
async function scenario(name, fn) {
  const start = Date.now();
  try {
    await fn();
    report.scenarios.push({ name, status: 'passed', durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.scenarios.push({ name, status: 'failed', error: redact(error.message) });
    throw error;
  }
}
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close(); await once(server, 'close');
  return port;
}
async function backupCli(...args) {
  const { stdout } = await exec(process.execPath, [BACKUP, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}
function management(base) {
  let token;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    assert(response.ok, `${method} ${path}: ${response.status}`);
    return response.json();
  };
  return {
    async login(username, password) { token = (await api('/sessions', 'POST', { username, password })).token; secrets.push(token); },
    api,
    async device(vault, name) {
      const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name });
      secrets.push(device.password, Buffer.from(`${device.username}:${device.password}`).toString('base64'));
      return device;
    },
  };
}
async function cli(client, ...args) {
  return exec(process.execPath, [client.cli, client.db, '--settings', client.settings, '--vault', client.vault, ...args],
    { cwd: root, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
}
async function makeClient(name, executable, base, vault, device) {
  const directory = join(runDir, name);
  const client = { cli: executable, db: join(directory, 'db'), vault: join(directory, 'vault'), settings: join(directory, 'settings.json'), remote: { vault, device } };
  await mkdir(client.vault, { recursive: true });
  await mkdir(client.db, { recursive: true });
  await exec(process.execPath, [executable, 'init-settings', client.settings], { timeout: 30_000 });
  const settings = JSON.parse(await readFile(client.settings, 'utf8'));
  Object.assign(settings, {
    couchDB_URI: `${base}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
    isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true,
    liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false,
  });
  await writeFile(client.settings, JSON.stringify(settings), { mode: 0o600 });
  return client;
}
async function moveClient(client, base) {
  const settings = JSON.parse(await readFile(client.settings, 'utf8'));
  Object.assign(settings, { couchDB_URI: `${base}/sync`, couchDB_DBNAME: client.remote.vault.id,
    couchDB_USER: client.remote.device.username, couchDB_PASSWORD: client.remote.device.password });
  // Clients that already migrated to encrypted remote configurations would otherwise keep the old connection.
  settings.remoteConfigurations = {};
  settings.activeConfigurationId = '';
  settings.encryptedCouchDBConnection = '';
  await writeFile(client.settings, JSON.stringify(settings), { mode: 0o600 });
}
async function put(client, path, contents) {
  const target = join(client.vault, path);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, contents);
}
async function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(join(directory, entry.name), path));
    else files[path] = createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex');
  }
  return files;
}
// Obsidian and its CDP endpoint are local; an inherited HTTP proxy would intercept the CDP connection.
const local = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(http|https|all)_proxy$/i.test(key)));
async function desktop(base, vault, device, mode, stage, desktopPassphrase) {
  const result = await exec(process.execPath, [join(app, 'node_modules/tsx/dist/cli.mjs'),
    '--tsconfig', join(app, 'tsconfig.json'), join(root, 'tests/interop/fast-fetch.ts')], {
    cwd: app, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...local, DISPLAY: '', WAYLAND_DISPLAY: '', OBSIDIAN_BINARY: join(binaryRoot, 'obsidian'), OBSIDIAN_CLI: join(binaryRoot, 'obsidian-cli'),
      COUCHDB_URI: `${base}/sync`, COUCHDB_USER: device.username, COUCHDB_PASSWORD: device.password, COUCHDB_DBNAME: vault.id,
      E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false', BASELINE_RUN_DIR: runDir, BASELINE_PROVISIONED_DATABASE: 'true',
      BASELINE_FETCH_MODE: mode, BASELINE_STAGE: stage, BASELINE_PASSPHRASE: desktopPassphrase },
  });
  await writeFile(join(runDir, `desktop-${mode}-${stage}.log`), redact(result.stdout + result.stderr));
}

await mkdir(runDir, { recursive: true });
try {
  const source = `${runId}-source`, restored = `${runId}-restored`;
  projects.push(source, restored);
  const port = await freePort(), restoredPort = await freePort();
  const adminPassword = randomBytes(12).toString('hex');
  const env = join(runDir, 'source.env');
  const generated = [adminPassword, randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
  secrets.push(...generated);
  await writeFile(env, [`TABULARIUM_ADMIN_PASSWORD=${generated[0]}`, `COUCHDB_ADMIN_PASSWORD=${generated[1]}`,
    `COUCHDB_SYNC_PASSWORD=${generated[2]}`, `TABULARIUM_PORT=${port}`, ''].join('\n'), { mode: 0o600 });
  const compose = (project, ...args) => exec('docker', ['compose', '-f', COMPOSE, '--env-file', env, '-p', project, ...args], { timeout: 300_000 });
  await compose(source, 'up', '-d', '--wait', '--build');
  serverImage = (await compose(source, 'images', '-q', 'server')).stdout.trim();
  const base = `http://127.0.0.1:${port}`, restoredBase = `http://127.0.0.1:${restoredPort}`;
  const admin = management(base);
  await admin.login('admin', adminPassword);
  const updated = randomBytes(12).toString('hex'); secrets.push(updated);
  await admin.api('/me/password', 'PUT', { currentPassword: adminPassword, password: updated });
  const notes = await admin.api('/vaults', 'POST', { name: 'notes' });
  const desktopVault = await admin.api('/vaults', 'POST', { name: 'desktop' });
  const fastVault = await admin.api('/vaults', 'POST', { name: 'fast' });
  const desktopDevice = await admin.device(desktopVault, 'desktop');
  const fastDevice = await admin.device(fastVault, 'fast');
  const desktopPassphrase = randomBytes(24).toString('hex'), fastPassphrase = randomBytes(24).toString('hex');
  secrets.push(desktopPassphrase, fastPassphrase);
  const a = await makeClient('a', cliPath, base, notes, await admin.device(notes, 'a'));
  const legacy = await makeClient('legacy', legacyPath, base, notes, await admin.device(notes, 'legacy'));
  let backup;

  await scenario('seed-and-backup', async () => {
    await put(a, 'notes/中文.md', '# Before backup\n');
    await put(a, 'empty.md', '');
    await put(a, 'assets/binary.bin', Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 256)));
    await cli(a, 'mirror', a.vault);
    await cli(a, 'sync');
    await cli(legacy, 'fetch', '--force', '--write-settings');
    assert.deepEqual(await snapshot(legacy.vault), await snapshot(a.vault));
    await desktop(base, desktopVault, desktopDevice, 'standard', 'seed', desktopPassphrase);
    await desktop(base, fastVault, fastDevice, 'fast', 'seed', fastPassphrase);
    const result = await backupCli('backup', '--compose', COMPOSE, '--env-file', env, '--project', source, '--output', join(runDir, 'backups'));
    assert(result.backup.ok && result.source.ok, JSON.stringify(result));
    backup = result.backup.path;
    report.backup = { timing: result.backup.timing, downtimeMs: result.source.downtimeMs };
  });

  await scenario('edit-after-backup', async () => {
    await put(a, 'notes/中文.md', '# Edited after backup\n');
    await put(a, 'after-backup.md', '# Only on the client and the old server\n');
    await cli(a, 'mirror', a.vault);
    await cli(a, 'sync');
  });

  await scenario('restore', async () => {
    const start = Date.now();
    const result = await backupCli('restore', backup, '--project', restored, '--target', join(runDir, 'restored'), '--port', String(restoredPort));
    assert(result.ok, JSON.stringify(result));
    report.restore = { durationMs: Date.now() - start, vaults: result.vaults, databases: result.databases };
  });

  await scenario('cli-continues-after-restore', async () => {
    await moveClient(a, restoredBase);
    await cli(a, 'sync');
    const fresh = await makeClient('fresh', cliPath, restoredBase, notes, await (async () => {
      const restoredAdmin = management(restoredBase);
      await restoredAdmin.login('admin', updated);
      return restoredAdmin.device(notes, 'fresh');
    })());
    await cli(fresh, 'fetch', '--force', '--write-settings');
    const files = await snapshot(fresh.vault);
    assert.deepEqual(files, await snapshot(a.vault));
    assert('after-backup.md' in files);
  });

  await scenario('legacy-continues-after-restore', async () => {
    await moveClient(legacy, restoredBase);
    assert.match((await cli(legacy, 'sync')).stdout, new RegExp(`Database: ${restoredBase}/sync/`));
    await cli(legacy, 'mirror', legacy.vault);
    assert.deepEqual(await snapshot(legacy.vault), await snapshot(a.vault));
    await put(legacy, 'legacy.md', '# Written by Commonlib 0.2.0 after restore\n');
    await cli(legacy, 'mirror', legacy.vault);
    await cli(legacy, 'sync');
    const probe = await makeClient('probe', cliPath, restoredBase, notes, await (async () => {
      const restoredAdmin = management(restoredBase);
      await restoredAdmin.login('admin', updated);
      return restoredAdmin.device(notes, 'probe');
    })());
    await cli(probe, 'fetch', '--force', '--write-settings');
    assert('legacy.md' in await snapshot(probe.vault));
    await cli(a, 'sync');
    await cli(a, 'mirror', a.vault);
    assert.deepEqual(await snapshot(a.vault), await snapshot(legacy.vault));
  });

  await scenario('desktop-obsidian-after-restore', async () => {
    await desktop(restoredBase, desktopVault, desktopDevice, 'standard', 'fetch', desktopPassphrase);
  });

  await scenario('fast-fetch-after-restore', async () => {
    await desktop(restoredBase, fastVault, fastDevice, 'fast', 'fetch', fastPassphrase);
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.message + (error.stdout ?? '') + (error.stderr ?? ''));
  console.error(report.error);
  process.exitCode = 1;
} finally {
  for (const project of projects) await exec('docker', ['compose', '-p', project, 'down', '-v']).catch(() => {});
  if (serverImage) await exec('docker', ['image', 'rm', '-f', serverImage]).catch(() => {});
  await rm(join(runDir, 'backups'), { recursive: true, force: true });
  await rm(join(runDir, 'restored'), { recursive: true, force: true });
  await rm(join(runDir, 'source.env'), { force: true });
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(runDir, 'report.json')}`);
}
