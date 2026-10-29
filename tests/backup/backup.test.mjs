import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const CLI = join(root, 'deploy/backup/cli.ts');
const COMPOSE = join(root, 'deploy/local/compose.yaml');
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
// The gateway accepts only encrypted LiveSync document shapes.
const chunk = data => ({ type: 'leaf', e_: true, data: `%=${data}` });
const run = id => `tbk${Date.now().toString(36)}${id}`;

async function cli(...args) {
  try {
    const { stdout } = await exec(process.execPath, [CLI, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, out: error.stdout ? JSON.parse(error.stdout) : undefined, stderr: error.stderr };
  }
}
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close(); await once(server, 'close');
  return port;
}
const compose = (project, env, ...args) => docker('compose', '-f', COMPOSE, '--env-file', env, '-p', project, ...args);
async function running(project, env, service) {
  const line = (await compose(project, env, 'ps', '-a', '--format', 'json', service)).trim();
  return line ? JSON.parse(line).State === 'running' : false;
}

test('offline backup and restore into a fresh project', { timeout: 900_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tabularium-backup-'));
  const source = run('s');
  const port = await freePort();
  const env = join(directory, 'source.env');
  const adminPassword = randomBytes(12).toString('hex');
  await writeFile(env, [`TABULARIUM_ADMIN_PASSWORD=${adminPassword}`, `COUCHDB_ADMIN_PASSWORD=${randomBytes(16).toString('hex')}`,
    `COUCHDB_SYNC_PASSWORD=${randomBytes(16).toString('hex')}`, `TABULARIUM_PORT=${port}`, ''].join('\n'), { mode: 0o600 });
  const projects = [source];
  const output = join(directory, 'backups');
  let serverImage;
  try {
    await compose(source, env, 'up', '-d', '--wait', '--build');
    serverImage = (await docker('compose', '-f', COMPOSE, '--env-file', env, '-p', source, 'images', '-q', 'server')).trim();
    const api = (base) => async (path, method = 'GET', data, token, expected = 200) => {
      const response = await fetch(`${base}/api/v1${path}`, { method, headers: {
        'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await response.text();
      assert.equal(response.status, expected, `${method} ${path}: ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    const sync = (base) => async (vault, path, device, method = 'GET', data, expected = 200, headers = {}) => {
      const response = await fetch(`${base}/sync/${vault}${path}`, { method, headers: {
        authorization: `Basic ${Buffer.from(`${device.username}:${device.password}`).toString('base64')}`, 'content-type': 'application/json', ...headers,
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await response.text();
      assert.equal(response.status, expected, `${method} ${path}: ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    const base = `http://127.0.0.1:${port}`;
    const sourceApi = api(base), sourceSync = sync(base);
    const login = async (call, username, password) => (await call('/sessions', 'POST', { username, password }, undefined, 201)).token;
    async function account(username) {
      const initial = `${username}-initial-password`;
      await sourceApi('/users', 'POST', { username, password: initial }, admin, 201);
      const token = await login(sourceApi, username, initial);
      await sourceApi('/me/password', 'PUT', { currentPassword: initial, password: `${username}-updated-password` }, token);
      return token;
    }
    const enroll = (vault, token, name) => sourceApi(`/vaults/${vault.id}/devices`, 'POST', { name }, token, 201);

    const admin = await login(sourceApi, 'admin', adminPassword);
    await sourceApi('/me/password', 'PUT', { currentPassword: adminPassword, password: 'admin-updated-password' }, admin);
    const alice = await account('alice'), bob = await account('bob'), carol = await account('carol');
    const vaultA = await sourceApi('/vaults', 'POST', { name: 'alice-notes' }, alice, 201);
    const vaultB = await sourceApi('/vaults', 'POST', { name: 'bob-notes' }, bob, 201);
    const vaultC = await sourceApi('/vaults', 'POST', { name: 'carol-notes' }, carol, 201);
    const valid = await enroll(vaultA, alice, 'valid');
    const revoked = await enroll(vaultA, alice, 'revoked');
    const expired = await enroll(vaultA, alice, 'expired');
    const bobDevice = await enroll(vaultB, bob, 'bob');
    const carolDevice = await enroll(vaultC, carol, 'carol');
    await sourceApi(`/vaults/${vaultA.id}/devices/${revoked.id}`, 'DELETE', undefined, alice);
    const users = await sourceApi('/users', 'GET', undefined, admin);
    await sourceApi(`/users/${users.find(u => u.username === 'carol').id}`, 'PATCH', { disabled: true }, admin);

    // Revisions, a conflict, a deletion, a large chunk and a local document in alice's vault; one document in bob's.
    let rev = (await sourceSync(vaultA.id, '/h:note', valid, 'PUT', chunk('v1'), 201)).rev;
    rev = (await sourceSync(vaultA.id, '/h:note', valid, 'PUT', { _rev: rev, ...chunk('v2') }, 201)).rev;
    await sourceSync(vaultA.id, '/_bulk_docs', valid, 'POST', { new_edits: false, docs: [
      { _id: 'h:conflict', _rev: '1-aaaa', ...chunk('a') }, { _id: 'h:conflict', _rev: '1-bbbb', ...chunk('b') },
    ] }, 201);
    const gone = (await sourceSync(vaultA.id, '/h:gone', valid, 'PUT', chunk('x'), 201)).rev;
    await sourceSync(vaultA.id, '/h:gone', valid, 'PUT', { _rev: gone, _deleted: true }, 200);
    await sourceSync(vaultA.id, '/h:binary', valid, 'PUT', chunk(randomBytes(4096).toString('base64')), 201);
    await sourceSync(vaultA.id, '/_local/checkpoint', valid, 'PUT', { last_seq: 'opaque-1' }, 201);
    await sourceSync(vaultB.id, '/h:bob-note', bobDevice, 'PUT', chunk('bob'), 201);

    // Expiry is fixed at issue time, so age the device directly while the gateway is stopped.
    await compose(source, env, 'stop', 'server');
    await docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', '-v', `${source}_application:/data`, serverImage, '-e',
      `const db = new (require('node:sqlite').DatabaseSync)(process.env.TABULARIUM_DATABASE); db.prepare('UPDATE devices SET expires_at=1 WHERE id=?').run(${JSON.stringify(expired.id)}); db.close();`);
    await compose(source, env, 'up', '-d', '--wait', '--no-build', 'server');
    const session = await login(sourceApi, 'alice', 'alice-updated-password');

    const snapshot = async (call, vault, device) => ({
      docs: await call(vault, '/_all_docs?include_docs=true&conflicts=true&attachments=true', device),
      // Sharded databases merge _changes in no fixed order, and leaf order is not significant either.
      changes: (await call(vault, '/_changes?style=all_docs', device)).results
        .map(({ id, changes, deleted }) => ({ id, changes: changes.map(c => c.rev).sort(), deleted }))
        .sort((x, y) => x.id.localeCompare(y.id)),
      conflict: (await call(vault, '/h:conflict?open_revs=all', device, 'GET', undefined, 200, { accept: 'application/json' }))
        .map(leaf => leaf.ok).sort((x, y) => x._rev.localeCompare(y._rev)),
      local: await call(vault, '/_local/checkpoint', device),
    });
    const before = { a: await snapshot(sourceSync, vaultA.id, valid), b: await sourceSync(vaultB.id, '/_all_docs?include_docs=true', bobDevice),
      audit: await sourceApi('/admin/audit', 'GET', undefined, admin), users: await sourceApi('/users', 'GET', undefined, admin) };
    assert.equal(before.a.conflict.length, 2);
    assert.ok(before.a.changes.find(c => c.id === 'h:gone').deleted);

    let backup;
    await t.test('backup of a running deployment resumes the source', async () => {
      const { code, out } = await cli('backup', '--compose', COMPOSE, '--env-file', env, '--project', source, '--output', output);
      assert.equal(code, 0, JSON.stringify(out));
      assert.ok(out.backup.ok && out.source.ok);
      backup = out.backup.path;
      assert.equal((await stat(backup)).mode & 0o777, 0o700);
      const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
      for (const name of ['manifest.json', ...manifest.files.map(f => f.name)]) assert.equal((await stat(join(backup, name))).mode & 0o777, 0o600);
      assert.deepEqual(manifest.files.map(f => f.name), ['application.tar', 'notes.tar', 'config.tar', 'server-image.tar']);
      assert.equal(manifest.sqlite.schema, Number((await readFile(join(root, 'apps/server/dist/store.js'), 'utf8')).match(/if \(version !== (\d+)\)/)[1])); assert.equal(manifest.sqlite.vaults, 3);
      assert.equal(manifest.couchdb[`tab_${vaultA.id.replaceAll('-', '')}`].local, 1);
      assert.ok(!(await readFile(join(backup, 'manifest.json'), 'utf8')).includes(adminPassword));
      assert.ok(await running(source, env, 'server') && await running(source, env, 'couchdb'));
      await sourceSync(vaultA.id, '/h:note', valid);
      assert.equal((await cli('verify', backup)).code, 0);
    });

    await t.test('restore reproduces data, access policy and permissions', async () => {
      const target = run('r'); projects.push(target);
      const restoredPort = await freePort();
      const { code, out } = await cli('restore', backup, '--project', target, '--target', join(directory, target), '--port', String(restoredPort));
      assert.equal(code, 0, JSON.stringify(out));
      assert.equal(out.clearedSessions > 0, true);
      assert.equal((await stat(join(directory, target, 'tabularium.env'))).mode & 0o777, 0o600);
      const restored = `http://127.0.0.1:${restoredPort}`;
      const restoredApi = api(restored), restoredSync = sync(restored);
      await restoredApi('/me', 'GET', undefined, session, 401);
      const newAdmin = await login(restoredApi, 'admin', 'admin-updated-password');
      assert.deepEqual(await restoredApi('/users', 'GET', undefined, newAdmin), before.users);
      const audit = await restoredApi('/admin/audit', 'GET', undefined, newAdmin);
      assert.deepEqual(audit, before.audit);
      assert.deepEqual(await snapshot(restoredSync, vaultA.id, valid), before.a);
      assert.deepEqual(await restoredSync(vaultB.id, '/_all_docs?include_docs=true', bobDevice), before.b);
      await restoredSync(vaultB.id, '/', valid, 'GET', undefined, 403);
      for (const device of [revoked, expired]) await restoredSync(vaultA.id, '/', device, 'GET', undefined, 401);
      await restoredSync(vaultC.id, '/', carolDevice, 'GET', undefined, 401);
      await login(restoredApi, 'carol', 'carol-updated-password').then(() => assert.fail('disabled account logged in'), () => {});
      await restoredSync(vaultA.id, '/h:after-restore', valid, 'PUT', chunk('new'), 201);
      // The source deployment is untouched by the restore.
      await sourceSync(vaultA.id, '/h:after-restore', valid, 'GET', undefined, 404);
    });

    await t.test('verify rejects tampered, missing, partial and incomplete backups', async () => {
      const copy = async name => { const path = join(directory, name); await cp(backup, path, { recursive: true }); return path; };
      const tampered = await copy('tampered');
      const notes = join(tampered, 'notes.tar');
      const data = await readFile(notes); data[data.length - 1] ^= 1; await writeFile(notes, data);
      let result = await cli('verify', tampered);
      assert.equal(result.code, 1); assert.match(result.out.error, /notes\.tar: checksum/);
      const missing = await copy('missing');
      await rm(join(missing, 'config.tar'));
      result = await cli('verify', missing);
      assert.equal(result.code, 1); assert.match(result.out.error, /config\.tar/);
      const partial = await copy('copy.partial');
      assert.match((await cli('verify', partial)).out.error, /Incomplete/);
      const incomplete = await copy('incomplete');
      const manifest = JSON.parse(await readFile(join(incomplete, 'manifest.json'), 'utf8'));
      await writeFile(join(incomplete, 'manifest.json'), JSON.stringify({ ...manifest, complete: false }));
      assert.match((await cli('verify', incomplete)).out.error, /not marked complete/);
      result = await cli('restore', tampered, '--project', run('t'), '--target', join(directory, 'never'), '--port', '1');
      assert.equal(result.code, 1);
      await assert.rejects(stat(join(directory, 'never')));
    });

    await t.test('restore refuses non-empty targets and existing volumes', async () => {
      const target = join(directory, 'occupied');
      await mkdir(target); await writeFile(join(target, 'keep'), 'x');
      let result = await cli('restore', backup, '--project', run('o'), '--target', target, '--port', '1');
      assert.equal(result.code, 1); assert.match(result.out.error, /not empty/);
      assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'x');
      const project = run('v'); projects.push(project);
      await docker('volume', 'create', `${project}_application`);
      await docker('run', '--rm', '-v', `${project}_application:/v`, '--entrypoint', 'sh', 'couchdb:3.5.3@sha256:bed314d10cdf58c0fff63352db4c3f168df58a185a773c0e2295105375c5ef10', '-c', 'echo keep > /v/marker');
      result = await cli('restore', backup, '--project', project, '--target', join(directory, project), '--port', '1');
      assert.equal(result.code, 1); assert.match(result.out.error, /already exists/);
      await assert.rejects(stat(join(directory, project)));
      assert.equal((await docker('run', '--rm', '-v', `${project}_application:/v`, '--entrypoint', 'cat', 'couchdb:3.5.3@sha256:bed314d10cdf58c0fff63352db4c3f168df58a185a773c0e2295105375c5ef10', '/v/marker')).trim(), 'keep');
    });

    await t.test('export failure leaves no backup and resumes the source', async () => {
      const locked = join(directory, 'locked');
      await mkdir(locked); await chmod(locked, 0o500);
      const { code, out } = await cli('backup', '--compose', COMPOSE, '--env-file', env, '--project', source, '--output', locked);
      await chmod(locked, 0o700);
      assert.equal(code, 1);
      assert.equal(out.backup.ok, false); assert.equal(out.backup.stage, 'export volumes');
      assert.equal(out.source.ok, true);
      assert.ok(await running(source, env, 'server'));
      assert.equal((await cli('verify', backup)).code, 0);
    });

    await t.test('a stopped gateway stays stopped after backup', async () => {
      await compose(source, env, 'stop', 'server');
      const { code, out } = await cli('backup', '--compose', COMPOSE, '--env-file', env, '--project', source, '--output', output);
      assert.equal(code, 0, JSON.stringify(out));
      assert.equal(await running(source, env, 'server'), false);
      assert.ok(await running(source, env, 'couchdb'));
      await compose(source, env, 'up', '-d', '--wait', '--no-build', 'server');
    });

    await t.test('source resumption failure is reported separately', async () => {
      const child = spawn(process.execPath, [CLI, 'backup', '--compose', COMPOSE, '--env-file', env, '--project', source, '--output', output]);
      let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
      while (await running(source, env, 'server')) await sleep(100);
      // Holding the published port makes the gateway fail to start again.
      const blocker = createServer().listen(port, '127.0.0.1');
      await once(blocker, 'listening');
      const [code] = await once(child, 'exit');
      blocker.close();
      const out = JSON.parse(stdout);
      assert.equal(code, 1);
      assert.equal(out.backup.ok, true); assert.equal(out.source.ok, false);
      assert.equal((await cli('verify', out.backup.path)).code, 0);
      // After a failed port bind Docker restarts the container without its port mapping, so recreate it.
      await compose(source, env, 'up', '-d', '--wait', '--no-build', '--force-recreate', 'server');
      await sourceSync(vaultA.id, '/h:note', valid);
    });
  } finally {
    for (const project of projects) await docker('compose', '-p', project, 'down', '-v').catch(() => {});
    for (const project of projects) await docker('volume', 'rm', `${project}_application`).catch(() => {});
    if (serverImage) await docker('image', 'rm', '-f', serverImage).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
