// Real Obsidian logs in to a Tabularium gateway through the plug-in: first login, new vault upload, a second device fetching, enforcement and stored secrets.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import type { ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
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
const connect = (session: ObsidianSession, options: Record<string, unknown>, buttons: string[] = []) => connectTabularium(session, obsidianCli, { server, username, ...options }, buttons);
async function read(path: string) {
  return new Uint8Array(await readFile(path));
}

let session: ObsidianSession | undefined;
const vaults: TemporaryVault[] = [];
try {
  step('device A uploads a new vault after the first login');
  const a = await createTemporaryVault(); vaults.push(a);
  for (const [path, content] of Object.entries(notes)) { await mkdir(join(a.path, path, '..'), { recursive: true }); await writeFile(join(a.path, path), content); }
  session = await start(a);
  await connect(session, { password: initialPassword, newPassword: password, vault: { create: 'plugin-login' }, passphrase });

  const token = (await api('/sessions', 'POST', { username, password })).token;
  const vault = (await api('/vaults', 'GET', undefined, token)).find((v: { name: string }) => v.name === 'plugin-login');
  assert(vault, 'vault created by the plug-in');
  const connection = JSON.parse(await readFile(join(a.path, '.obsidian/plugins/tabularium/tabularium.json'), 'utf8'));
  assert.deepEqual([connection.server, connection.vaultId, connection.joined], [server, vault.id, true]);
  assert.match(connection.deviceName, /^Obsidian · /);

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
  assert.equal((await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token)).find((d: { id: string }) => d.id === connection.deviceId).expiresAt, renewal.expiresAt);
  await session.app.stop(); session = undefined;

  step('device B fetches the existing vault, then disconnects');
  const b = await createTemporaryVault(); vaults.push(b);
  session = await start(b);
  await connect(session, { password, vault: { id: vault.id }, passphrase });
  for (const [path, content] of Object.entries(notes)) {
    const expected = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    assert.deepEqual(await until(async () => { const value = await read(join(b.path, path)).catch(() => undefined); return value && value.length === expected.length ? value : undefined; }), expected);
  }
  // Each temporary vault has its own Obsidian profile, so A and B are two clients; the CLI's credential stands alone.
  const devices = await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token);
  assert.deepEqual(devices.filter((d: { machineId: string | null }) => !d.machineId).map((d: { name: string }) => d.name), ['verifier']);
  assert.equal(new Set(devices.map((d: { machineId: string | null }) => d.machineId).filter(Boolean)).size, 2);
  const beforeAgain = (await api('/machines', 'GET', undefined, token)).length;

  step('signing in again from B replaces its credential');
  await connect(session, { password, vault: { id: vault.id }, passphrase }, ['OK']);
  const afterAgain = await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token);
  assert.equal(afterAgain.length, devices.length, 'the list keeps its length');
  assert.equal((await api('/machines', 'GET', undefined, token)).length, beforeAgain);
  const bDevice = JSON.parse(await readFile(join(b.path, '.obsidian/plugins/tabularium/tabularium.json'), 'utf8')).deviceId;
  assert(afterAgain.some((d: { id: string }) => d.id === bDevice));
  const disconnected = await evalObsidianJson<Record<string, unknown>>(obsidianCli, "(async()=>{const p=app.plugins.plugins['tabularium'];await p.tabularium.disconnect();const c=p.core.services.setting.currentSettings();return JSON.stringify({configured:c.isConfigured,uri:c.couchDB_URI,connection:Boolean(p.tabularium.connection),file:await app.vault.adapter.exists('.obsidian/plugins/tabularium/tabularium.json')});})()", session.cliEnv);
  assert.deepEqual(disconnected, { configured: false, uri: '', connection: false, file: false });
  assert(await readFile(join(b.path, 'notes/登录测试.md'), 'utf8'), 'notes kept after disconnect');
  assert(!(await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token)).some((d: { id: string }) => d.id === bDevice), 'disconnecting revokes the credential');
  await session.app.stop(); session = undefined;

  step('a second Obsidian vault of the same profile joins the same client');
  // Vault A's profile opens another vault: the two share window.localStorage, so one client holds both credentials.
  const second = await createTemporaryVault(); vaults.push(second);
  const sameProfile: TemporaryVault = { ...second, homePath: a.homePath, xdgConfigPath: a.xdgConfigPath, userDataPath: a.userDataPath };
  const registry = await readFile(join(second.userDataPath, 'obsidian.json'), 'utf8');
  for (const dir of [join(a.homePath, '.config/obsidian'), join(a.xdgConfigPath, 'obsidian'), join(a.homePath, 'Library/Application Support/obsidian'), a.userDataPath])
    await writeFile(join(dir, 'obsidian.json'), registry);
  await copyFile(join(second.userDataPath, `${second.id}.json`), join(a.userDataPath, `${second.id}.json`));
  session = await start(sameProfile);
  await connect(session, { password, vault: { id: vault.id }, passphrase }, ['OK']);
  const firstClient = (await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token)).find((d: { id: string }) => d.id === connection.deviceId)?.machineId;
  const secondConnection = JSON.parse(await readFile(join(sameProfile.path, '.obsidian/plugins/tabularium/tabularium.json'), 'utf8'));
  const secondDevices = await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token);
  assert.equal(secondDevices.find((d: { id: string }) => d.id === secondConnection.deviceId)?.machineId, firstClient, 'one client for the two vaults of a profile');
  assert(secondDevices.some((d: { id: string }) => d.id === connection.deviceId), 'the first vault keeps its credential');
  step('a connection from before clients joins at start-up, without signing in');
  // This page signs in the way versions before clients did: a credential with only a name. The reload at the end of
  // connecting is the first start with that connection.
  await evalObsidianJson(obsidianCli, "(async()=>{const t=app.plugins.plugins['tabularium'].tabularium;const api=t.api.bind(t);t.api=s=>{const a=api(s);a.issueDevice=id=>a.request('/vaults/'+id+'/devices','POST',{name:'Obsidian Old'});return a};return JSON.stringify(true)})()", session.cliEnv);
  await connect(session, { password, vault: { id: vault.id }, passphrase }, ['OK']);
  const stored = join(sameProfile.path, '.obsidian/plugins/tabularium/tabularium.json');
  const joined = await until(async () => { const value = JSON.parse(await readFile(stored, 'utf8')); return value.joined ? value : undefined; });
  assert.match(joined.deviceName, /^Obsidian · /);
  const upgraded = (await api(`/vaults/${vault.id}/devices`, 'GET', undefined, token)).find((d: { id: string }) => d.id === joined.deviceId);
  assert.notEqual(joined.deviceId, secondConnection.deviceId);
  assert.equal(upgraded.machineId, firstClient, 'the old credential joined the client of this machine');
  assert.equal(upgraded.expiresAt, joined.expiresAt, 'joining keeps the expiry');

  step('a name changed on the web reaches the plug-in, and revoked credentials are told at the next start');
  await api(`/machines/${firstClient}`, 'PATCH', { name: '书房台式机' }, token);
  const report = (expression: string) => evalObsidianJson<{ result: boolean; name: string; notice: string }>(obsidianCli, `(async()=>{const t=app.plugins.plugins['tabularium'].tabularium;const result=await t.joinClient();${expression};return JSON.stringify({result,name:t.connection.deviceName,notice:[...document.querySelectorAll('.notice')].map(n=>n.textContent).join('|')})})()`, session!.cliEnv);
  assert.equal((await report('')).name, '书房台式机');
  await api(`/vaults/${vault.id}/devices/${joined.deviceId}`, 'DELETE', undefined, token);
  const refused = await report('');
  assert.equal(refused.result, false);
  assert.match(refused.notice, /Tabularium/, `a notice about the credentials: ${refused.notice}`);
  await session.app.stop(); session = undefined;

  step('device C starts with peer-to-peer and hidden-file sync switched on in data.json, then connects');
  // Settings an upstream LiveSync profile can carry; the plug-in no longer contains these features and must start,
  // connect and synchronise regardless, with the features left off.
  const c = await createTemporaryVault(); vaults.push(c);
  session = await startTabularium(c, obsidianCli, { remoteType: 'ONLY_P2P', P2P_Enabled: true, P2P_AutoStart: true, P2P_AutoBroadcast: true,
    P2P_AutoSyncPeers: 'Obsidian A', syncInternalFiles: true, usePluginSync: true });
  // A data.json that already exists gets the schema's older defaults for what it lacks, not those of a new vault, so the
  // fetch adopts the vault's synchronisation parameters and says so in a dialogue with only OK.
  await connectTabularium(session, obsidianCli, { server, username, password, vault: { id: vault.id }, passphrase }, ['OK']);
  for (const [path, content] of Object.entries(notes)) {
    const expected = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    assert.deepEqual(await until(async () => { const value = await read(join(c.path, path)).catch(() => undefined); return value && value.length === expected.length ? value : undefined; }), expected);
  }
  const legacy = await evalObsidianJson<Record<string, unknown>>(obsidianCli, "(async()=>{const c=app.plugins.plugins['tabularium'].core.services.setting.currentSettings();return JSON.stringify({p2p:c.remoteType==='ONLY_P2P',P2P_Enabled:c.P2P_Enabled,P2P_AutoStart:c.P2P_AutoStart,syncInternalFiles:c.syncInternalFiles,usePluginSync:c.usePluginSync});})()", session.cliEnv);
  assert.deepEqual(legacy, { p2p: false, P2P_Enabled: false, P2P_AutoStart: false, syncInternalFiles: false, usePluginSync: false });
  await session.app.stop(); session = undefined;

  step('device D starts configured for object storage with live sync on, contacts no object storage, then connects');
  // The sync core has no object-storage remote any more. The endpoint is a local listener that counts requests: the
  // plug-in must start without using it and connect through Tabularium as usual.
  const objectStorageRequests: string[] = [];
  const objectStorage = createServer((request, response) => { objectStorageRequests.push(`${request.method} ${request.url}`); response.statusCode = 503; response.end(); });
  await new Promise<void>((done) => objectStorage.listen(0, '127.0.0.1', done));
  try {
    const endpoint = `http://127.0.0.1:${(objectStorage.address() as AddressInfo).port}`;
    const d = await createTemporaryVault(); vaults.push(d);
    session = await startTabularium(d, obsidianCli, { remoteType: 'MINIO', isConfigured: true, liveSync: true, syncOnStart: true,
      endpoint, bucket: 'legacy-bucket', accessKey: 'legacy', secretKey: 'legacy-secret', region: 'auto', forcePathStyle: true, bucketPrefix: 'vault/' });
    await new Promise((done) => setTimeout(done, 5000));
    assert.deepEqual(objectStorageRequests, [], 'no request reaches the object-storage endpoint after start-up');
    await connectTabularium(session, obsidianCli, { server, username, password, vault: { id: vault.id }, passphrase }, ['OK']);
    for (const [path, content] of Object.entries(notes)) {
      const expected = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      assert.deepEqual(await until(async () => { const value = await read(join(d.path, path)).catch(() => undefined); return value && value.length === expected.length ? value : undefined; }), expected);
    }
    const remote = await evalObsidianJson<Record<string, unknown>>(obsidianCli, "(async()=>{const c=app.plugins.plugins['tabularium'].core.services.setting.currentSettings();return JSON.stringify({remoteType:c.remoteType});})()", session.cliEnv);
    assert.deepEqual(remote, { remoteType: '' });
    assert.deepEqual(objectStorageRequests, [], 'no request reaches the object-storage endpoint');
  } finally {
    objectStorage.close();
  }
  await api('/sessions/current', 'DELETE', undefined, token);
  console.log('Plug-in login passed.');
} finally {
  if (session) await session.app.stop();
  for (const vault of vaults) await vault.dispose();
}
