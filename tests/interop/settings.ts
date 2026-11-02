// The settings page in real Obsidian (1.14): declared pages, Obsidian's settings search finding rows, rows redrawn
// after a change, destructive buttons with their confirmation, help and version history, the sorting conversion row
// and a language change.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createTemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianSession, type ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { compareLifecycle, DUMP_LIFECYCLE } from './lifecycleOrder.ts';

const root = resolve('../..');
const runId = `settings-${Date.now()}`;
const reportDir = join(root, 'test-runs', runId);
await mkdir(reportDir, { recursive: true });
const binaryRoot = resolve('_testdata/obsidian-1.14.5/squashfs-root');
const binary = join(binaryRoot, 'obsidian');
const cli = join(binaryRoot, 'obsidian-cli');
const vault = await createTemporaryVault('tabularium-settings-');
let session: ObsidianSession | undefined;
const report: { runId: string; obsidian: string; scenarios: string[]; status?: string; error?: string } = { runId, obsidian: '1.14.5', scenarios: [] };

/** Helpers evaluated in Obsidian before each step: waiting, the settings dialogue and its visible rows. */
const helpers = `
  const wait=async(read,what,ms=10000)=>{const deadline=Date.now()+ms;let value;while(!(value=read())&&Date.now()<deadline) await new Promise(r=>setTimeout(r,100));if(!value) throw new Error('Timed out waiting for '+what);return value;};
  const dialogue=()=>document.querySelector('.modal.mod-settings');
  const visible=(el)=>el&&el.offsetParent!==null;
  const rows=()=>[...dialogue().querySelectorAll('.vertical-tab-content-container .setting-item:not(.setting-item-heading)')].filter(visible);
  const names=()=>rows().map(el=>el.querySelector('.setting-item-name')?.textContent.trim()??'');
  const row=(name)=>rows().find(el=>el.querySelector('.setting-item-name')?.textContent.trim()===name);
  const openTab=async()=>{app.setting.open();await wait(()=>dialogue(),'settings');app.setting.openTabById('tabularium');await wait(()=>row('Sync'),'the Tabularium tab');};
  const openPage=async(name)=>{(await wait(()=>row(name),name)).click();await wait(()=>!row(name)&&rows().length>0,'the page '+name);};
`;

try {
  session = await startObsidianSession({ binary, cliBinary: cli, vault,
    pluginData: { isConfigured: false, couchDB_DBNAME: 'settings-page' },
  });
  const evaluate = <T>(code: string) => evalObsidianJson<T>(cli, `(async()=>{${helpers}${code}})()`, session!.cliEnv, 45_000);
  await evaluate(`
    await wait(()=>app.setting.pluginTabs.some(tab=>tab.id==='tabularium'),'the Tabularium settings tab',30000);
    return JSON.stringify(true);
  `);

  // The handlers on each lifecycle event, in order, as the committed baseline has them.
  const lifecycle = await compareLifecycle(await evaluate<Record<string, string[]>>(DUMP_LIFECYCLE));
  assert.deepEqual(lifecycle, [], lifecycle.join('\n'));
  report.scenarios.push('lifecycle-order-as-baseline');

  // The first level: the connection (here not connected), then one entry per page.
  const first = await evaluate<string[]>(`await openTab();return JSON.stringify(names());`);
  assert.deepEqual(first, ['Sign in to a server to start synchronising.', 'Sync', 'File sorting', 'Send to Kindle', 'Appearance', 'Maintenance', 'Help']);
  report.scenarios.push('connection-then-pages');

  // Obsidian's settings search finds a row on a page by its name and by its description, and opens the page at it.
  const search = await evaluate<{ byName: string[]; byDesc: string[]; opened: boolean }>(`
    const input=await wait(()=>[...dialogue().querySelectorAll('input[type=search], .setting-search-container input')].find(visible),'the search box');
    const find=async(text)=>{
      input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,500));
      const results=dialogue().querySelector('.setting-search-results');
      return results?[...results.querySelectorAll('.setting-search-result-item .vertical-tab-nav-item-title')].filter(visible).map(el=>el.textContent.trim()):[];
    };
    const byName=await find('Restart with sync paused');
    const byDesc=await find('file watching paused');
    await find('Restart with sync paused');
    const result=[...dialogue().querySelectorAll('.setting-search-results .setting-search-result-item')].find(el=>el.textContent.includes('Restart with sync paused'));
    result?.click();
    const opened=Boolean(await wait(()=>row('Restart with sync paused')?.querySelector('button'),'the row after the search').catch(()=>false));
    input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({byName,byDesc,opened});
  `);
  assert.ok(search.byName.includes('Restart with sync paused'), 'found by name');
  assert.ok(search.byDesc.length > 0, 'found by description');
  assert.equal(search.opened, true);
  report.scenarios.push('settings-search-finds-rows-and-opens-the-page');

  // A change that shows or hides rows draws the page again.
  const sync = await evaluate<{ live: string[]; added: string[]; restored: boolean }>(`
    await openTab();
    await openPage('Sync');
    const select=()=>row('Sync mode').querySelector('select');
    const original=select().value;
    const choose=async(mode)=>{const before=names().join('|');select().value=mode;select().dispatchEvent(new Event('change'));await wait(()=>select().value===mode&&names().join('|')!==before,'the rows of '+mode+' sync').catch(()=>false);return names();};
    const live=await choose('live');
    const periodic=await choose('periodic');
    await choose(original);
    return JSON.stringify({live,added:periodic.filter(n=>!live.includes(n)),restored:select().value===original});
  `);
  assert.ok(sync.added.length >= 6, JSON.stringify(sync));
  assert.ok(sync.live.every(name => !/interval/i.test(name)), 'live sync has no interval');
  assert.equal(sync.restored, true);
  report.scenarios.push('rows-follow-the-sync-mode');

  // Destructive buttons are marked and ask first; cancelling leaves things as they are.
  const reset = await evaluate<{ destructive: boolean; asked: boolean; closed: boolean }>(`
    await openTab();
    await openPage('Maintenance');
    const button=(await wait(()=>row('Delete the local database'),'reset row')).querySelector('button');
    const destructive=button.classList.contains('mod-destructive');
    button.click();
    const confirm=await wait(()=>document.querySelector('.tabularium-confirm'),'the confirmation');
    const asked=Boolean(confirm);
    [...confirm.querySelectorAll('button')].find(b=>!b.classList.contains('mod-cta')&&!b.classList.contains('mod-destructive'))?.click();
    const closed=Boolean(await wait(()=>!document.querySelector('.tabularium-confirm'),'the confirmation to close').catch(()=>false));
    return JSON.stringify({destructive,asked,closed});
  `);
  assert.deepEqual(reset, { destructive: true, asked: true, closed: true });
  report.scenarios.push('destructive-button-asks-first');

  // Advanced is a page inside Maintenance.
  const advanced = await evaluate<string[]>(`
    await openPage('Advanced');
    return JSON.stringify(names());
  `);
  assert.ok(advanced.length >= 20, JSON.stringify(advanced));
  report.scenarios.push('advanced-page-in-maintenance');

  // Help topics are pages of paragraphs; the version history lists the releases.
  const help = await evaluate<{ paragraphs: number; versions: string[] }>(`
    await openTab();
    await openPage('Help');
    const topic=rows()[0];
    topic.click();
    const paragraphs=(await wait(()=>[...dialogue().querySelectorAll('.tabularium-help p')].filter(visible),'help paragraphs')).length;
    await openTab();
    await openPage('Help');
    await openPage('Version history');
    return JSON.stringify({paragraphs,versions:names().slice(0,2)});
  `);
  assert.ok(help.paragraphs > 0, 'a help topic has paragraphs');
  assert.equal(help.versions[0], JSON.parse(await readFile(resolve('manifest.json'), 'utf8')).version, 'the newest release first');
  report.scenarios.push('help-and-version-history');

  // A former sorting note gets a conversion row once it appears.
  await evaluate(`await app.vault.create('sortspec.md','---\\nsorting-spec: |-\\n  target-folder: /\\n  Notes\\n---\\n');return JSON.stringify(true);`);
  const sorting = await evaluate<{ shown: boolean; asked: boolean }>(`
    await openTab();
    await openPage('File sorting');
    const convert=await wait(()=>rows().find(el=>el.textContent.includes('sortspec.md')),'the conversion row');
    convert.querySelector('button').click();
    const confirm=await wait(()=>document.querySelector('.tabularium-confirm'),'the conversion preview');
    const asked=confirm.textContent.includes('Collation.md');
    [...confirm.querySelectorAll('button')].find(b=>!b.classList.contains('mod-cta')&&!b.classList.contains('mod-destructive'))?.click();
    await wait(()=>!document.querySelector('.tabularium-confirm'),'the preview to close');
    return JSON.stringify({shown:true,asked});
  `);
  assert.deepEqual(sorting, { shown: true, asked: true });
  report.scenarios.push('sorting-conversion-row');

  // Choosing a language names the pages in it at once.
  const language = await evaluate<string[]>(`
    await openTab();
    await openPage('Appearance');
    const select=row('Language').querySelector('select');
    select.value='zh';select.dispatchEvent(new Event('change'));
    app.setting.openTabById('tabularium');
    await wait(()=>row('同步'),'the pages in Chinese');
    const shown=names();
    await app.plugins.plugins['tabularium'].core.services.setting.applyPartial({displayLanguage:''},true);
    app.setting.close();
    return JSON.stringify(shown);
  `);
  assert.ok(language.includes('同步') && language.includes('维护'), JSON.stringify(language));
  report.scenarios.push('language-change-renames-pages');

  // A plug-in folder copied from another vault: its connection is cleared before anything synchronises.
  const copied = await evaluate<{ file: boolean; uri: string; notice: boolean }>(`
    const plugin=app.plugins.plugins['tabularium'];
    await plugin.core.services.setting.applyPartial({couchDB_URI:'http://127.0.0.1:9/sync',couchDB_DBNAME:'other',couchDB_USER:'u',couchDB_PASSWORD:'p',isConfigured:true},true);
    const file=plugin.manifest.dir+'/tabularium.json';
    await app.vault.adapter.write(file, JSON.stringify({server:'http://127.0.0.1:9',vaultId:'other',vaultName:'Other',deviceId:'d',deviceName:'D',expiresAt:Date.now()+86400000,appId:'another-vault'}));
    await app.plugins.disablePlugin('tabularium');
    await app.plugins.enablePlugin('tabularium');
    await wait(()=>app.setting.pluginTabs.some(tab=>tab.id==='tabularium'),'the plug-in to load again',30000);
    const notice=Boolean(await wait(()=>[...document.querySelectorAll('.notice')].some(n=>n.textContent.includes('Connection belonged to another vault')),'the notice').catch(()=>false));
    return JSON.stringify({file:await app.vault.adapter.exists(file),uri:app.plugins.plugins['tabularium'].core.services.setting.currentSettings().couchDB_URI,notice});
  `);
  assert.deepEqual(copied, { file: false, uri: '', notice: true });
  report.scenarios.push('connection-copied-from-another-vault-is-cleared');

  report.status = 'passed';
  console.log(`PASS ${report.scenarios.length} real Obsidian settings scenarios`);
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  if (session) await session.app.stop();
  await vault.dispose();
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(reportDir, 'report.json')}`);
}
