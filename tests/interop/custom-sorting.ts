import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createTemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianLiveSyncSession, type ObsidianLiveSyncSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';

const root = resolve('../..');
const runId = `sorting-${Date.now()}`;
const reportDir = join(root, 'test-runs', runId);
await mkdir(reportDir, { recursive: true });
const binaryRoot = resolve('_testdata/obsidian-1.12.7/squashfs-root');
const binary = join(binaryRoot, 'obsidian');
const cli = join(binaryRoot, 'obsidian-cli');
const vault = await createTemporaryVault('tabularium-sorting-');
await mkdir(join(vault.path, 'Notes'));
await mkdir(join(vault.path, 'Default'));
for (const folder of ['Notes', 'Default']) {
  for (const name of ['Alpha', 'Beta', 'Zeta']) await writeFile(join(vault.path, folder, `${name}.md`), `# ${name}\n`);
}
const spec = '---\nsorting-spec: |\n  Zeta\n  Alpha\n  Beta\n  ...\n---\n';
await writeFile(join(vault.path, 'Notes/sortspec.md'), spec);
let session: ObsidianLiveSyncSession | undefined;
const report: { runId: string; obsidian: string; scenarios: string[]; status?: string; error?: string } = { runId, obsidian: '1.12.7', scenarios: [] };
try {
  session = await startObsidianLiveSyncSession({ binary, cliBinary: cli, vault,
    pluginData: { isConfigured: false, couchDB_DBNAME: 'sorting-preserves-sync-config' },
  });
  const evaluate = <T>(code: string) => evalObsidianJson<T>(cli, `(async()=>{${code}})()`, session!.cliEnv, 45_000);
  await evaluate(`
    const deadline=Date.now()+30000;
    while(!app.plugins.plugins['tabularium']?.sorting?.ready && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    const plugin=app.plugins.plugins['tabularium'];
    if(!plugin?.sorting?.ready) throw new Error('Sorting component did not start');
    globalThis.sortTestView=app.workspace.getLeavesOfType('file-explorer')[0].view;
    globalThis.sortTestOriginal=globalThis.sortTestView.getSortedFolderItems;
    globalThis.sortTestNames=(folder)=>globalThis.sortTestView.getSortedFolderItems(app.vault.getAbstractFileByPath(folder)).map(item=>item.file.name);
    globalThis.sortTestDefault=globalThis.sortTestNames('Default');
    plugin.sorting.switchPluginStateTo(true);
    return JSON.stringify(true);
  `);
  const ordered = await evaluate<string[]>("return JSON.stringify(globalThis.sortTestNames('Notes'));");
  assert.deepEqual(ordered.filter(name => name !== 'sortspec.md'), ['Zeta.md', 'Alpha.md', 'Beta.md']);
  assert.equal(await evaluate<boolean>("return JSON.stringify(JSON.stringify(globalThis.sortTestNames('Default'))===JSON.stringify(globalThis.sortTestDefault));"), true);
  report.scenarios.push('manual-order-and-unmatched-folder');
  const settingsPath = join(vault.path, '.obsidian/plugins/obsidian-livesync');
  const initialSyncSettings = await readFile(join(settingsPath, 'data.json'), 'utf8');
  await evaluate(`
    const sorting=app.plugins.plugins['tabularium'].sorting;
    sorting.openSettings();
    if(!document.querySelector('.tabularium-sorting-settings')) throw new Error('Settings dialogue missing');
    sorting.settings.additionalSortspecFile='custom-rules';
    await sorting.saveSettings();
    return JSON.stringify(true);
  `);
  assert.equal(JSON.parse(await readFile(join(settingsPath, 'custom-sort.json'), 'utf8')).additionalSortspecFile, 'custom-rules');
  const syncSettings = JSON.parse(await readFile(join(settingsPath, 'data.json'), 'utf8'));
  assert.equal(await readFile(join(settingsPath, 'data.json'), 'utf8'), initialSyncSettings);
  assert.equal('additionalSortspecFile' in syncSettings, false);
  report.scenarios.push('settings-dialogue-and-isolated-persistence');
  const paused = await evaluate<string[]>(`
    app.plugins.plugins['tabularium'].sorting.switchPluginStateTo(false);
    return JSON.stringify(globalThis.sortTestNames('Notes'));
  `);
  assert.deepEqual(paused.filter(name => name !== 'sortspec.md'), ['Alpha.md', 'Beta.md', 'Zeta.md']);
  report.scenarios.push('pause-restores-default-order');
  await evaluate(`
    const file=app.vault.getAbstractFileByPath('Notes/sortspec.md');
    await app.vault.modify(file,${JSON.stringify('---\nsorting-spec: |\n  order-asc: invalid-order\n---\n')});
    const deadline=Date.now()+10000;
    while(!app.metadataCache.getFileCache(file)?.frontmatter?.['sorting-spec']?.includes('invalid-order') && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    const sorting=app.plugins.plugins['tabularium'].sorting;
    sorting.switchPluginStateTo(true);
    if(!sorting.settings.suspended) throw new Error('Invalid spec did not suspend sorting');
    await app.vault.modify(file,${JSON.stringify(spec)});
    return JSON.stringify(true);
  `);
  report.scenarios.push('invalid-spec-suspends-sorting');
  await evaluate(`
    await app.plugins.disablePlugin('obsidian-livesync');
    if(globalThis.sortTestView.getSortedFolderItems!==globalThis.sortTestOriginal) throw new Error('File explorer patch retained after unload');
    await app.plugins.enablePlugin('obsidian-livesync');
    const deadline=Date.now()+30000;
    while(!app.plugins.plugins['tabularium']?.sorting?.ready && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    const sorting=app.plugins.plugins['tabularium'].sorting;
    if(sorting.settings.additionalSortspecFile!=='custom-rules') throw new Error('Sorting settings were not restored');
    sorting.switchPluginStateTo(true);
    return JSON.stringify(true);
  `);
  assert.deepEqual((await evaluate<string[]>("return JSON.stringify(globalThis.sortTestNames('Notes'));")).filter(name => name !== 'sortspec.md'), ['Zeta.md', 'Alpha.md', 'Beta.md']);
  report.scenarios.push('unload-restores-method-and-reload-retains-settings');
  await evaluate(`
    await app.plugins.disablePlugin('obsidian-livesync');
    app.plugins.enabledPlugins.add('custom-sort');
    await app.plugins.enablePlugin('obsidian-livesync');
    if(app.plugins.plugins['tabularium'].sorting) throw new Error('Both sorting components enabled');
    app.plugins.enabledPlugins.delete('custom-sort');
    return JSON.stringify(true);
  `);
  report.scenarios.push('standalone-plugin-prevents-double-patching');
  report.status = 'passed';
  console.log(`PASS ${report.scenarios.length} real Obsidian sorting scenarios`);
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  if (session) await session.app.stop();
  await vault.dispose();
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(reportDir, 'report.json')}`);
}
