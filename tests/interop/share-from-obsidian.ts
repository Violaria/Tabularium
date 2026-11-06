// Real Obsidian shares a note from the file menu: the dialog lists the references with their defaults, the link carries
// the key, the server holds only ciphertext, marked text stays on the device and shows in the editor, and editing the note
// in Obsidian updates the share after a quiet period.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import type { ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { contentKey, decrypt, fromBase64Url } from '../../apps/obsidian/src/features/tabularium/share/crypto.ts';
import { MARK_CLOSE, MARK_OPEN } from '../../apps/obsidian/src/features/tabularium/sensitive.ts';
import { connectTabularium, startTabularium, until } from './obsidian-runtime.ts';

const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const password = randomBytes(12).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const secret = (value: string) => `${MARK_OPEN}${value}${MARK_CLOSE}`;
const notes: Record<string, string | Buffer> = {
  'Shared/Plan.md': `# Plan\n\nSee [[Private]].\n\n![[chart.png]]\n\nKey ${secret('inlinesecret')}\n\n| a | b |\n| --- | --- |\n| key | ${secret('tablesecret')} |\n\n\`\`\`text\nPW=${secret('fencesecret')}\n\`\`\`\n`,
  'Shared/chart.png': png,
  'Private.md': 'Private text.\n',
};
const step = (name: string) => console.log(`[share-from-obsidian] ${name}`);
const run = (session: ObsidianSession, body: string) =>
  evalObsidianJson<unknown>(obsidianCli, `(async()=>{const p=app.plugins.plugins['tabularium'];${body}})()`, session.cliEnv);

let session: ObsidianSession | undefined;
const vaults: TemporaryVault[] = [];
try {
  const vault = await createTemporaryVault(); vaults.push(vault);
  for (const [path, content] of Object.entries(notes)) { await mkdir(join(vault.path, path, '..'), { recursive: true }); await writeFile(join(vault.path, path), content); }
  session = await startTabularium(vault, obsidianCli);
  await connectTabularium(session, obsidianCli, { server, username, password: process.env.TABULARIUM_PASSWORD!, newPassword: password,
    vault: { create: 'shares' }, passphrase: randomBytes(16).toString('hex') });

  step('"Share…" in the file menu opens the dialog with the references and their defaults');
  // A stand-in menu records the items plug-ins add; any other menu call is accepted and ignored.
  const title = await run(session, "const file=app.vault.getAbstractFileByPath('Shared/Plan.md');const items=[];const chain=(t)=>new Proxy(t,{get:(o,k)=>k in o?o[k]:()=>chain(o)});const menu=chain({addItem(cb){const i=chain({setTitle(t){i.title=t;return i},setIcon(n){i.icon=n;return i},onClick(f){i.click=f;return i}});cb(i);items.push(i);return menu}});app.workspace.trigger('file-menu',menu,file,'file-explorer');const item=items.find(i=>i.icon==='share-2');item.click();return JSON.stringify(item.title);");
  assert.equal(title, 'Share…');
  const references = await until(async () => {
    const found = await run(session!, "const rows=[...document.querySelectorAll('.tabularium-share-modal label.reference')].map(l=>[l.querySelector('.path').textContent,l.querySelector('input').checked]);return JSON.stringify(rows.length?rows:null);");
    return found ?? undefined;
  }, 30_000);
  assert.deepEqual(references, [['Private.md', false], ['Shared/chart.png', true]]);

  step('creating the link');
  await run(session, "[...document.querySelectorAll('.tabularium-share-modal button')].find(b=>b.textContent.trim()==='Create link').click();return JSON.stringify(true);");
  const link = await until(async () => {
    const value = await run(session!, "const v=document.querySelector('.tabularium-share-modal #share-link')?.value;return JSON.stringify(v||null);");
    return (value as string | null) ?? undefined;
  }, 60_000) as string;
  assert.match(link, /\/s\/[A-Za-z0-9]{10}#[A-Za-z0-9_-]{43}$/);
  await run(session, "document.querySelector('.tabularium-share-modal .modal-close-button')?.click();return JSON.stringify(true);");

  // Anyone with the link decrypts the note; the server keeps ciphertext; the private note is only a placeholder.
  const slug = decodeURIComponent(new URL(link).pathname.slice(3));
  const key = await contentKey(fromBase64Url(new URL(link).hash.slice(1)));
  const file = async (name: string) => {
    const response = await fetch(`${server}/api/v1/public/shares/${encodeURIComponent(slug)}/files/${name}`);
    assert.equal(response.status, 200);
    const data = new Uint8Array(await response.arrayBuffer());
    assert(!Buffer.from(data).toString('utf8').includes('Plan'), 'stored as ciphertext');
    return new TextDecoder().decode(await decrypt(key, data));
  };
  const manifest = JSON.parse(await file('manifest'));
  const [noteId] = Object.keys(manifest.notes);
  const [fileId] = Object.keys(manifest.files);
  assert.deepEqual([manifest.title, manifest.notes, manifest.files], ['Plan', { [noteId]: { title: 'Plan' } }, { [fileId]: { name: 'chart.png', type: 'image/png' } }]);
  const text = await file(noteId);
  assert(text.includes('[](share:denied:note)') && text.includes(`![](share:${fileId})`) && !text.includes('Private'), text);
  assert(!/secret/.test(text) && text.split('••••••').length === 4 && !text.includes(MARK_OPEN), text);

  step('marked text shows in the editor, source and live preview, and reading view leaves it plain');
  const shown = async (mode: string, source: boolean) => {
    await run(session!, `const leaf=app.workspace.getLeaf(false);await leaf.openFile(app.vault.getAbstractFileByPath('Shared/Plan.md'),{state:{mode:${JSON.stringify(mode)},source:${source}}});await new Promise(r=>setTimeout(r,1500));return JSON.stringify(true);`);
    return run(session!, "const view=app.workspace.activeLeaf.view;const root=view.containerEl;const marks=[...root.querySelectorAll('.tabularium-sensitive')].filter(e=>e.offsetParent).map(e=>[e.textContent,getComputedStyle(e).backgroundColor,!!e.closest('.cm-table-widget, table')]);const rendered=[...root.querySelectorAll('.tabularium-sensitive-rendered')].filter(e=>e.offsetParent).map(e=>[e.textContent,getComputedStyle(e).backgroundColor,getComputedStyle(e,'::after').content]);const eyes=[...root.querySelectorAll('.tabularium-sensitive-eye')].filter(e=>e.offsetParent).length;return JSON.stringify({mode:view.getMode(),marks,rendered,eyes,invisible:/[\\u2061-\\u2063]/.test(view.previewMode.containerEl.innerText||'')});") as Promise<{ mode: string; marks: [string, string, boolean][]; rendered: [string, string, string][]; eyes: number; invisible: boolean }>;
  };
  const source = await shown('source', true);
  const live = await shown('source', false);
  const reading = await shown('preview', false);
  console.log('[share-from-obsidian] editor marks', JSON.stringify({ source, live, reading }));
  assert.deepEqual(source.marks.map(([value]) => value).sort(), ['fencesecret', 'inlinesecret', 'tablesecret']);
  assert(source.marks.every(([, background]) => background !== 'rgba(0, 0, 0, 0)'), 'marked text has a background');
  assert.equal(source.eyes, 3, 'each marked text has an eye');
  assert.deepEqual(live.rendered.map(([value]) => value), ['tablesecret'], 'a drawn table shows its marked text');
  assert(live.rendered.every(([, background, eye]) => background !== 'rgba(0, 0, 0, 0)' && eye !== 'none'), 'tinted, with an eye');
  assert.equal(reading.marks.length, 0, 'reading view is unchanged');
  assert.deepEqual(reading.rendered.map(([, background, eye]) => [background, eye]), reading.rendered.map(() => ['rgba(0, 0, 0, 0)', 'none']), 'reading view shows no mark');

  step('a table cell in live preview shows one toolbar, the focused editor\'s');
  await shown('source', false);
  // Real input through the window's debugger: a cell opens its editor on a trusted click, and CodeMirror counts focus only in a focused page.
  const toolbars = await run(session, `const remote=window.require('@electron/remote');const contents=remote.getCurrentWebContents();if(!contents.debugger.isAttached())contents.debugger.attach('1.3');await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});const wait=(ms)=>new Promise(r=>setTimeout(r,ms));const mouse=async(x,y)=>{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1});};const cell=[...document.querySelectorAll('.cm-table-widget td')].find(t=>t.textContent.includes('tablesecret'));const modals=document.querySelectorAll('.modal-container').length;for(const type of ['rawKeyDown','keyUp'])await contents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait(400);const left=document.querySelectorAll('.modal-container').length;cell.scrollIntoView({block:'center'});await wait(300);const r=cell.getBoundingClientRect();await mouse(r.x+r.width/2,r.y+r.height/2);await wait(800);const content=document.querySelector('.cm-table-widget .cm-editor .cm-content');const nested=!!content;const word=document.querySelector('.cm-table-widget .cm-editor .tabularium-sensitive')?.getBoundingClientRect()??r;for(const type of ['mousePressed','mouseReleased'])await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:word.x+word.width/2,y:word.y+word.height/2,button:'left',clickCount:2});await wait(800);const all=[...document.querySelectorAll('.tabularium-format-menu')];const shown=all.filter(e=>getComputedStyle(e).display!=='none');const result={modals,left,nested,selection:document.getSelection().toString(),active:document.activeElement?.className,all:all.length,visible:shown.length,inCell:shown.map(e=>!!e.closest('.cm-table-widget')),eye:!!document.querySelector('.cm-table-widget .cm-editor .tabularium-sensitive-eye')};await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});contents.debugger.detach();return JSON.stringify(result);`) as { nested: boolean; selection: string; all: number; visible: number; inCell: boolean[]; eye: boolean };
  console.log('[share-from-obsidian] toolbars', JSON.stringify(toolbars));
  assert.equal(toolbars.nested, true, 'the cell has its own editor');
  assert.equal(toolbars.all, 2, 'both editors hold a selection');
  assert.deepEqual(toolbars.inCell, [true], 'the cell\'s toolbar shows');
  assert.equal(toolbars.eye, true, 'marked text in the cell has an eye');
  assert.equal(reading.invisible, false, 'reading view holds no marks');

  step('editing the note in Obsidian updates the share');
  await run(session, "const f=app.vault.getAbstractFileByPath('Shared/Plan.md');await app.vault.modify(f,(await app.vault.read(f))+'\\nAdded in Obsidian.\\n');return JSON.stringify(true);");
  await until(async () => ((await file(noteId)).includes('Added in Obsidian.') ? true : undefined), 60_000);
  console.log('Share from Obsidian passed.');
} finally {
  if (session) await session.app.stop();
  for (const vault of vaults) await vault.dispose();
}
