// Rehearses migrating an existing vault (read-only copy) into a temporary Tabularium instance installed from the release package.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const sourceVault = resolve(process.argv[2] ?? '/opt/obsidian/Commentarii');
const release = join(root, 'release', version);
const project = `tmig${Date.now().toString(36)}`;
const directory = await mkdtemp(join(tmpdir(), 'tabularium-migration-'));
const runDir = join(root, 'test-runs', `migration-${Date.now()}`);
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(http|https|all)_proxy$/i.test(key)));
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close(); await once(server, 'close');
  return port;
}

let compose, testImage;
await mkdir(runDir, { recursive: true });
try {
  // Read-only copy of what the server-side LiveSync client synchronises; dot files are not synchronised by the plug-in.
  const copy = join(directory, 'source');
  await exec('rsync', ['-a', '--exclude=.*', `${sourceVault}/`, `${copy}/`]);

  const deploy = join(directory, 'deploy');
  await cp(join(release, 'deploy'), deploy, { recursive: true });
  await docker('load', '-i', join(release, `tabularium-server-${version}.tar`));
  // The host may run a production deployment on tabularium-server, so this copy uses its own image name.
  testImage = `${project}-server`;
  await docker('tag', `tabularium-server:${version}`, testImage);
  const composeFile = join(deploy, 'compose.yaml');
  await writeFile(composeFile, (await readFile(composeFile, 'utf8')).replace('image: tabularium-server\n', `image: ${testImage}\n`));
  const port = await freePort();
  const adminPassword = randomBytes(12).toString('hex');
  const env = (await readFile(join(deploy, '.env.example'), 'utf8'))
    .replace(/^TABULARIUM_ADMIN_PASSWORD=.*$/m, `TABULARIUM_ADMIN_PASSWORD=${adminPassword}`)
    .replace(/^COUCHDB_ADMIN_PASSWORD=.*$/m, `COUCHDB_ADMIN_PASSWORD=${randomBytes(16).toString('hex')}`)
    .replace(/^COUCHDB_SYNC_PASSWORD=.*$/m, `COUCHDB_SYNC_PASSWORD=${randomBytes(16).toString('hex')}`)
    .replace(/^TABULARIUM_PORT=.*$/m, `TABULARIUM_PORT=${port}`);
  await writeFile(join(deploy, '.env'), env, { mode: 0o600 });
  compose = (...args) => docker('compose', '-f', join(deploy, 'compose.yaml'), '--env-file', join(deploy, '.env'), '-p', project, ...args);
  await compose('up', '-d', '--wait');

  const server = `http://127.0.0.1:${port}`;
  const api = async (path, method, body, token, expected = 201) => {
    const response = await fetch(`${server}/api/v1${path}`, { method, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    assert.equal(response.status, expected, path);
    return response.json();
  };
  const admin = (await api('/sessions', 'POST', { username: 'admin', password: adminPassword })).token;
  await api('/me/password', 'PUT', { currentPassword: adminPassword, password: 'migration-admin-password' }, admin, 200);
  const userPassword = randomBytes(12).toString('hex');
  await api('/users', 'POST', { username: 'nanako', password: 'nanako-initial-password' }, admin);
  const user = (await api('/sessions', 'POST', { username: 'nanako', password: 'nanako-initial-password' })).token;
  await api('/me/password', 'PUT', { currentPassword: 'nanako-initial-password', password: userPassword }, user, 200);

  const app = join(root, 'apps/obsidian');
  const binaryRoot = join(app, '_testdata/obsidian-1.12.7/squashfs-root');
  const { stdout, stderr } = await exec(process.execPath, [join(app, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(app, 'tsconfig.json'), join(root, 'tests/interop/migration-rehearsal.ts')], {
    cwd: app, timeout: 45 * 60_000, maxBuffer: 1 << 26,
    env: { ...clean, DISPLAY: '', WAYLAND_DISPLAY: '', OBSIDIAN_BINARY: join(binaryRoot, 'obsidian'), OBSIDIAN_CLI: join(binaryRoot, 'obsidian-cli'),
      TABULARIUM_URL: server, TABULARIUM_USER: 'nanako', TABULARIUM_PASSWORD: userPassword, MIGRATION_SOURCE: copy,
      E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false', BASELINE_RUN_DIR: directory },
  }).catch(error => { console.error(error.stdout, error.stderr); throw error; });
  console.log(stdout.split('\n').filter(line => line.startsWith('[migration]') || line.includes('passed')).join('\n'));
  if (stderr.trim()) console.error(stderr.slice(-2000));
  await cp(join(directory, 'migration-report.json'), join(runDir, 'report.json'));
} finally {
  if (compose) await compose('down', '-v').catch(() => {});
  if (testImage) await docker('image', 'rm', testImage).catch(() => {});
  await rm(directory, { recursive: true, force: true });
  console.log(`Report: ${join(runDir, 'report.json')}`);
}
