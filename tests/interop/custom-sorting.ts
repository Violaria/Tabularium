// File sorting in real Obsidian: the order from the list in Collation.md, live updates, pausing and unloading, converting
// the former front-matter rules, and stepping aside for the standalone Custom File Explorer sorting plug-in.
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
const binaryRoot = resolve('_testdata/obsidian-1.14.5/squashfs-root');
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
const rules = ['文件的顺序。', '', '- Notes —— 笔记放最前', '  - Zeta', '  - ...', '  - Alpha —— 最后读', '- Default', ''].join('\n');
await writeFile(join(vault.path, 'Collation.md'), rules);
let session: ObsidianLiveSyncSession | undefined;
const report: { runId: string; obsidian: string; scenarios: string[]; status?: string; error?: string } = { runId, obsidian: '1.14.5', scenarios: [] };
try {
  session = await startObsidianLiveSyncSession({ binary, cliBinary: cli, vault,
    pluginData: { isConfigured: false, couchDB_DBNAME: 'sorting-preserves-sync-config' },
  });
  const evaluate = <T>(code: string) => evalObsidianJson<T>(cli, `(async()=>{${code}})()`, session!.cliEnv, 45_000);
  /** A folder's items as the file list shows them, once they match `want` (or as last seen after 20 seconds). */
  const shown = (folder: string, want?: string[]) => evaluate<string[]>(`
    const view=app.workspace.getLeavesOfType('file-explorer')[0].view;
    const read=()=>view.getSortedFolderItems(${folder === '/' ? 'app.vault.getRoot()' : `app.vault.getAbstractFileByPath(${JSON.stringify(folder)})`}).map(item=>item.file.name);
    const want=${JSON.stringify(want ?? null)};
    const deadline=Date.now()+20000;
    while(want&&JSON.stringify(read())!==JSON.stringify(want)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,200));
    return JSON.stringify(read());
  `);
  const sorting = "app.plugins.plugins['tabularium'].sorting";
  const untilTakenOver = `
    const deadline=Date.now()+30000;
    while(!(${sorting}?.patched) && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    if(!${sorting}?.patched) throw new Error('Sorting did not take over the file list');
  `;
  await evaluate(`
    ${untilTakenOver}
    globalThis.sortTestView=app.workspace.getLeavesOfType('file-explorer')[0].view;
    // Taken over at load, so this is the wrapper.
    globalThis.sortTestWrapped=Object.getPrototypeOf(globalThis.sortTestView).getSortedFolderItems;
    return JSON.stringify(true);
  `);

  assert.deepEqual(await shown('Notes', ['Zeta.md', 'Beta.md', 'Alpha.md']), ['Zeta.md', 'Beta.md', 'Alpha.md']);
  assert.deepEqual(await shown('/', ['Notes', 'Default', 'Collation.md']), ['Notes', 'Default', 'Collation.md']);
  assert.deepEqual(await shown('Default'), ['Alpha.md', 'Beta.md', 'Zeta.md']);
  report.scenarios.push('list-with-notes-and-ellipsis');

  // Reading view: the notes fold behind an icon in Collation.md only.
  await writeFile(join(vault.path, 'Default/Other.md'), '- a —— b\n');
  const reading = await evaluate<{ icons: number; label: string | null; hidden: boolean; open: boolean; other: number }>(`
    const read=async(path)=>{const leaf=app.workspace.getLeaf(true);await leaf.openFile(app.vault.getAbstractFileByPath(path),{state:{mode:'preview'}});await new Promise(r=>setTimeout(r,1500));return leaf.view.containerEl;};
    let deadline=Date.now()+10000;
    while(!app.vault.getAbstractFileByPath('Default/Other.md') && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    const view=await read('Collation.md');
    const icons=[...view.querySelectorAll('.markdown-reading-view .tabularium-collation-note')];
    const text=icons[0]?.nextElementSibling;
    const hidden=text?getComputedStyle(text).display==='none':false;
    icons[0]?.click();
    const open=text?getComputedStyle(text).display!=='none':false;
    const other=(await read('Default/Other.md')).querySelectorAll('.tabularium-collation-note').length;
    await app.vault.delete(app.vault.getAbstractFileByPath('Default/Other.md'));
    return JSON.stringify({icons:icons.length,label:icons[0]?.getAttribute('aria-label')??null,hidden,open,other});
  `);
  assert.deepEqual(reading, { icons: 2, label: '笔记放最前', hidden: true, open: true, other: 0 });
  report.scenarios.push('notes-folded-behind-an-icon-in-reading-view');

  await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath('Collation.md'), ${JSON.stringify(rules.replace('- Default', '- Default\n  - Beta'))});return JSON.stringify(true);`);
  assert.deepEqual(await shown('Default', ['Beta.md', 'Alpha.md', 'Zeta.md']), ['Beta.md', 'Alpha.md', 'Zeta.md']);
  report.scenarios.push('edited-rules-apply-at-once');

  // The context menu's "Sorting": move to the top or the bottom (written into Collation.md), show in Collation.md, pause.
  const edited = rules.replace('- Default', '- Default\n  - Beta');
  /** Right-clicks an item in the file list and chooses an entry of the Sorting submenu. */
  const menu = (path: string, entry: string) => evaluate<boolean>(`
    const wait=async(read,what)=>{const deadline=Date.now()+10000;let value;while(!(value=read())&&Date.now()<deadline) await new Promise(r=>setTimeout(r,100));if(!value) throw new Error('Timed out waiting for '+what);return value;};
    const view=app.workspace.getLeavesOfType('file-explorer')[0].view;
    view.revealInFolder(app.vault.getAbstractFileByPath(${JSON.stringify(path)}));
    const title=await wait(()=>document.querySelector('[data-path=${JSON.stringify(path)}]'),'the item in the file list');
    title.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}));
    const item=(text)=>[...document.querySelectorAll('.menu .menu-item')].find(el=>el.textContent.trim()===text);
    const sorting=await wait(()=>item('Sorting'),'Sorting in the menu');
    sorting.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    sorting.click();
    (await wait(()=>item(${JSON.stringify(entry)}),${JSON.stringify(entry)})).click();
    await new Promise(r=>setTimeout(r,500));
    return JSON.stringify(true);
  `);
  await menu('Notes/Beta.md', 'Move to the top');
  assert.deepEqual(await shown('Notes', ['Beta.md', 'Zeta.md', 'Alpha.md']), ['Beta.md', 'Zeta.md', 'Alpha.md']);
  assert.match(await readFile(join(vault.path, 'Collation.md'), 'utf8'), /- Notes —— 笔记放最前\n  - Beta\n  - Zeta\n  - \.\.\.\n  - Alpha —— 最后读\n/);
  await menu('Default/Zeta.md', 'Move to the bottom');
  assert.deepEqual(await shown('Default', ['Beta.md', 'Alpha.md', 'Zeta.md']), ['Beta.md', 'Alpha.md', 'Zeta.md']);
  assert.match(await readFile(join(vault.path, 'Collation.md'), 'utf8'), /- Default\n  - Beta\n  - \.\.\.\n  - Zeta\n/);
  report.scenarios.push('menu-moves-to-top-and-bottom');

  await menu('Notes/Alpha.md', 'Show in Collation.md');
  const cursor = await evaluate<{ file: string | null; line: string }>(`
    const editor=app.workspace.activeEditor?.editor;
    return JSON.stringify({file:app.workspace.getActiveFile()?.path??null,line:editor?editor.getLine(editor.getCursor().line):''});
  `);
  assert.deepEqual(cursor, { file: 'Collation.md', line: '  - Alpha —— 最后读' });
  report.scenarios.push('menu-shows-the-item-in-collation');

  await menu('Notes/Alpha.md', 'Pause sorting');
  assert.deepEqual(await shown('Notes', ['Alpha.md', 'Beta.md', 'Zeta.md']), ['Alpha.md', 'Beta.md', 'Zeta.md']);
  await menu('Notes/Alpha.md', 'Apply sorting');
  assert.deepEqual(await shown('Notes', ['Beta.md', 'Zeta.md', 'Alpha.md']), ['Beta.md', 'Zeta.md', 'Alpha.md']);
  report.scenarios.push('menu-pauses-and-applies');
  await evaluate(`await app.vault.modify(app.vault.getAbstractFileByPath('Collation.md'), ${JSON.stringify(edited)});return JSON.stringify(true);`);
  assert.deepEqual(await shown('Notes', ['Zeta.md', 'Beta.md', 'Alpha.md']), ['Zeta.md', 'Beta.md', 'Alpha.md']);

  const settingsPath = join(vault.path, '.obsidian/plugins/tabularium');
  const initialSyncSettings = await readFile(join(settingsPath, 'data.json'), 'utf8');
  await evaluate(`await ${sorting}.setSuspended(true);return JSON.stringify(true);`);
  assert.deepEqual(await shown('Notes', ['Alpha.md', 'Beta.md', 'Zeta.md']), ['Alpha.md', 'Beta.md', 'Zeta.md']);
  assert.equal(JSON.parse(await readFile(join(settingsPath, 'sorting.json'), 'utf8')).suspended, true);
  assert.equal(await readFile(join(settingsPath, 'data.json'), 'utf8'), initialSyncSettings);
  report.scenarios.push('pause-restores-default-order-and-settings-stay-apart');

  await evaluate(`
    await app.plugins.disablePlugin('tabularium');
    if(Object.getPrototypeOf(globalThis.sortTestView).getSortedFolderItems===globalThis.sortTestWrapped) throw new Error('File list method retained after unload');
    await app.plugins.enablePlugin('tabularium');
    ${untilTakenOver}
    if(!${sorting}.settings.suspended) throw new Error('Pause was not kept across a reload');
    await ${sorting}.setSuspended(false);
    return JSON.stringify(true);
  `);
  assert.deepEqual(await shown('Notes', ['Zeta.md', 'Beta.md', 'Alpha.md']), ['Zeta.md', 'Beta.md', 'Alpha.md']);
  report.scenarios.push('unload-restores-method-and-reload-keeps-settings');

  // The former note, sortspec.md with front-matter rules: not read until converted on the settings page.
  const former = '---\nsorting-spec: |-\n  target-folder: /\n  Default\n  Notes\n  target-folder: Notes\n  Beta\n  ...\n---\n\n说明。\n';
  await evaluate(`await app.vault.delete(app.vault.getAbstractFileByPath('Collation.md'));await app.vault.create('sortspec.md', ${JSON.stringify(former)});return JSON.stringify(true);`);
  assert.deepEqual(await shown('Notes', ['Alpha.md', 'Beta.md', 'Zeta.md']), ['Alpha.md', 'Beta.md', 'Zeta.md']);
  await evaluate(`
    let deadline=Date.now()+10000;
    while(!${sorting}.formerRules.includes('sortspec.md') && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    const done=${sorting}.convert('sortspec.md');
    let button;
    deadline=Date.now()+10000;
    while(!(button=document.querySelector('.tabularium-confirm .mod-cta, .tabularium-confirm .mod-destructive')) && Date.now()<deadline) await new Promise(r=>setTimeout(r,100));
    if(!document.querySelector('.tabularium-confirm-preview')?.textContent.includes('- Notes')) throw new Error('No preview of the list');
    button.click();
    await done;
    return JSON.stringify(true);
  `);
  assert.equal(await readFile(join(vault.path, 'Collation.md'), 'utf8'), '- Default\n- Notes\n  - Beta\n  - ...\n\n说明。\n');
  assert.equal(existsSync(join(vault.path, 'sortspec.md')), false, 'the former note was renamed');
  assert.deepEqual(await shown('Notes', ['Beta.md', 'Alpha.md', 'Zeta.md']), ['Beta.md', 'Alpha.md', 'Zeta.md']);
  assert.deepEqual(await shown('/', ['Default', 'Notes', 'Collation.md']), ['Default', 'Notes', 'Collation.md']);
  report.scenarios.push('front-matter-rules-converted-after-preview');

  // The standalone plug-in reads front-matter rules from sortspec.md, Tabularium its list in Collation.md: same order.
  await evaluate(`await app.vault.create('sortspec.md', ${JSON.stringify('---\nsorting-spec: |-\n  target-folder: Notes\n  Zeta\n  Alpha\n  Beta\n---\n')});await app.vault.modify(app.vault.getAbstractFileByPath('Collation.md'), ${JSON.stringify('- Notes\n  - Zeta\n  - Alpha\n  - Beta\n')});return JSON.stringify(true);`);
  const standaloneDir = join(vault.path, '.obsidian/plugins/custom-sort');
  await mkdir(standaloneDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(join(standalone, file), join(standaloneDir, file));
  const notices = () => evaluate<string[]>("return JSON.stringify([...document.querySelectorAll('.notice')].map(n=>n.textContent));");
  const reloadTabularium = `
    await app.plugins.disablePlugin('tabularium');
    await app.plugins.enablePlugin('tabularium');
    const ready=Date.now()+30000;
    while(!app.plugins.plugins['tabularium']?.core?.services.appLifecycle.isReady() && Date.now()<ready) await new Promise(r=>setTimeout(r,100));
  `;
  await evaluate(`
    await app.plugins.loadManifests();
    await app.plugins.disablePlugin('tabularium');
    await app.plugins.enablePluginAndSave('custom-sort');
    await app.plugins.plugins['custom-sort'].switchPluginStateTo(true);
    ${reloadTabularium}
    if(${sorting}) throw new Error('Both sorting components enabled');
    return JSON.stringify(true);
  `);
  assert.deepEqual(await shown('Notes', ['Zeta.md', 'Alpha.md', 'Beta.md']), ['Zeta.md', 'Alpha.md', 'Beta.md'], 'Custom File Explorer sorting sorts the files');
  assert.deepEqual((await notices()).filter(text => /Custom (Sort|File Explorer)/.test(text ?? '')), [], 'no request to disable the standalone plug-in');
  report.scenarios.push('standalone-plugin-sorts-and-built-in-stays-off');

  await evaluate(`
    await app.plugins.disablePluginAndSave('custom-sort');
    ${reloadTabularium}
    ${untilTakenOver}
    return JSON.stringify(true);
  `);
  assert.deepEqual(await shown('Notes', ['Zeta.md', 'Alpha.md', 'Beta.md']), ['Zeta.md', 'Alpha.md', 'Beta.md'], 'the built-in sorting is back');
  report.scenarios.push('standalone-disabled-built-in-returns-on-reload');

  await evaluate(`
    const sorting=${sorting};
    await app.plugins.enablePluginAndSave('custom-sort');
    // The next take-over, as a rules edit or a command would start it.
    sorting.refresh();
    if(!sorting.steppedAside || app.plugins.plugins['tabularium'].sorting?._loaded) throw new Error('Built-in sorting did not step aside');
    await app.plugins.plugins['custom-sort'].switchPluginStateTo(true);
    return JSON.stringify(true);
  `);
  assert.deepEqual(await shown('Notes', ['Zeta.md', 'Alpha.md', 'Beta.md']), ['Zeta.md', 'Alpha.md', 'Beta.md'], 'Custom File Explorer sorting sorts after the built-in stepped aside');
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
