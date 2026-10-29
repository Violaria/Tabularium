// Real Obsidian sends notes to Kindle through the gateway's mail relay: a note with an image, a folder book,
// and a multiple selection sent as one book per item. Every received EPUB must pass EPUBCheck.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTemporaryVault, type TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import type { ObsidianLiveSyncSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';
import { parseMessage } from '../../apps/server/test/smtp-sink.mjs';
import { epubErrors } from '../kindle/epubcheck.ts';
import { connectTabularium, startTabularium, until } from './obsidian-runtime.ts';

const server = process.env.TABULARIUM_URL!;
const username = process.env.TABULARIUM_USER!;
const password = randomBytes(12).toString('hex');
const obsidianCli = process.env.OBSIDIAN_CLI!;
const mailDir = process.env.KINDLE_MAIL_DIR!;
const temporary = await mkdtemp(join(process.env.BASELINE_RUN_DIR!, 'send-to-kindle-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const notes: Record<string, string | Buffer> = {
  '书单/第一篇.md': '# 第一篇\n\n## 配图\n\n![[图.png]]\n\n见 [[第二篇]]。\n',
  '书单/子/第二篇.md': '第二篇正文。\n',
  'assets/图.png': png,
  '散篇/甲.md': '甲篇。\n',
};
const step = (name: string) => console.log(`[send-to-kindle] ${name}`);
async function api(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(`${server}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const plugin = (session: ObsidianLiveSyncSession, body: string) =>
  evalObsidianJson<unknown>(obsidianCli, `(async()=>{const p=app.plugins.plugins['tabularium'];${body}})()`, session.cliEnv);
const mails = async () => (await readdir(mailDir)).filter((name) => name.endsWith('.eml')).length;
/** Waits for mail number `n`, checks it and returns the attached book. */
async function received(n: number, fileName: string) {
  await until(async () => (await mails()) >= n, 60_000);
  const mail = parseMessage(await readFile(join(mailDir, `${n}.eml`)));
  assert.deepEqual([mail.to, mail.fileName, mail.type], ['reader@kindle.com', fileName, 'application/epub+zip']);
  const file = join(temporary, `${n}.epub`);
  await writeFile(file, mail.data);
  assert.equal(await epubErrors(file), 0, `${fileName} fails EPUBCheck`);
  return mail.data as Buffer;
}

let session: ObsidianLiveSyncSession | undefined;
const vaults: TemporaryVault[] = [];
try {
  const vault = await createTemporaryVault(); vaults.push(vault);
  for (const [path, content] of Object.entries(notes)) { await mkdir(join(vault.path, path, '..'), { recursive: true }); await writeFile(join(vault.path, path), content); }
  session = await startTabularium(vault, obsidianCli);
  await connectTabularium(session, obsidianCli, { server, username, password: process.env.TABULARIUM_PASSWORD!, newPassword: password,
    vault: { create: 'kindle' }, deviceName: 'Obsidian Kindle', passphrase: randomBytes(16).toString('hex') });
  const token = (await api('/sessions', 'POST', { username, password })).token;
  await api('/me/kindle', 'PUT', { address: 'reader@kindle.com' }, token);
  const before = await mails();
  assert.deepEqual(await plugin(session, 'return JSON.stringify(await p.kindle.status());'), { configured: true, address: 'reader@kindle.com', dailyLimit: 30, remaining: 30 });

  step('a single note with an embedded image');
  await plugin(session, "return JSON.stringify(await p.kindle.send(['书单/第一篇.md'],'第一篇'));");
  const single = await received(before + 1, '第一篇.epub');
  assert(single.includes('OEBPS/images/image-1.png') && single.includes(png), 'image packed into the book');
  assert(single.includes('href="chapter-1.xhtml#h-1"'), 'note headings listed in the table of contents');

  step('a folder with a sub-folder');
  await plugin(session, "const b=p.kindle.book(app.vault.getAbstractFileByPath('书单'));return JSON.stringify(await p.kindle.send(b.notes,b.title,b.folder));");
  const folder = await received(before + 2, '书单.epub');
  assert(folder.includes('第二篇正文') && folder.includes('OEBPS/part-1.xhtml'), 'sub-folder notes grouped under a part page');

  step('a multiple selection from the file explorer menu sends one book per item');
  // A stand-in menu records the items plug-ins add; any other menu call is accepted and ignored.
  const menu = (click: boolean) => `const files=['散篇/甲.md','书单/子'].map(p=>app.vault.getAbstractFileByPath(p));const items=[];const chain=(t)=>new Proxy(t,{get:(o,k)=>k in o?o[k]:()=>chain(o)});const menu=chain({addItem(cb){const i=chain({setTitle(t){i.title=t;return i},setIcon(n){i.icon=n;return i},onClick(f){i.click=f;return i}});cb(i);items.push(i);return menu}});app.workspace.trigger('files-menu',menu,files,'file-explorer');const item=items.find(i=>i.icon==='send');${click ? 'item.click();' : ''}return JSON.stringify(item.title);`;
  const menuTitle = menu(false);
  const title = await plugin(session, menu(true));
  assert.equal(title, 'Send 2 items to Kindle');
  assert((await received(before + 3, '甲.epub')).includes('甲篇'));
  assert((await received(before + 4, '子.epub')).includes('第二篇正文'));

  step('the display language switches the menu to Latin');
  const latin = JSON.parse(await readFile(new URL('../../apps/obsidian/src/common/messagesJson/la.json', import.meta.url), 'utf8'))['tabularium.kindle.sendItems'].replace('${count}', '2');
  await plugin(session, "await p.core.services.setting.applyPartial({displayLanguage:'la'},true);return JSON.stringify(true);");
  const latinTitle = await until(async () => {
    const shown = await plugin(session, menuTitle);
    return shown === latin ? shown : undefined;
  }, 30_000);
  assert.equal(latinTitle, latin);

  const deliveries = await api('/me/kindle/deliveries', 'GET', undefined, token);
  assert.deepEqual(deliveries.map((d: { fileName: string; status: string }) => `${d.fileName} ${d.status}`), ['子.epub sent', '甲.epub sent', '书单.epub sent', '第一篇.epub sent']);
  await api('/sessions/current', 'DELETE', undefined, token);
  console.log('Send to Kindle passed.');
} finally {
  if (session) await session.app.stop();
  for (const vault of vaults) await vault.dispose();
}
