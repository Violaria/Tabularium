import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const CLI = join(root, 'deploy/backup/cli.ts');
const COMPOSE = join(root, 'deploy/local/compose.yaml');
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
// The gateway accepts only encrypted LiveSync document shapes.
const chunk = data => ({ type: 'leaf', e_: true, data: `%=${data}` });

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
// Layers a change over the current server image, standing in for a newly built release.
async function derive(directory, base, tag, files, dockerfile) {
  await mkdir(directory);
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  await writeFile(join(directory, 'Dockerfile'), `FROM ${base}\n${dockerfile}\n`);
  await docker('build', '-q', '-t', tag, directory);
  return (await docker('image', 'inspect', '-f', '{{.Id}}', tag)).trim();
}

test('upgrade with trial run and rollback to the pre-upgrade image and data', { timeout: 900_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tabularium-upgrade-'));
  const project = `tup${Date.now().toString(36)}`;
  const port = await freePort();
  const env = join(directory, 'source.env');
  const adminPassword = randomBytes(12).toString('hex');
  await writeFile(env, [`TABULARIUM_ADMIN_PASSWORD=${adminPassword}`, `COUCHDB_ADMIN_PASSWORD=${randomBytes(16).toString('hex')}`,
    `COUCHDB_SYNC_PASSWORD=${randomBytes(16).toString('hex')}`, `TABULARIUM_PORT=${port}`, ''].join('\n'), { mode: 0o600 });
  const output = join(directory, 'backups');
  const compose = (...args) => docker('compose', '-f', COMPOSE, '--env-file', env, '-p', project, ...args);
  const deployment = ['--compose', COMPOSE, '--env-file', env, '--project', project, '--output', output];
  const container = async () => JSON.parse((await compose('ps', '-a', '--format', 'json', 'server')).trim());
  const runningImage = async () => (await docker('inspect', '-f', '{{.Image}}', (await container()).ID)).trim();
  const images = [];
  try {
    await compose('up', '-d', '--wait', '--build');
    const base = (await compose('images', '-q', 'server')).trim();
    const baseId = (await docker('image', 'inspect', '-f', '{{.Id}}', base)).trim();
    images.push(baseId);
    const store = await readFile(join(root, 'apps/server/dist/store.js'), 'utf8');
    assert.equal(store.split('    return db;').length, 2);
    // The test release adds one migration on top of the current schema.
    const current = Number(store.match(/if \(version !== (\d+)\)/)[1]);
    const migrated = current + 1;
    const nextStore = store.replace(`if (version !== ${current})`, `if (version !== ${current} && version !== ${migrated})`).replace('    return db;',
      `    if (db.prepare('PRAGMA user_version').get().user_version === ${current}) db.exec('BEGIN; CREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY) STRICT; PRAGMA user_version=${migrated}; COMMIT;');\n    return db;`);
    const serverPackage = JSON.parse(await readFile(join(root, 'apps/server/package.json'), 'utf8'));
    const nextPackage = JSON.stringify({ ...serverPackage, version: `${serverPackage.version}-next` });
    const next = await derive(join(directory, 'next'), `${project}-server`, `${project}-next:test`, { 'store.js': nextStore, 'package.json': nextPackage },
      'COPY store.js /app/dist/store.js\nCOPY package.json /app/package.json');
    const broken = await derive(join(directory, 'broken'), `${project}-server`, `${project}-broken:test`, {}, 'CMD ["node", "-e", "process.exit(1)"]');
    images.push(next, broken);
    const schema = async image => Number((await docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', '-v', `${project}_application:/data`, image, '-e',
      "const db = new (require('node:sqlite').DatabaseSync)(process.env.TABULARIUM_DATABASE, { readOnly: true }); console.log(db.prepare('PRAGMA user_version').get().user_version);")).trim());

    const base_url = `http://127.0.0.1:${port}`;
    const api = async (path, method = 'GET', data, token, expected = 200) => {
      const response = await fetch(`${base_url}/api/v1${path}`, { method, headers: {
        'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await response.text();
      assert.equal(response.status, expected, `${method} ${path}: ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    let device, vault;
    const sync = async (path, method = 'GET', data, expected = 200) => {
      const response = await fetch(`${base_url}/sync/${vault.id}${path}`, { method, headers: {
        authorization: `Basic ${Buffer.from(`${device.username}:${device.password}`).toString('base64')}`, 'content-type': 'application/json',
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      const text = await response.text();
      assert.equal(response.status, expected, `${method} ${path}: ${text}`);
      return JSON.parse(text);
    };
    let admin = (await api('/sessions', 'POST', { username: 'admin', password: adminPassword }, undefined, 201)).token;
    await api('/me/password', 'PUT', { currentPassword: adminPassword, password: 'admin-updated-password' }, admin);
    vault = await api('/vaults', 'POST', { name: 'notes' }, admin, 201);
    device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'desktop' }, admin, 201);
    await sync('/h:before', 'PUT', chunk('before upgrade'), 201);
    let upgradeBackup;

    await t.test('a broken new version fails the trial and leaves the source untouched', async () => {
      const { code, out } = await cli('upgrade', '--image', `${project}-broken:test`, ...deployment);
      assert.equal(code, 1, JSON.stringify(out));
      assert.equal(out.backup.ok, true); assert.equal(out.trial.ok, false);
      assert.equal(out.switch, undefined);
      assert.equal(await runningImage(), baseId);
      await sync('/h:before');
      assert.equal((await docker('ps', '-a', '-q', '--filter', `name=${project}-upgrade-`)).trim(), '');
      assert.equal((await docker('volume', 'ls', '-q', '--filter', `name=${project}-upgrade-`)).trim(), '');
    });

    await t.test('the running image is refused without downtime', async () => {
      const started = (await docker('inspect', '-f', '{{.State.StartedAt}}', (await container()).ID)).trim();
      const { code, out } = await cli('upgrade', '--image', baseId, ...deployment);
      assert.equal(code, 1); assert.match(out.error, /already running/);
      assert.equal((await docker('inspect', '-f', '{{.State.StartedAt}}', (await container()).ID)).trim(), started);
    });

    await t.test('upgrade migrates the source after a successful trial', async () => {
      const { code, out } = await cli('upgrade', '--image', `${project}-next:test`, ...deployment);
      assert.equal(code, 0, JSON.stringify(out));
      assert.deepEqual([out.previous.version, out.next.version], [serverPackage.version, `${serverPackage.version}-next`]);
      assert.deepEqual(out.trial, { ok: true, schema: migrated });
      t.diagnostic(`upgrade: backup downtime ${out.source.downtimeMs} ms, switch downtime ${out.switch.downtimeMs} ms`);
      upgradeBackup = out.backup.path;
      assert.equal((await cli('verify', upgradeBackup)).code, 0);
      assert.equal(await runningImage(), next);
      assert.equal(await schema(next), migrated);
      await sync('/h:before');
      await api('/me', 'GET', undefined, admin);
      assert.equal(await readFile(COMPOSE, 'utf8').then(text => text.includes('-next')), false);
    });

    await t.test('the old image alone cannot open the migrated database', async () => {
      await assert.rejects(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', '-v', `${project}_application:/data`, baseId, '-e',
        "import('/app/dist/store.js').then(m => m.openStore(process.env.TABULARIUM_DATABASE))"), new RegExp(`Unsupported database schema: ${migrated}`));
    });

    await t.test('rollback refuses a backup of another project', async () => {
      const { code, out } = await cli('rollback', upgradeBackup, ...deployment.map(v => v === project ? `${project}-other` : v));
      assert.equal(code, 1); assert.match(out.error, /belongs to project/);
      assert.equal(await runningImage(), next);
    });

    await t.test('rollback restores the pre-upgrade image and data and keeps the upgraded state', async () => {
      await sync('/h:after-upgrade', 'PUT', chunk('written by the new version'), 201);
      await appendFile(env, '# changed after upgrade\n');
      const { code, out } = await cli('rollback', upgradeBackup, ...deployment);
      assert.equal(code, 0, JSON.stringify(out));
      assert.deepEqual(out.changedConfiguration, ['tabularium.env']);
      t.diagnostic(`rollback: downtime ${out.downtimeMs} ms`);
      assert.equal(out.schema, current);
      assert.equal(await runningImage(), baseId);
      assert.equal(await schema(baseId), current);
      await sync('/h:before');
      await sync('/h:after-upgrade', 'GET', undefined, 404);
      await api('/me', 'GET', undefined, admin, 401);
      admin = (await api('/sessions', 'POST', { username: 'admin', password: 'admin-updated-password' }, undefined, 201)).token;
      const kept = out.preRollbackBackup.path;
      assert.equal((await cli('verify', kept)).code, 0);
      const manifest = JSON.parse(await readFile(join(kept, 'manifest.json'), 'utf8'));
      assert.equal(manifest.sqlite.schema, migrated);
      assert.equal(manifest.versions.server.image, next);
      assert.equal(manifest.couchdb[`tab_${vault.id.replaceAll('-', '')}`].docs, 2);
    });

    await t.test('backup stops a crash-looping gateway and leaves it stopped', async () => {
      await docker('tag', broken, `${project}-server`);
      await compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', 'server');
      const restarts = async () => Number((await docker('inspect', '-f', '{{.RestartCount}}', (await container()).ID)).trim());
      for (let i = 0; i < 300 && await restarts() < 2; i++) await sleep(100);
      assert.ok(await restarts() >= 2);
      const { code, out } = await cli('backup', ...deployment);
      assert.equal(code, 0, JSON.stringify(out));
      assert.equal((await container()).State, 'exited');
      await docker('tag', baseId, `${project}-server`);
      await compose('up', '-d', '--wait', '--no-build', '--force-recreate', 'server');
      await sync('/h:before');
    });
  } finally {
    await docker('compose', '-p', project, 'down', '-v').catch(() => {});
    for (const image of [`${project}-server`, `${project}-next:test`, `${project}-broken:test`, ...images]) await docker('image', 'rm', '-f', image).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
