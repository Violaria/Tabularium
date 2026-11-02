import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianSession, type ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { loadCouchDbConfig, createCouchDbDatabase, deleteCouchDbDatabase } from '../../apps/obsidian/test/e2e-obsidian/runner/couchdb.ts';
import { createE2eCouchDbPluginData, createE2eObsidianDeviceLocalState, waitForCoreReady, prepareRemote, pushLocalChanges } from '../../apps/obsidian/test/e2e-obsidian/runner/syncWorkflow.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { pinObsidianRuntime } from './obsidian-runtime.ts';

const exec = promisify(execFile);
const config = await loadCouchDbConfig();
const provisioned = process.env.BASELINE_PROVISIONED_DATABASE === 'true';
const standard = process.env.BASELINE_FETCH_MODE === 'standard';
// `seed` only writes the remote; `fetch` only reads a remote seeded earlier with the same passphrase (used by the restore test).
const stage = process.env.BASELINE_STAGE;
const dbName = provisioned ? config.dbPrefix : `fast-fetch-${Date.now()}`;
const temporary = await mkdtemp(join(process.env.BASELINE_RUN_DIR!, 'fast-fetch-'));
const vault = await createTemporaryVault();
await pinObsidianRuntime(vault);
const cli = resolve('../server/clients/cli/dist/index.cjs');
const database = join(temporary, 'database');
const settingsPath = join(temporary, 'settings.json');
const note = '# Fast Fetch\n\n浏览器流式获取。\n';
const attachment = Uint8Array.from({ length: 8192 }, (_, i) => i % 251);
const pluginData = createE2eCouchDbPluginData({ ...config, dbName }, {
  encrypt: true, passphrase: process.env.BASELINE_PASSPHRASE ?? randomBytes(24).toString('hex'), usePathObfuscation: true,
  encryptInternalMetadata: true, E2EEAlgorithm: 'v2', useRequestAPI: false,
});
let session: ObsidianSession | undefined;
try {
  if (!provisioned) await createCouchDbDatabase(config, dbName);
  await mkdir(database);
  await exec(process.execPath, [cli, 'init-settings', settingsPath]);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, ...pluginData }), { mode: 0o600 });
  const run = (...args: string[]) => exec(process.execPath,
    [cli, database, '--settings', settingsPath, ...args], { timeout: 60_000 });
  if (stage !== 'fetch') {
    const source = join(temporary, 'source');
    await writeFile(source, note);
    await run('push', source, 'notes/快取.md');
    await writeFile(source, attachment);
    await run('push', source, 'assets/attachment.bin');
    await run('sync');
  }
  if (stage === 'seed') console.log('Seeded remote.');
  else {
    session = await startObsidianSession({
      binary: process.env.OBSIDIAN_BINARY!, cliBinary: process.env.OBSIDIAN_CLI!, vault,
      pluginData, localStorageEntries: createE2eObsidianDeviceLocalState(vault.name),
    });
    await waitForCoreReady(process.env.OBSIDIAN_CLI!, session.cliEnv);
    if (standard) {
      await prepareRemote(process.env.OBSIDIAN_CLI!, session.cliEnv);
      await pushLocalChanges(process.env.OBSIDIAN_CLI!, session.cliEnv);
    }
    const result = await evalObsidianJson<{ content: string }>(process.env.OBSIDIAN_CLI!, [
      '(async()=>{',
      "const core=app.plugins.plugins['tabularium'].core;",
      standard ? "const deadline=Date.now()+30000; while(!await app.vault.adapter.exists('notes/快取.md') && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));" : 'await core.serviceModules.rebuilder.$fetchLocalDBFast(true);',
      "return JSON.stringify({content:await app.vault.adapter.read('notes/快取.md')});",
      '})()',
    ].join(''), session.cliEnv, 60_000);
    assert.equal(result.content, note);
    assert.deepEqual(new Uint8Array(await readFile(join(vault.path, 'assets/attachment.bin'))), attachment);
    if (standard) {
      const returned = note + '\nEdited in real Obsidian.\n';
      await evalObsidianJson(process.env.OBSIDIAN_CLI!, [
        '(async()=>{',
        "const file=app.vault.getAbstractFileByPath('notes/快取.md');",
        'await new Promise(resolve=>setTimeout(resolve,Math.max(0,file.stat.mtime+2500-Date.now())));',
        `await app.vault.modify(file,${JSON.stringify(returned)});`,
        'return JSON.stringify(true);})()',
      ].join(''), session.cliEnv);
      await pushLocalChanges(process.env.OBSIDIAN_CLI!, session.cliEnv);
      await run('sync');
      const received = join(temporary, 'returned.md');
      await run('pull', 'notes/快取.md', received);
      assert.equal(await readFile(received, 'utf8'), returned);
    }
    console.log(`Real Obsidian ${standard ? 'bidirectional sync' : 'Fast Fetch'} passed.`);
  }
} finally {
  if (session) await session.app.stop();
  await vault.dispose();
  if (!provisioned) await deleteCouchDbDatabase(config, dbName);
  await rm(temporary, { recursive: true });
}
