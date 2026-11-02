// Scheduled backups end to end: a deployment from the local Compose files writes a full point and two incremental ones
// while a real client (the headless LiveSync client, the plug-in's core) keeps syncing; restore-scheduled brings back the
// middle point and the last one into new projects; the client that edited after the last point carries on against the
// restored server and its edit arrives; a damaged chain is refused before anything is created.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const BACKUP = join(root, 'deploy/backup/cli.ts');
const COMPOSE = join(root, 'deploy/local/compose.yaml');
const CLIENT = join(root, 'apps/server/clients/cli/dist/index.cjs');
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;

async function backupCli(...args) {
  try {
    const { stdout } = await exec(process.execPath, [BACKUP, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 600_000 });
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

test('scheduled backups: full and incremental points restore, a client resumes on the restored server, a damaged chain is refused', { timeout: 1_800_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tabularium-scheduled-'));
  const project = `tsb${Date.now().toString(36)}`;
  const port = await freePort();
  const env = join(directory, 'source.env');
  const scheduled = join(directory, 'scheduled');
  await mkdir(scheduled, { mode: 0o700 });
  const adminPassword = randomBytes(12).toString('hex');
  const passphrase = randomBytes(16).toString('hex');
  await writeFile(env, [`TABULARIUM_ADMIN_PASSWORD=${adminPassword}`, `COUCHDB_ADMIN_PASSWORD=${randomBytes(16).toString('hex')}`,
    `COUCHDB_SYNC_PASSWORD=${randomBytes(16).toString('hex')}`, `TABULARIUM_PORT=${port}`, `TABULARIUM_BACKUP_HOST_DIR=${scheduled}`, ''].join('\n'), { mode: 0o600 });
  const compose = (name, ...args) => docker('compose', '-f', COMPOSE, '--env-file', env, '-p', name, ...args);
  const projects = [project];

  const call = async (base, path, method = 'GET', data, token, expected = 200) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  /** A headless LiveSync client with its own local database, configured for one server address. */
  async function client(name, url, vault, device) {
    const paths = { db: join(directory, `${name}-db`), vault: join(directory, `${name}-vault`), settings: join(directory, `${name}.json`) };
    await mkdir(paths.db, { recursive: true }); await mkdir(paths.vault, { recursive: true });
    await exec(process.execPath, [CLIENT, 'init-settings', paths.settings]);
    const configure = async address => writeFile(paths.settings, JSON.stringify({ ...JSON.parse(await readFile(paths.settings, 'utf8')),
      couchDB_URI: `${address}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
      isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }));
    await configure(url);
    const run = (...args) => exec(process.execPath, [CLIENT, paths.db, '--settings', paths.settings, '--vault', paths.vault, ...args], { cwd: root, timeout: 120_000 });
    return {
      configure,
      write: async (path, content) => { await writeFile(join(paths.vault, path), content); await run('mirror', paths.vault); },
      sync: () => run('sync'),
      read: path => run('cat', path).then(r => r.stdout, () => undefined),
    };
  }

  try {
    await compose(project, 'up', '-d', '--wait', '--build');
    const source = `http://127.0.0.1:${port}`;
    let admin = (await call(source, '/sessions', 'POST', { username: 'admin', password: adminPassword }, undefined, 201)).token;
    await call(source, '/me/password', 'PUT', { currentPassword: adminPassword, password: 'admin-updated-password' }, admin);
    admin = (await call(source, '/sessions', 'POST', { username: 'admin', password: 'admin-updated-password' }, undefined, 201)).token;
    const vault = await call(source, '/vaults', 'POST', { name: 'notes' }, admin, 201);
    const device = await call(source, `/vaults/${vault.id}/devices`, 'POST', { name: 'desktop' }, admin, 201);
    const desktop = await client('desktop', source, vault, device);

    /** "Back up now", then waits for the run to finish; returns the new point. */
    const backUp = async () => {
      const before = (await call(source, '/admin/backups', 'GET', undefined, admin)).points.length;
      await call(source, '/admin/backups/run', 'POST', undefined, admin, 202);
      for (let i = 0; i < 300; i++) {
        const view = await call(source, '/admin/backups', 'GET', undefined, admin);
        if (!view.running && view.points.length > before) {
          assert.equal(view.runs[0].ok, true, view.runs[0].error ?? '');
          return view.points[0];
        }
        await sleep(1000);
      }
      throw new Error('the backup did not finish');
    };
    // Points keep their chain: the first is full, the next two are increments on it.
    await call(source, '/admin/backups/settings', 'PUT', { enabled: false, frequency: 'daily', weekday: 1, monthDay: 1, time: '19:00', timezone: 'Europe/London', keep: 10, fullEvery: 7 }, admin);
    await desktop.write('a.md', 'first\n'); await desktop.sync();
    const full = await backUp();
    await desktop.write('b.md', 'second\n'); await desktop.sync();
    const middle = await backUp();
    await desktop.write('c.md', 'third\n'); await desktop.sync();
    const last = await backUp();
    assert.deepEqual([full.type, middle.type, last.type], ['full', 'incremental', 'incremental']);
    assert.equal(new Set([full.chain, middle.chain, last.chain]).size, 1, 'one chain');
    // An edit on the client after the last point, not yet on any server.
    await desktop.write('d.md', 'after the last point\n');

    const image = (await compose(project, 'images', '-q', 'server')).trim();
    const restoreTo = async (point, name) => {
      const restorePort = await freePort();
      projects.push(name);
      const { code, out, stderr } = await backupCli('restore-scheduled', scheduled, point.id, '--image', image, '--compose', COMPOSE, '--env-file', env,
        '--project', name, '--target', join(directory, name), '--port', String(restorePort));
      return { code, out, stderr, url: `http://127.0.0.1:${restorePort}` };
    };

    await t.test('the middle point has what was synced by then, and nothing after', async () => {
      const restored = await restoreTo(middle, `${project}m`);
      assert.equal(restored.code, 0, JSON.stringify(restored.out ?? restored.stderr));
      // CouchDB was reachable from this host only for the import: afterwards no published port and its internal network only.
      const couch = (await docker('ps', '--filter', `label=com.docker.compose.project=${project}m`, '--filter', 'label=com.docker.compose.service=couchdb', '--format', '{{.Ports}}|{{.Networks}}')).trim();
      const [ports, networks] = couch.split('|');
      assert.doesNotMatch(ports, /->/, 'no port bound on the host');
      assert.equal(networks, `${project}m_database`);
      assert.equal((await docker('network', 'ls', '-q', '--filter', `name=${project}m_restore`)).trim(), '', 'the import network is gone');
      // The account and its password come back with the application database.
      await call(restored.url, '/sessions', 'POST', { username: 'admin', password: 'admin-updated-password' }, undefined, 201);
      const fresh = await client('fresh-middle', restored.url, vault, device);
      await fresh.sync();
      assert.deepEqual([await fresh.read('a.md'), await fresh.read('b.md'), await fresh.read('c.md')], ['first\n', 'second\n', undefined]);
    });

    await t.test('on the last point, the client carries on and its later edit arrives', async () => {
      const restored = await restoreTo(last, `${project}l`);
      assert.equal(restored.code, 0, JSON.stringify(restored.out ?? restored.stderr));
      await desktop.configure(restored.url);
      await desktop.sync();
      const fresh = await client('fresh-last', restored.url, vault, device);
      await fresh.sync();
      assert.deepEqual([await fresh.read('a.md'), await fresh.read('b.md'), await fresh.read('c.md'), await fresh.read('d.md')],
        ['first\n', 'second\n', 'third\n', 'after the last point\n']);
    });

    await t.test('a damaged point in the chain is refused before anything is created', async () => {
      const files = (await readdir(join(scheduled, middle.id))).filter(file => file !== 'manifest.json');
      await appendFile(join(scheduled, middle.id, files[0]), 'x');
      const name = `${project}x`;
      const restored = await restoreTo(last, name);
      assert.equal(restored.code, 1);
      assert.match(restored.out.error, new RegExp(`Backup point ${middle.id}`));
      assert.equal((await docker('ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${name}`)).trim(), '');
      assert.equal((await docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${name}`)).trim(), '');
    });
  } finally {
    for (const name of projects) await compose(name, 'down', '-v', '--remove-orphans').catch(() => {});
    // Restored projects write their own Compose files; their volumes carry the project's name.
    for (const name of projects.slice(1)) for (const volume of (await docker('volume', 'ls', '-q', '--filter', `name=${name}_`)).split('\n').filter(Boolean)) await docker('volume', 'rm', '-f', volume).catch(() => {});
    await docker('image', 'rm', '-f', `${project}-server`).catch(() => {});
    // Backups were written by the container's user; the container removes them.
    await docker('run', '--rm', '-v', `${directory}:/d`, '--entrypoint', 'sh', 'alpine:3', '-c', 'rm -rf /d/scheduled /d/*m /d/*l').catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
