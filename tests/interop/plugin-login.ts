// Real Obsidian logs in to a Tabularium gateway through the plug-in: first login, new vault upload, a second device fetching, enforcement and stored secrets.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import type { ObsidianLiveSyncSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { connectTabularium, startTabularium, until } from './obsidian-runtime.ts';

const exec = promisify(execFile);
const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const initialPassword = process.env.TABULARIUM_PASSWORD!;
const password = randomBytes(12).toString('hex');
const passphrase = randomBytes(16).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const cli = resolve('src/apps/cli/dist/index.cjs');
const temporary = await mkdtemp(join(process.env.BASELINE_RUN_DIR!, 'plugin-login-'));
const notes: Record<string, string | Uint8Array> = {
  'notes/登录测试.md': '# 登录测试\n\n由插件登录后上传。\n',
  'assets/attachment.bin': Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 256),
};
const step = (name: string) => console.log(`[plugin-login] ${name}`);
async function api(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(`${server}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const start = (vault: TemporaryVault) => startTabularium(vault, obsidianCli);
const connect = (session: ObsidianLiveSyncSession, options: Record<string, unknown>) => connectTabularium(session, obsidianCli, { server, username, ...options });
async function read(path: string) {
  return new Uint8Array(await readFile(path));
}

let session: ObsidianLiveSyncSession | undefined;
const vaults: TemporaryVault[] = [];
try {
  step('device A uploads a new vault after the first login');
  const a = await createTemporaryVault(); vaults.push(a);
  for (const [path, content] of Object.entries(notes)) { await mkdir(join(a.path, path, '..'), { recursive: true }); await writeFile(join(a.path, path), content); }
  session = await start(a);
  await connect(session, { password: initialPassword, newPassword: password, vault: { create: 'plugin-login' }, deviceName: 'Obsidian A', passphrase });

  const token = (await api('/sessions', 'POST', { username, password })).token;
  const vault = (await api('/vaults', 'GET', undefined, token)).find((v: { name: string }) => v.name === 'plugin-login');
  assert(vault, 'vault created by the plug-in');
  const connection = JSON.parse(await readFile(join(a.path, '.obsidian/plugins/tabularium/tabularium.json'), 'utf8'));
  assert.deepEqual([connection.server, connection.vaultId, connection.deviceName], [server, vault.id, 'Obsidian A']);

  step('a CLI client with the same passphrase receives both notes');
  const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'verifier' }, token);
  const database = join(temporary, 'cli-db'), vaultDir = join(temporary, 'cli-vault'), settingsPath = join(temporary, 'cli-settings.json');
  await mkdir(database, { recursive: true }); await mkdir(vaultDir, { recursive: true });
  await exec(process.execPath, [cli, 'init-settings', settingsPath]);
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')),
    couchDB_URI: `${server}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
    isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }), { mode: 0o600 });
  await until(async () => {
    await exec(process.execPath, [cli, database, '--settings', settingsPath, '--vault', vaultDir, 'fetch', '--force', '--write-settings'], { timeout: 60_000 });
    return (await readdir(join(vaultDir, 'notes')).catch(() => [])).length > 0;
  });
  for (const [path, content] of Object.entries(notes)) assert.deepEqual(await read(join(vaultDir, path)), typeof content === 'string' ? new TextEncoder().encode(content) : content);

  step('encryption cannot be switched off and data.json holds no recoverable secrets');
  const enforced = await evalObsidianJson<Record<string, unknown>>(obsidianCli, "(async()=>{const s=app.plugins.plugins['tabularium'].core.services.setting;await s.applyPartial({encrypt:false,usePathObfuscation:false,syncInternalFiles:true},true);const c=s.currentSettings();return JSON.stringify({encrypt:c.encrypt,usePathObfuscation:c.usePathObfuscation,syncInternalFiles:c.syncInternalFiles,store:c.configPassphraseStore});})()", session.cliEnv);
  assert.deepEqual(enforced, { encrypt: true, usePathObfuscation: true, syncInternalFiles: false, store: 'LOCALSTORAGE' });
  const data = await readFile(join(a.path, '.obsidian/plugins/tabularium/data.json'), 'utf8');
  const saved = JSON.parse(data);
  assert.equal(saved.configPassphraseStore, 'LOCALSTORAGE');
  assert.equal(saved.encrypt, true); assert.equal(saved.usePathObfuscation, true);
  for (const secret of [passphrase, password, initialPassword]) assert(!data.includes(secret), 'secret stored in data.json');
  assert(!/"couchDB_PASSWORD":"[^"]/.test(data), 'device password stored in clear');

  step('credentials close to expiry are renewed on the server and recorded locally');
  const renewal = await evalObsidianJson<{ renewed: boolean; expiresAt: number }>(obsidianCli, "(async()=>{const t=app.plugins.plugins['tabularium'].tabularium;t.connection={...t.connection,expiresAt:Date.now()};const renewed=await t.renew();return JSON.stringify({renewed,expiresAt:t.connection.expiresAt});})()", session.cliEnv);
  assert.equal(renewal.renewed, true);
  assert(renewal.expiresAt > Date.now() + 29 * 86_400_000, 'expiry restarts from now');
  assert.equal(JSON.parse(await readFile(join(a.path, '.obsidian/plugins/tabularium/tabularium.json'), 'utf8')).expiresAt, renewal.expiresAt);
  assert.equal((await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token)).find((d: { name: string }) => d.name === 'Obsidian A').expiresAt, renewal.expiresAt);
  await session.app.stop(); session = undefined;

  step('device B fetches the existing vault, then disconnects');
  const b = await createTemporaryVault(); vaults.push(b);
  session = await start(b);
  await connect(session, { password, vault: { id: vault.id }, deviceName: 'Obsidian B', passphrase });
  for (const [path, content] of Object.entries(notes)) {
    const expected = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    assert.deepEqual(await until(async () => { const value = await read(join(b.path, path)).catch(() => undefined); return value && value.length === expected.length ? value : undefined; }), expected);
  }
  const devices = await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token);
  assert.deepEqual(devices.map((d: { name: string }) => d.name).sort(), ['Obsidian A', 'Obsidian B', 'verifier']);
  const disconnected = await evalObsidianJson<Record<string, unknown>>(obsidianCli, "(async()=>{const p=app.plugins.plugins['tabularium'];await p.tabularium.disconnect();const c=p.core.services.setting.currentSettings();return JSON.stringify({configured:c.isConfigured,uri:c.couchDB_URI,connection:Boolean(p.tabularium.connection),file:await app.vault.adapter.exists('.obsidian/plugins/tabularium/tabularium.json')});})()", session.cliEnv);
  assert.deepEqual(disconnected, { configured: false, uri: '', connection: false, file: false });
  assert(await readFile(join(b.path, 'notes/登录测试.md'), 'utf8'), 'notes kept after disconnect');
  await session.app.stop(); session = undefined;

  step('device C starts with peer-to-peer and hidden-file sync switched on in data.json, then connects');
  // Settings an upstream LiveSync profile can carry; the plug-in no longer contains these features and must start,
  // connect and synchronise regardless, with the features left off.
  const c = await createTemporaryVault(); vaults.push(c);
  session = await startTabularium(c, obsidianCli, { remoteType: 'ONLY_P2P', P2P_Enabled: true, P2P_AutoStart: true, P2P_AutoBroadcast: true,
    P2P_AutoSyncPeers: 'Obsidian A', syncInternalFiles: true, usePluginSync: true });
  // A data.json that already exists gets the schema's older defaults for what it lacks, not those of a new vault, so the
  // fetch adopts the vault's synchronisation parameters and says so in a dialogue with only OK.
  await connectTabularium(session, obsidianCli, { server, username, password, vault: { id: vault.id }, deviceName: 'Obsidian C', passphrase }, ['OK']);
  for (const [path, content] of Object.entries(notes)) {
    const expected = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    assert.deepEqual(await until(async () => { const value = await read(join(c.path, path)).catch(() => undefined); return value && value.length === expected.length ? value : undefined; }), expected);
  }
  const legacy = await evalObsidianJson<Record<string, unknown>>(obsidianCli, "(async()=>{const c=app.plugins.plugins['tabularium'].core.services.setting.currentSettings();return JSON.stringify({p2p:c.remoteType==='ONLY_P2P',P2P_Enabled:c.P2P_Enabled,P2P_AutoStart:c.P2P_AutoStart,syncInternalFiles:c.syncInternalFiles,usePluginSync:c.usePluginSync});})()", session.cliEnv);
  assert.deepEqual(legacy, { p2p: false, P2P_Enabled: false, P2P_AutoStart: false, syncInternalFiles: false, usePluginSync: false });
  await api('/sessions/current', 'DELETE', undefined, token);
  console.log('Plug-in login passed.');
} finally {
  if (session) await session.app.stop();
  for (const vault of vaults) await vault.dispose();
}
