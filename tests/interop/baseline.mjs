import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const gatewayMode = process.argv.includes('--gateway');
const secrets = [];
let gateway;
let sink;
const physical = name => gateway ? gateway.physical(name) : name;
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const runId = `tabularium-${Date.now()}`;
const runDir = join(root, 'test-runs', runId);
const password = randomBytes(24).toString('hex');
const passphrase = randomBytes(24).toString('hex');
const env = { ...process.env, BASELINE_PASSWORD: password };
const composeArgs = ['compose', '-f', join(root, 'deploy/test/compose.yaml'), '-p', runId];
const cliPath = join(root, 'apps/obsidian/src/apps/cli/dist/index.cjs');
const report = {
  runId, node: process.version, commonlib: '0.2.1', legacyCommonlib: '0.2.0', obsidian: '1.14.5',
  couchdb: '3.5.3@sha256:bed314d10cdf58c0fff63352db4c3f168df58a185a773c0e2295105375c5ef10',
  command: gatewayMode ? 'npm run test:gateway' : 'npm run test:baseline', mode: gatewayMode ? 'gateway' : 'direct', encryption: { algorithm: 'v2', pathObfuscation: true },
  scenarios: [], requests: [],
};
const processes = new Set();
let origin;
let proxy;
let phase = 'setup';

async function compose(...args) {
  return exec('docker', [...composeArgs, ...args], { env, timeout: 120_000 });
}
// `--only=a,b` runs the named scenarios while working on them; the others are reported as skipped and the run as partial.
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice('--only='.length).split(',');
async function scenario(name, fn) {
  if ((process.argv.includes('--desktop') && !['desktop-obsidian', 'fast-fetch'].includes(name)) || (only && !only.includes(name))) {
    report.scenarios.push({ name, status: 'skipped' });
    return;
  }
  phase = name;
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
function redact(text) {
  for (const secret of secrets) text = text.replaceAll(secret, '[secret]');
  return text.replaceAll(password, '[secret]').replaceAll(passphrase, '[secret]')
    .replaceAll(Buffer.from(`baseline:${password}`).toString('base64'), '[credentials]');
}
async function cli(client, ...args) {
  const result = await exec(process.execPath, [client.cli, client.db, '--settings', client.settings,
    '--vault', client.vault, ...args], { cwd: root, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  return result;
}
async function makeClient(name, executable = cliPath, database = 'baseline', extra = {}) {
  const directory = join(runDir, name);
  const client = { cli: executable, db: join(directory, 'db'), vault: join(directory, 'vault'), settings: join(directory, 'settings.json') };
  await mkdir(client.vault, { recursive: true });
  await mkdir(client.db, { recursive: true });
  await exec(process.execPath, [executable, 'init-settings', client.settings], { timeout: 30_000 });
  const settings = JSON.parse(await readFile(client.settings, 'utf8'));
  const credentials = gateway ? await gateway.credentials(database, name) : { database, username: 'baseline', password };
  Object.assign(settings, {
    couchDB_URI: gateway ? `${origin}/sync` : origin, couchDB_DBNAME: credentials.database, couchDB_USER: credentials.username, couchDB_PASSWORD: credentials.password,
    isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true,
    liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false, ...extra,
  });
  await writeFile(client.settings, JSON.stringify(settings), { mode: 0o600 });
  client.device = credentials.username;
  return client;
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
async function equalVaults(a, b) {
  assert.deepEqual(await snapshot(a.vault), await snapshot(b.vault));
}
async function waitFor(check) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error('Timed out waiting for synchronisation');
}
async function daemon(client) {
  const settings = JSON.parse(await readFile(client.settings, 'utf8'));
  settings.liveSync = true;
  await writeFile(client.settings, JSON.stringify(settings));
  const child = spawn(process.execPath, [client.cli, client.db, '--settings', client.settings,
    '--vault', client.vault, 'daemon'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  let output = '';
  // The log is written as it grows, so it is there also when a scenario gives up on a daemon that still runs.
  const log = join(client.db, '../daemon.log');
  const record = (data) => { output += data; void writeFile(log, redact(output)); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.once('exit', () => processes.delete(child));
  await waitFor(async () => {
    assert.equal(child.exitCode, null, redact(output));
    return output.includes('[Daemon] Tabularium active');
  }).catch(error => { throw new Error(`${error.message}\n${redact(output)}`); });
  return child;
}
async function stop(child) {
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  await exited;
}


async function runGatewayDesktop(fast) {
  const name = fast ? 'fast-fetch' : 'desktop';
  await gateway.create(name);
  const credentials = await gateway.credentials(name, name);
  const app = join(root, 'apps/obsidian');
  const binaryRoot = join(app, '_testdata/obsidian-1.14.5/squashfs-root');
  const result = await exec(process.execPath, [join(app, 'node_modules/tsx/dist/cli.mjs'),
    '--tsconfig', join(app, 'tsconfig.json'), join(root, 'tests/interop/fast-fetch.ts')], {
    cwd: app, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', OBSIDIAN_BINARY: join(binaryRoot, 'obsidian'), OBSIDIAN_CLI: join(binaryRoot, 'obsidian-cli'),
      COUCHDB_URI: `${origin}/sync`, COUCHDB_USER: credentials.username, COUCHDB_PASSWORD: credentials.password, COUCHDB_DBNAME: credentials.database,
      E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false', BASELINE_RUN_DIR: runDir, BASELINE_PROVISIONED_DATABASE: 'true',
      BASELINE_FETCH_MODE: fast ? 'fast' : 'standard' },
  });
  await writeFile(join(runDir, `${name}.log`), redact(result.stdout + result.stderr));
}

await mkdir(runDir, { recursive: true });
report.sources = JSON.parse(await readFile(join(root, 'upstream/versions.json'), 'utf8'));
try {
  await compose('up', '-d', '--wait');
  const { stdout } = await compose('port', 'couchdb', '5984');
  let upstream = `http://${stdout.trim()}`;
  const auth = `Basic ${Buffer.from(`baseline:${password}`).toString('base64')}`;
  await writeFile(join(runDir, 'resources.json'), JSON.stringify({ runId, upstream, database: 'baseline' }));
  if (gatewayMode) {
    const { startTestGateway } = await import('./gateway-baseline.mjs');
    const { startSmtpSink } = await import('../../apps/server/test/smtp-sink.mjs');
    await mkdir(join(runDir, 'kindle-mail'));
    sink = await startSmtpSink({ directory: join(runDir, 'kindle-mail') });
    gateway = await startTestGateway(runDir, upstream, password, secrets, {
      smtp: { host: '127.0.0.1', port: sink.port, security: 'none', user: sink.user, password: sink.password, from: 'tabularium@example.test' } });
    await gateway.create('baseline');
  } else {
    const create = await fetch(`${upstream}/baseline`, { method: 'PUT', headers: { Authorization: auth } });
    assert.equal(create.status, 201);
  }
  // Observe the real upstream traffic without recording request bodies or credentials.
  proxy = createServer((req, res) => {
    const url = new URL(req.url, gateway ? gateway.url : upstream);
    const row = { phase, method: req.method, path: url.pathname.replace(/\/baseline\/[^_][^/]*$/, '/baseline/{doc}'),
      feed: url.searchParams.get('feed'), status: null,
      parameters: Object.fromEntries([...url.searchParams].filter(([key]) =>
        ['feed', 'style', 'heartbeat', 'limit', 'revs', 'latest', 'include_docs'].includes(key))) };
    report.requests.push(row);
    if (req.method === 'POST' && url.pathname.endsWith('/_changes')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const parameters = JSON.parse(body);
        row.feed = parameters.feed ?? row.feed ?? 'normal';
        for (const key of ['feed', 'style', 'heartbeat', 'limit', 'include_docs']) {
          if (key in parameters) row.parameters[key] = parameters[key];
        }
      });
    }
    const outgoing = request(url, { method: req.method, headers: req.headers }, response => {
      row.status = response.statusCode;
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    outgoing.on('error', () => { res.destroy(); });
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  origin = `http://127.0.0.1:${proxy.address().port}`;
  const a = await makeClient('a');
  const b = await makeClient('b');
  await scenario('initial-roundtrip', async () => {
    await put(a, 'notes/中文.md', '# Tabularium\n\nEncrypted baseline note.\n');
    await put(a, 'empty.md', '');
    await put(a, 'assets/binary.bin', Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 256)));
    await cli(a, 'mirror', a.vault);
    await cli(a, 'sync');
    await cli(b, 'fetch', '--force', '--write-settings');
    await equalVaults(a, b);
  });
  await scenario('reverse-edit', async () => {
    await put(b, 'notes/中文.md', '# Tabularium\n\nEdited on B.\n');
    await cli(b, 'mirror', b.vault);
    await cli(b, 'sync');
    await cli(a, 'sync');
    await cli(a, 'mirror', a.vault);
    await equalVaults(a, b);
  });
  await scenario('daemon-delete', async () => {
    const receiver = await daemon(a);
    const d = await daemon(b);
    await rm(join(b.vault, 'empty.md'));
    await waitFor(async () => !('empty.md' in await snapshot(a.vault)));
    await stop(d);
    await stop(receiver);
    await equalVaults(a, b);
    assert.equal('empty.md' in await snapshot(a.vault), false);
  });
  if (gateway) await scenario('daemon-rename', async () => {
    const da = await daemon(a); const db = await daemon(b);
    await rename(join(a.vault, 'notes/中文.md'), join(a.vault, 'notes/renamed.md'));
    await waitFor(async () => { const files = await snapshot(b.vault); return 'notes/renamed.md' in files && !('notes/中文.md' in files); });
    await stop(da); await stop(db); await equalVaults(a, b);
  });
  await scenario('restart-offline-edit', async () => {
    await compose('stop', 'couchdb');
    await put(a, 'offline.md', '# Written while the server was stopped\n');
    await compose('start', '--wait', 'couchdb');
    const port = await compose('port', 'couchdb', '5984');
    upstream = `http://${port.stdout.trim()}`;
    await writeFile(join(runDir, 'resources.json'), JSON.stringify({ runId, upstream, database: 'baseline' }));
    if (gateway) await gateway.restart(upstream);
    await cli(a, 'mirror', a.vault);
    await cli(a, 'sync');
    await cli(b, 'sync');
    await cli(b, 'mirror', b.vault);
    await equalVaults(a, b);
  });
  await scenario('fresh-fetch', async () => {
    const c = await makeClient('fresh');
    await cli(c, 'fetch', '--force', '--write-settings');
    await equalVaults(a, c);
  });
  await scenario('encrypted-storage', async () => {
    const response = await fetch(`${upstream}/${physical('baseline')}/_all_docs?include_docs=true`, { headers: { Authorization: auth } });
    const { rows } = await response.json();
    const documents = rows.map(row => row.doc);
    const metadata = documents.filter(doc => 'path' in doc);
    assert(metadata.length > 0);
    for (const doc of metadata) {
      assert(!doc.path.includes('.md') && !doc.path.includes('.bin'));
      assert.equal(doc.mtime, 0);
      assert.equal(doc.size, 0);
      assert.deepEqual(doc.children, []);
    }
    assert(!JSON.stringify(documents).includes('Edited on B.'));
    Object.assign(report.encryption, { metadataCount: metadata.length, visibleControlDocuments: documents.filter(doc => !('path' in doc) && doc.type !== 'leaf').map(doc => doc._id) });
  });
  await scenario('legacy-roundtrip', async () => {
    const legacy = await makeClient('legacy', join(root, '.test-runs/legacy/src/apps/cli/dist/index.cjs'));
    await cli(legacy, 'fetch', '--force', '--write-settings');
    await equalVaults(a, legacy);
    await put(legacy, 'legacy.md', '# Created with Commonlib 0.2.0\n');
    await cli(legacy, 'mirror', legacy.vault);
    await cli(legacy, 'sync');
    await cli(a, 'sync');
    await cli(a, 'mirror', a.vault);
    await equalVaults(a, legacy);
  });
  await scenario('concurrent-conflict', async () => {
    const name = 'conflicts/concurrent.bin';
    const source = join(runDir, 'conflict-source.bin');
    await writeFile(source, Buffer.from([0, 1, 2, 3]));
    await cli(a, 'push', source, name);
    await cli(a, 'sync');
    await cli(b, 'sync');
    const edits = [Buffer.from([0, 11, 12, 13]), Buffer.from([0, 21, 22, 23])];
    await writeFile(source, edits[0]);
    await cli(a, 'push', source, name);
    await writeFile(source, edits[1]);
    await cli(b, 'push', source, name);
    await cli(a, 'sync');
    await cli(b, 'sync');
    await cli(a, 'sync');
    const info = JSON.parse((await cli(a, 'info', name)).stdout);
    assert.notEqual(info.conflicts, 'N/A');
    const revisions = [info.revision, ...info.conflicts.trim().split(/\s+/)];
    const hashes = [];
    for (const revision of revisions) {
      const recovered = join(runDir, `conflict-${revision}.bin`);
      await cli(a, 'pull-rev', name, recovered, revision);
      hashes.push(createHash('sha256').update(await readFile(recovered)).digest('hex'));
    }
    assert.deepEqual(hashes.sort(), edits.map(edit => createHash('sha256').update(edit).digest('hex')).sort());
    report.conflict = { revisions, recoveredHashes: hashes };
    await cli(a, 'resolve', name, info.revision);
    await cli(a, 'sync');
    await cli(b, 'sync');
  });
  await scenario('delete-edit-conflict', async () => {
    const database = 'delete-edit-baseline';
    if (gateway) await gateway.create(database);
    else {
      const created = await fetch(`${upstream}/${database}`, { method: 'PUT', headers: { Authorization: auth } });
      assert.equal(created.status, 201);
    }
    const a = await makeClient('delete-edit-a', cliPath, database);
    const b = await makeClient('delete-edit-b', cliPath, database);
    const name = 'conflicts/delete-edit.md';
    await put(a, name, '# Original\n');
    await cli(a, 'mirror', a.vault);
    await cli(a, 'sync');
    await cli(b, 'fetch', '--force', '--write-settings');
    const info = JSON.parse((await cli(b, 'info', name)).stdout);
    const getRemote = async () => (await fetch(`${upstream}/${physical(database)}/${encodeURIComponent(info.id)}`, {
      headers: { Authorization: auth },
    })).json();
    const unsynced = '# Local change preserved after remote deletion\n';
    await put(a, name, unsynced);
    const deleting = await daemon(b);
    await rm(join(b.vault, name));
    await waitFor(async () => (await getRemote()).deleted === true);
    await stop(deleting);
    const recovering = await daemon(a);
    await stop(recovering);
    assert.equal(await readFile(join(a.vault, name), 'utf8'), unsynced);
    const response = await fetch(`${upstream}/${physical(database)}/${encodeURIComponent(info.id)}?open_revs=all`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    const leaves = (await response.json()).map(row => row.ok);
    const preserved = leaves.filter(doc => !doc.deleted && !doc._deleted);
    assert(preserved.length > 0);
    const recovered = [];
    for (const doc of preserved) {
      const target = join(runDir, `preserved-${doc._rev}.md`);
      await cli(a, 'pull-rev', name, target, doc._rev);
      recovered.push(await readFile(target, 'utf8'));
    }
    assert(recovered.includes(unsynced));
    report.deleteEdit = { preservedLocally: true, recoverableRevisions: preserved.map(doc => doc._rev),
      remoteLeafStates: leaves.map(doc => ({ revision: doc._rev, deleted: doc.deleted === true })),
      requiresUserResolution: true };
  });
  if (gateway) await scenario('unencrypted-client-rejected', async () => {
    const database = 'plaintext-baseline';
    await gateway.create(database);
    const plain = await makeClient('plaintext', cliPath, database, { encrypt: false, passphrase: '', usePathObfuscation: false });
    await put(plain, 'notes/明文笔记.md', '# Plaintext marker 7f3a\n');
    await cli(plain, 'mirror', plain.vault);
    await cli(plain, 'sync').catch(() => {});
    const response = await fetch(`${upstream}/${physical(database)}/_all_docs?include_docs=true`, { headers: { Authorization: auth } });
    const { rows } = await response.json();
    assert.deepEqual(rows.map(row => row.id).filter(id => id !== 'obsydian_livesync_version'), []);
    assert(!JSON.stringify(rows).includes('Plaintext marker') && !JSON.stringify(rows).includes('明文笔记'));
  });
  if (gateway) await scenario('gateway-rebuild', async () => {
    const database = 'rebuild-baseline';
    await gateway.create(database);
    const a = await makeClient('rebuild-a', cliPath, database);
    const b = await makeClient('rebuild-b', cliPath, database);
    await put(a, 'notes/重建前.md', '# Before rebuild\n');
    await cli(a, 'mirror', a.vault);
    await cli(a, 'sync');
    await cli(b, 'fetch', '--force', '--write-settings');
    await equalVaults(a, b);
    const output = error => `${error.stdout ?? ''}${error.stderr ?? ''}`;
    // Without a rebuild window the gateway refuses the database deletion.
    await assert.rejects(cli(a, 'rebuild', '--force'), error => output(error).includes('Rebuild failed'));
    await gateway.arm(database, a.device);
    await put(a, 'notes/重建后.md', '# Added before the rebuild upload\n');
    await cli(a, 'rebuild', '--force');
    // Upstream milestone locking stops devices that have not fetched the rebuilt database.
    await assert.rejects(cli(b, 'sync'), error => output(error).includes('locked'));
    // The upstream CLI counts files that already match the fetched database as failed, so fetch into an empty vault.
    await rm(b.vault, { recursive: true });
    await mkdir(b.vault);
    await cli(b, 'fetch', '--force');
    await equalVaults(a, b);
    const legacy = await makeClient('rebuild-legacy', join(root, '.test-runs/legacy/src/apps/cli/dist/index.cjs'), database);
    await cli(legacy, 'fetch', '--force', '--write-settings');
    await equalVaults(a, legacy);
    // The rebuilding CLI is locked out as well until the remote is unlocked once every device has fetched.
    await cli(a, 'unlock-remote');
    await put(b, 'notes/重建之后.md', '# Written after fetching the rebuilt database\n');
    await cli(b, 'mirror', b.vault);
    await cli(b, 'sync');
    await cli(a, 'sync');
    // After its own rebuild the upstream CLI's storage scan also reports matching files as failed, so read from its database.
    const received = join(runDir, 'rebuild-received.md');
    await cli(a, 'pull', 'notes/重建之后.md', received);
    assert.equal(await readFile(received, 'utf8'), '# Written after fetching the rebuilt database\n');
  });
  // Runs a real-Obsidian script against the gateway as a newly created user.
  async function pluginScript(name, user, extra = {}) {
    const initial = randomBytes(12).toString('hex');
    await gateway.createUser(user, initial);
    const app = join(root, 'apps/obsidian');
    const binaryRoot = join(app, '_testdata/obsidian-1.14.5/squashfs-root');
    const result = await exec(process.execPath, [join(app, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(app, 'tsconfig.json'), join(root, `tests/interop/${name}.ts`)], {
      cwd: app, timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', OBSIDIAN_BINARY: join(binaryRoot, 'obsidian'), OBSIDIAN_CLI: join(binaryRoot, 'obsidian-cli'),
        TABULARIUM_URL: origin.replace(/\/sync$/, ''), TABULARIUM_USER: user, TABULARIUM_PASSWORD: initial,
        E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false', BASELINE_RUN_DIR: runDir, KINDLE_MAIL_DIR: join(runDir, 'kindle-mail'), ...extra },
    }).catch(error => { throw new Error(redact(`${error.message}\n${error.stdout}\n${error.stderr}`)); });
    await writeFile(join(runDir, `${name}.log`), redact(result.stdout + result.stderr));
  }
  if (gateway) await scenario('plugin-login', () => pluginScript('plugin-login', 'obsidian-user'));
  if (gateway) await scenario('send-to-kindle', () => pluginScript('send-to-kindle', 'kindle-user'));
  if (gateway) await scenario('share-from-obsidian', () => pluginScript('share-from-obsidian', 'share-user'));
  if (gateway) await scenario('live-sync-pause', () => pluginScript('live-sync-pause', 'pause-user'));
  await scenario('desktop-obsidian', async () => {
    if (gateway) { await runGatewayDesktop(false); return; }
    const app = join(root, 'apps/obsidian');
    const binaryRoot = join(app, '_testdata/obsidian-1.14.5/squashfs-root');
    const result = await exec('npm', ['run', 'test:e2e:obsidian:cli-to-obsidian-sync'], {
      cwd: app, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', OBSIDIAN_BINARY: join(binaryRoot, 'obsidian'), OBSIDIAN_CLI: join(binaryRoot, 'obsidian-cli'),
        COUCHDB_URI: origin, COUCHDB_USER: 'baseline', COUCHDB_PASSWORD: password, COUCHDB_DBNAME: 'desktop-baseline',
        E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false' },
    });
    await writeFile(join(runDir, 'desktop.log'), redact(result.stdout + result.stderr));
  });
  await scenario('fast-fetch', async () => {
    if (gateway) {
      await runGatewayDesktop(true);
      assert(report.requests.some(row => row.phase === phase && row.feed === 'continuous'));
      return;
    }
    const app = join(root, 'apps/obsidian');
    const binaryRoot = join(app, '_testdata/obsidian-1.14.5/squashfs-root');
    const result = await exec(process.execPath, [join(app, 'node_modules/tsx/dist/cli.mjs'),
      '--tsconfig', join(app, 'tsconfig.json'), join(root, 'tests/interop/fast-fetch.ts')], {
      cwd: app, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '', OBSIDIAN_BINARY: join(binaryRoot, 'obsidian'), OBSIDIAN_CLI: join(binaryRoot, 'obsidian-cli'),
        COUCHDB_URI: origin, COUCHDB_USER: 'baseline', COUCHDB_PASSWORD: password, COUCHDB_DBNAME: 'fast-baseline',
        E2E_OBSIDIAN_CLEANUP_STALE_PROCESSES: 'false', BASELINE_RUN_DIR: runDir },
    });
    await writeFile(join(runDir, 'fast-fetch.log'), redact(result.stdout + result.stderr));
    assert(report.requests.some(row => row.phase === phase && row.feed === 'continuous'));
  });
  // The original Self-hosted LiveSync connects straight to the test CouchDB, beside Tabularium in the same vault.
  if (gateway) await scenario('coexistence', () => pluginScript('coexistence', 'coexistence-user',
    { UPSTREAM_COUCHDB_URI: upstream, UPSTREAM_COUCHDB_USER: 'baseline', UPSTREAM_COUCHDB_PASSWORD: password }));
  // A device set up with the released 0.25.0 plug-in is upgraded to this build.
  if (gateway) await scenario('namespace-migration', () => pluginScript('namespace-migration', 'migration-user'));
  report.status = report.scenarios.some(item => item.status === 'skipped') ? 'partial' : 'passed';
  if (report.status === 'partial') process.exitCode = 1;
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.message + (error.stdout ?? ''));
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try {
    for (const child of processes) await stop(child);
    if (proxy) { proxy.closeAllConnections(); proxy.close(); }
    if (gateway) await gateway.close();
    if (sink) await sink.close();
    await compose('down', '-v');
  } finally {
    await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Report: ${join(runDir, 'report.json')}`);
  }
}
