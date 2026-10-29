// Migrates a copy of an existing vault through the plug-in, then checks every file on a CLI client and a second Obsidian profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { connectTabularium, startTabularium, until, type ObsidianLiveSyncSession, type TemporaryVault } from './obsidian-runtime.ts';

const exec = promisify(execFile);
const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const password = process.env.TABULARIUM_PASSWORD!;
const source = process.env.MIGRATION_SOURCE!;
const runDir = process.env.BASELINE_RUN_DIR!;
const obsidianCli = process.env.OBSIDIAN_CLI!;
const cli = resolve('src/apps/cli/dist/index.cjs');
const passphrase = randomBytes(16).toString('hex');
const report: Record<string, unknown> = {};
const timeoutMs = 15 * 60_000;

async function hashes(directory: string, prefix = directory): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const [k, v] of await hashes(path, prefix)) result.set(k, v);
    else result.set(relative(prefix, path).normalize('NFC'), createHash('sha256').update(new Uint8Array(await readFile(path))).digest('hex'));
  }
  return result;
}
/** Counts missing, extra and differing files without reporting names; names go to the console only on failure. */
function compare(expected: Map<string, string>, actual: Map<string, string>) {
  const missing = [...expected.keys()].filter(k => !actual.has(k));
  const extra = [...actual.keys()].filter(k => !expected.has(k));
  const different = [...expected.keys()].filter(k => actual.has(k) && actual.get(k) !== expected.get(k));
  if (missing.length || extra.length || different.length) console.error(JSON.stringify({ missing, extra, different }, null, 2));
  return { files: actual.size, missing: missing.length, extra: extra.length, different: different.length };
}
async function api(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(`${server}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}

let session: ObsidianLiveSyncSession | undefined;
const vaults: TemporaryVault[] = [];
try {
  const expected = await hashes(source);
  report.sourceFiles = expected.size;
  console.log(`[migration] source copy has ${expected.size} files`);

  const a = await createTemporaryVault(); vaults.push(a);
  await cp(source, a.path, { recursive: true });
  session = await startTabularium(a, obsidianCli);
  const uploadStarted = Date.now();
  await connectTabularium(session, obsidianCli, { server, username, password, vault: { create: 'Commentarii' }, deviceName: 'Obsidian A', passphrase });

  const token = (await api('/sessions', 'POST', { username, password })).token;
  const vault = (await api('/vaults', 'GET', undefined, token)).find((v: { name: string }) => v.name === 'Commentarii');
  const verifier = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'verifier' }, token);
  const authorization = `Basic ${Buffer.from(`${verifier.username}:${verifier.password}`).toString('base64')}`;
  // Uploaded when every file has its metadata document and the count has been stable for ten seconds.
  let last = -1, stableSince = Date.now();
  await until(async () => {
    const response = await fetch(`${server}/sync/${vault.id}/_all_docs?startkey=${encodeURIComponent('"f:"')}&endkey=${encodeURIComponent('"f:\ufff0"')}`, { headers: { authorization } });
    const count = ((await response.json()) as { rows: unknown[] }).rows.length;
    if (count !== last) { last = count; stableSince = Date.now(); }
    return count >= expected.size && Date.now() - stableSince >= 10_000;
  }, timeoutMs, 2000);
  report.uploadMs = Date.now() - uploadStarted - 10_000;
  console.log(`[migration] server received ${last} files`);
  await session.app.stop(); session = undefined;

  const database = join(runDir, 'cli-db'), cliVault = join(runDir, 'cli-vault'), settingsPath = join(runDir, 'cli-settings.json');
  await mkdir(database, { recursive: true }); await mkdir(cliVault, { recursive: true });
  await exec(process.execPath, [cli, 'init-settings', settingsPath]);
  await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')),
    couchDB_URI: `${server}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: verifier.username, couchDB_PASSWORD: verifier.password,
    isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }), { mode: 0o600 });
  const cliStarted = Date.now();
  await exec(process.execPath, [cli, database, '--settings', settingsPath, '--vault', cliVault, 'fetch', '--force', '--write-settings'], { timeout: timeoutMs, maxBuffer: 1 << 26 });
  report.cliFetchMs = Date.now() - cliStarted;
  report.cli = compare(expected, await hashes(cliVault));

  const b = await createTemporaryVault(); vaults.push(b);
  session = await startTabularium(b, obsidianCli);
  const fetchStarted = Date.now();
  await connectTabularium(session, obsidianCli, { server, username, password, vault: { id: vault.id }, deviceName: 'Obsidian B', passphrase });
  // Fetched when every file is present on disk and nothing has changed for ten seconds.
  let lastSize = -1; stableSince = Date.now();
  const fetched = await until(async () => {
    const current = await hashes(b.path);
    const signature = [...current.values()].join();
    if (signature.length !== lastSize) { lastSize = signature.length; stableSince = Date.now(); }
    return current.size >= expected.size && Date.now() - stableSince >= 10_000 ? current : undefined;
  }, timeoutMs, 3000);
  report.obsidianFetchMs = Date.now() - fetchStarted - 10_000;
  report.obsidian = compare(expected, fetched);
  console.log(`[migration] ${JSON.stringify(report)}`);
  await writeFile(join(runDir, 'migration-report.json'), JSON.stringify(report, null, 2));
  for (const side of ['cli', 'obsidian'] as const) {
    const result = report[side] as ReturnType<typeof compare>;
    assert.deepEqual([result.missing, result.extra, result.different], [0, 0, 0], `${side} differs from the source`);
  }
  console.log('Migration rehearsal passed.');
} finally {
  if (session) await session.app.stop();
  for (const vault of vaults) await vault.dispose();
  await sleep(0);
}
