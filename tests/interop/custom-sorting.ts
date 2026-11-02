import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createTemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianLiveSyncSession, type ObsidianLiveSyncSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';

const root = resolve('../..');
const runId = `sorting-${Date.now()}`;
const reportDir = join(root, 'test-runs', runId);
await mkdir(reportDir, { recursive: true });
const binaryRoot = resolve('_testdata/obsidian-1.12.7/squashfs-root');
// The standalone Custom File Explorer sorting plug-in, built from the commit in upstream/versions.json.
const standalone = resolve('../../.test-runs/upstream-plugins/custom-sort');
if (!existsSync(join(standalone, 'main.js'))) throw new Error(`Missing ${standalone}; run tests/interop/prepare-upstream-plugins.sh`);
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
  const settingsPath = join(vault.path, '.obsidian/plugins/tabularium');
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
    await app.plugins.disablePlugin('tabularium');
    if(globalThis.sortTestView.getSortedFolderItems!==globalThis.sortTestOriginal) throw new Error('File explorer patch retained after unload');
    await app.plugins.enablePlugin('tabularium');
    const deadline=Date.now()+30000;
    while(!app.plugins.plugins['tabularium']?.sorting?.ready && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    const sorting=app.plugins.plugins['tabularium'].sorting;
    if(sorting.settings.additionalSortspecFile!=='custom-rules') throw new Error('Sorting settings were not restored');
    sorting.switchPluginStateTo(true);
    return JSON.stringify(true);
  `);
  assert.deepEqual((await evaluate<string[]>("return JSON.stringify(globalThis.sortTestNames('Notes'));")).filter(name => name !== 'sortspec.md'), ['Zeta.md', 'Alpha.md', 'Beta.md']);
  report.scenarios.push('unload-restores-method-and-reload-retains-settings');
  const standaloneDir = join(vault.path, '.obsidian/plugins/custom-sort');
  await mkdir(standaloneDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(standalone, file), join(standaloneDir, file));
  /** Waits until the Notes folder is in the order of its sortspec.md, whichever plug-in sorts it. */
  const sortedBySpec = () => evaluate<boolean>(`
    const deadline=Date.now()+20000;
    const want=JSON.stringify(['Zeta.md','Alpha.md','Beta.md']);
    while(JSON.stringify(globalThis.sortTestNames('Notes').filter(n=>n!=='sortspec.md'))!==want && Date.now()<deadline) await new Promise(r=>setTimeout(r,200));
    return JSON.stringify(JSON.stringify(globalThis.sortTestNames('Notes').filter(n=>n!=='sortspec.md'))===want);
  `);
  const notices = () => evaluate<string[]>("return JSON.stringify([...document.querySelectorAll('.notice')].map(n=>n.textContent));");
  const reloadTabularium = `
    await app.plugins.disablePlugin('tabularium');
    await app.plugins.enablePlugin('tabularium');
    const deadline=Date.now()+30000;
    while(!app.plugins.plugins['tabularium']?.core?.services.appLifecycle.isReady() && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
  `;

  await evaluate(`
    await app.plugins.loadManifests();
    await app.plugins.disablePlugin('tabularium');
    await app.plugins.enablePluginAndSave('custom-sort');
    await app.plugins.plugins['custom-sort'].switchPluginStateTo(true);
    await app.plugins.enablePlugin('tabularium');
    const deadline=Date.now()+30000;
    while(!app.plugins.plugins['tabularium']?.core?.services.appLifecycle.isReady() && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    if(app.plugins.plugins['tabularium'].sorting) throw new Error('Both sorting components enabled');
    return JSON.stringify(true);
  `);
  assert.equal(await sortedBySpec(), true, 'Custom File Explorer sorting sorts the files');
  assert.deepEqual((await notices()).filter(text => /Custom (Sort|File Explorer)/.test(text ?? '')), [], 'no request to disable the standalone plug-in');
  report.scenarios.push('standalone-plugin-sorts-and-built-in-stays-off');

  await evaluate(`
    await app.plugins.disablePluginAndSave('custom-sort');
    ${reloadTabularium}
    const sorting=app.plugins.plugins['tabularium'].sorting;
    if(!sorting?.ready) throw new Error('Built-in sorting not back after disabling the standalone plug-in');
    sorting.switchPluginStateTo(true);
    return JSON.stringify(true);
  `);
  assert.equal(await sortedBySpec(), true, 'the built-in sorting is back');
  report.scenarios.push('standalone-disabled-built-in-returns-on-reload');

  await evaluate(`
    const plugin=app.plugins.plugins['tabularium'];
    const sorting=plugin.sorting;
    await app.plugins.enablePluginAndSave('custom-sort');
    // The next take-over, as the command or a layout change would start it.
    sorting.switchPluginStateTo(true);
    if(!sorting.steppedAside || sorting.ready) throw new Error('Built-in sorting did not step aside');
    if(plugin._children?.includes(sorting)) throw new Error('Built-in sorting still loaded');
    await app.plugins.plugins['custom-sort'].switchPluginStateTo(true);
    return JSON.stringify(true);
  `);
  assert.equal(await sortedBySpec(), true, 'Custom File Explorer sorting sorts the files after the built-in stepped aside');
  await evaluate("await app.plugins.disablePluginAndSave('custom-sort');return JSON.stringify(true);");
  report.scenarios.push('standalone-enabled-while-running-built-in-steps-aside');
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
