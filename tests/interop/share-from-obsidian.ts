// Real Obsidian shares a note from the file menu: the dialog lists the references with their defaults, the link carries
// the key, the server holds only ciphertext, and editing the note in Obsidian updates the share after a quiet period.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import type { ObsidianLiveSyncSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { contentKey, decrypt, fromBase64Url } from '../../apps/obsidian/src/features/tabularium/share/crypto.ts';
import { connectTabularium, startTabularium, until } from './obsidian-runtime.ts';

const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const password = randomBytes(12).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const notes: Record<string, string | Buffer> = {
  'Shared/Plan.md': '# Plan\n\nSee [[Private]].\n\n![[chart.png]]\n',
  'Shared/chart.png': png,
  'Private.md': 'Private text.\n',
};
const step = (name: string) => console.log(`[share-from-obsidian] ${name}`);
const run = (session: ObsidianLiveSyncSession, body: string) =>
  evalObsidianJson<unknown>(obsidianCli, `(async()=>{const p=app.plugins.plugins['tabularium'];${body}})()`, session.cliEnv);

let session: ObsidianLiveSyncSession | undefined;
const vaults: TemporaryVault[] = [];
try {
  const vault = await createTemporaryVault(); vaults.push(vault);
  for (const [path, content] of Object.entries(notes)) { await mkdir(join(vault.path, path, '..'), { recursive: true }); await writeFile(join(vault.path, path), content); }
  session = await startTabularium(vault, obsidianCli);
  await connectTabularium(session, obsidianCli, { server, username, password: process.env.TABULARIUM_PASSWORD!, newPassword: password,
    vault: { create: 'shares' }, deviceName: 'Obsidian Share', passphrase: randomBytes(16).toString('hex') });

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
  assert.deepEqual([manifest.title, manifest.notes, manifest.files], ['Plan', { n1: { title: 'Plan' } }, { a1: { name: 'chart.png', type: 'image/png' } }]);
  const text = await file('n1');
  assert(text.includes('[](share:denied:note)') && text.includes('![](share:a1)') && !text.includes('Private'), text);

  step('editing the note in Obsidian updates the share');
  await run(session, "const f=app.vault.getAbstractFileByPath('Shared/Plan.md');await app.vault.modify(f,(await app.vault.read(f))+'\\nAdded in Obsidian.\\n');return JSON.stringify(true);");
  await until(async () => ((await file('n1')).includes('Added in Obsidian.') ? true : undefined), 60_000);
  console.log('Share from Obsidian passed.');
} finally {
  if (session) await session.app.stop();
  for (const vault of vaults) await vault.dispose();
}
