// Installs a release directory without the source tree, puts it behind Caddy with HTTPS, then syncs, streams and backs up.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const source = resolve(process.argv[2] ?? join(root, 'release', version));
const cliPath = join(root, 'apps/obsidian/src/apps/cli/dist/index.cjs');
const CADDY = 'caddy:2.10.2';
const project = `trel${Date.now().toString(36)}`;
const directory = await mkdtemp(join(tmpdir(), 'tabularium-release-'));
const release = join(directory, 'release');
const report = { version, source, scenarios: [] };
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(http|https|all)_proxy$/i.test(key)));
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close(); await once(server, 'close');
  return port;
}
async function step(name, fn) {
  await fn();
  report.scenarios.push(name);
  console.log(`PASS ${name}`);
}

let ca, base, testImage, compose;
// Node's fetch cannot take a private CA per call, so HTTPS requests go through node:https with Caddy's root certificate.
function https(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = request(`${base}${path}`, { method, ca, headers: { 'content-type': 'application/json', ...headers } }, res => {
      if (raw) { resolveResponse(res); return; }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolveResponse({ status: res.statusCode, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

try {
  await step('release-checksums', async () => {
    await cp(source, release, { recursive: true });
    await exec('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: release });
    const meta = JSON.parse(await readFile(join(release, 'RELEASE.json'), 'utf8'));
    assert.equal(meta.version, version);
    const manifest = JSON.parse(await readFile(join(release, 'obsidian/tabularium/manifest.json'), 'utf8'));
    assert.deepEqual([manifest.id, manifest.version], ['tabularium', version]);
    const zip = (await exec('unzip', ['-Z1', join(release, `tabularium-obsidian-${version}.zip`)])).stdout.split('\n');
    for (const file of ['tabularium/main.js', 'tabularium/manifest.json', 'tabularium/styles.css', 'tabularium/LICENSE', 'tabularium/NOTICE.md']) assert(zip.includes(file), file);
    const licences = await readFile(join(release, 'THIRD_PARTY_LICENSES.md'), 'utf8');
    // An MPL component is named with where its unmodified source is; the in-repository sync core with its upstream origin.
    assert.match(licences, /dompurify@.*MPL-2\.0.*源码见/);
    assert.match(licences, /- @tabularium\/sync-core@0\.2\.1/);
    assert.match(licences, /派生自 vorotamoroz 的 MIT 代码.*NOTICE\.md/);
  });

  const port = await freePort(), httpsPort = await freePort();
  const deploy = join(release, 'deploy');
  const envFile = join(deploy, '.env');
  const adminPassword = randomBytes(12).toString('hex');
  await step('install-from-release', async () => {
    await docker('load', '-i', join(release, `tabularium-server-${version}.tar`));
    // The host may run a production deployment on tabularium-server, so this copy uses its own image name.
    testImage = `${project}-server`;
    await docker('tag', `tabularium-server:${version}`, testImage);
    const composeFile = join(deploy, 'compose.yaml');
    const composeText = await readFile(composeFile, 'utf8');
    assert(composeText.includes('image: tabularium-server\n'));
    await writeFile(composeFile, composeText.replaceAll('image: tabularium-server\n', `image: ${testImage}\n`));
    const example = await readFile(join(deploy, '.env.example'), 'utf8');
    const env = example
      .replace(/^TABULARIUM_ADMIN_PASSWORD=.*$/m, `TABULARIUM_ADMIN_PASSWORD=${adminPassword}`)
      .replace(/^COUCHDB_ADMIN_PASSWORD=.*$/m, `COUCHDB_ADMIN_PASSWORD=${randomBytes(16).toString('hex')}`)
      .replace(/^COUCHDB_SYNC_PASSWORD=.*$/m, `COUCHDB_SYNC_PASSWORD=${randomBytes(16).toString('hex')}`)
      .replace(/^TABULARIUM_PORT=.*$/m, `TABULARIUM_PORT=${port}`)
      .replace(/^TABULARIUM_PUBLIC_URL=.*$/m, `TABULARIUM_PUBLIC_URL=https://localhost:${httpsPort}`)
      // Tabularius with a provider address that refuses connections: the hosted client and the index work without it.
      .replace(/^TABULARIUS_PROVIDER=.*$/m, 'TABULARIUS_PROVIDER=openai')
      .replace(/^TABULARIUS_MODEL=.*$/m, 'TABULARIUS_MODEL=release-test')
      .replace(/^TABULARIUS_SECRET_KEY=.*$/m, `TABULARIUS_SECRET_KEY=${randomBytes(32).toString('base64')}`)
      .replace(/^OPENAI_API_KEY=.*$/m, 'OPENAI_API_KEY=release-test')
      .replace(/^OPENAI_BASE_URL=.*$/m, 'OPENAI_BASE_URL=http://127.0.0.1:9/v1');
    await writeFile(envFile, env, { mode: 0o600 });
    compose = (...args) => docker('compose', '-f', join(deploy, 'compose.yaml'), '--env-file', envFile, '-p', project, ...args);
    await compose('up', '-d', '--wait');
  });

  await step('https-reverse-proxy', async () => {
    await writeFile(join(directory, 'Caddyfile'), `{
\tadmin off
\tauto_https disable_redirects
}
https://localhost:${httpsPort} {
\ttls internal
\treverse_proxy 127.0.0.1:${port} {
\t\tflush_interval -1
\t\ttransport http {
\t\t\tread_timeout 10m
\t\t}
\t}
}
`);
    await docker('run', '-d', '--name', `${project}-caddy`, '--network', 'host', '-v', `${join(directory, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${project}-caddy:/data`, CADDY);
    const certificate = join(directory, 'caddy-root.crt');
    for (let i = 0; i < 100; i++) {
      try { await docker('cp', `${project}-caddy:/data/caddy/pki/authorities/local/root.crt`, certificate); await access(certificate); break; } catch { await sleep(200); }
    }
    ca = await readFile(certificate);
    base = `https://localhost:${httpsPort}`;
    let health;
    for (let i = 0; i < 50 && health?.status !== 200; i++) { health = await https('/health/ready').catch(() => undefined); if (health?.status !== 200) await sleep(200); }
    assert.equal(health.status, 200);
    const page = await https('/', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200); assert.match(page.text, /Tabularium/);
  });

  let device1, device2, vault, auth;
  const passphrase = randomBytes(16).toString('hex');
  await step('management-api-over-https', async () => {
    let response = await https('/api/v1/sessions', { method: 'POST', body: { username: 'admin', password: adminPassword } });
    assert.equal(response.status, 201);
    const token = response.json().token;
    auth = { authorization: `Bearer ${token}` };
    assert.equal((await https('/api/v1/me/password', { method: 'PUT', headers: auth, body: { currentPassword: adminPassword, password: 'release-admin-password' } })).status, 200);
    response = await https('/api/v1/vaults', { method: 'POST', headers: auth, body: { name: 'release' } });
    assert.equal(response.status, 201); vault = response.json();
    device1 = (await https(`/api/v1/vaults/${vault.id}/devices`, { method: 'POST', headers: auth, body: { name: 'a' } })).json();
    device2 = (await https(`/api/v1/vaults/${vault.id}/devices`, { method: 'POST', headers: auth, body: { name: 'b' } })).json();
  });

  await step('clients-sync-over-https', async () => {
    const files = { 'notes/发布验证.md': '# 发布验证\n\n经 HTTPS 反向代理同步。\n', 'assets/blob.bin': randomBytes(20000) };
    const client = async (name, device) => {
      const c = { db: join(directory, name, 'db'), vault: join(directory, name, 'vault'), settings: join(directory, name, 'settings.json') };
      await mkdir(c.db, { recursive: true }); await mkdir(c.vault, { recursive: true });
      await exec(process.execPath, [cliPath, 'init-settings', c.settings]);
      await writeFile(c.settings, JSON.stringify({ ...JSON.parse(await readFile(c.settings, 'utf8')),
        couchDB_URI: `${base}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
        isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }), { mode: 0o600 });
      c.run = (...args) => exec(process.execPath, [cliPath, c.db, '--settings', c.settings, '--vault', c.vault, ...args],
        { env: { ...clean, NODE_EXTRA_CA_CERTS: join(directory, 'caddy-root.crt') }, timeout: 120_000, maxBuffer: 1 << 24 });
      return c;
    };
    const a = await client('a', device1), b = await client('b', device2);
    for (const [path, content] of Object.entries(files)) { await mkdir(join(a.vault, path, '..'), { recursive: true }); await writeFile(join(a.vault, path), content); }
    await a.run('mirror', a.vault); await a.run('sync');
    await b.run('fetch', '--force', '--write-settings');
    const hash = data => createHash('sha256').update(data).digest('hex');
    for (const path of Object.keys(files)) assert.equal(hash(await readFile(join(b.vault, path))), hash(await readFile(join(a.vault, path))), path);
  });

  await step('tabularius-in-image', async () => {
    assert.equal((await https(`/api/v1/tabularius/vaults/${vault.id}`, { method: 'POST', headers: auth, body: { passphrase, confirm: true } })).status, 201);
    let status;
    for (let i = 0; i < 120 && !(status?.replicated && status.notes === 1); i++) {
      await sleep(1000);
      status = (await https('/api/v1/tabularius', { headers: auth })).json().vaults.find(v => v.id === vault.id);
    }
    assert(status.replicated && status.notes === 1 && status.chunks >= 1, JSON.stringify(status));
    const answer = await https(`/api/v1/tabularius/vaults/${vault.id}/conversations`, { method: 'POST', headers: auth, body: { message: '发布验证' } });
    assert.equal(answer.status, 200);
    assert.match(answer.text, /event: error\ndata: {"message":"OpenAI/);
    const page = await https('/tabularius/', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
  });

  await step('sandbox-in-image', async () => {
    // The release image's sandbox entry point, with the host's Docker socket, as the sandbox profile runs it.
    const token = randomBytes(24).toString('hex');
    const name = `${project}-sandbox`;
    await exec('docker', ['run', '-d', '--name', name, '--user', '0', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-p', '127.0.0.1::3100',
      '-e', `TABULARIUM_SANDBOX_TOKEN=${token}`, '-e', 'TABULARIUS_SANDBOX_IMAGES=alpine:3', testImage, 'node', 'dist/sandbox.js']);
    try {
      const port = (await exec('docker', ['port', name, '3100'])).stdout.trim().split(':').at(-1);
      let result;
      for (let i = 0; i < 30 && !result; i++) {
        result = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ image: 'alpine:3', command: 'echo sandbox-ok; id -u' }) }).then(r => r.json()).catch(() => sleep(1000).then(() => undefined));
      }
      assert.equal(result.stdout, 'sandbox-ok\n65534\n', JSON.stringify(result));
    } finally {
      await exec('docker', ['rm', '-f', name]).catch(() => {});
    }
  });

  await step('continuous-feed-through-proxy', async () => {
    const started = Date.now();
    const res = await https(`/sync/${vault.id}/_changes?feed=continuous&since=now&heartbeat=1000`, { raw: true,
      headers: { authorization: `Basic ${Buffer.from(`${device1.username}:${device1.password}`).toString('base64')}` } });
    assert.equal(res.statusCode, 200);
    const [chunk] = await Promise.race([once(res, 'data'), sleep(3000).then(() => { throw new Error('No heartbeat within 3 seconds'); })]);
    assert.equal(chunk.toString().trim(), '');
    report.firstHeartbeatMs = Date.now() - started;
    res.destroy();
  });

  await step('backup-tool-from-release', async () => {
    const output = join(directory, 'backups');
    const { stdout } = await exec(process.execPath, [join(deploy, 'backup/cli.ts'), 'backup', '--compose', join(deploy, 'compose.yaml'), '--env-file', envFile, '--project', project, '--output', output], { maxBuffer: 1 << 24 });
    const result = JSON.parse(stdout);
    assert(result.backup.ok && result.source.ok, stdout);
    await exec(process.execPath, [join(deploy, 'backup/cli.ts'), 'verify', result.backup.path]);
    assert.equal((await https('/health/ready')).status, 200);
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error?.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await docker('rm', '-f', `${project}-caddy`).catch(() => {});
  await docker('volume', 'rm', `${project}-caddy`).catch(() => {});
  if (compose) await compose('down', '-v').catch(() => {});
  if (testImage) await docker('image', 'rm', testImage).catch(() => {});
  await rm(directory, { recursive: true, force: true });
  const runDir = join(root, 'test-runs', `release-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(runDir, 'report.json')}`);
}
