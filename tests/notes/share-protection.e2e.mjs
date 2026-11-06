// What a share does beyond the basics, in a real browser: links in tables and to headings, embedded notes, addresses that
// stay valid, updates from other devices and after the page was closed, sensitive marks, and copy protection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGateway } from '../../apps/server/dist/server.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const cliPath = join(root, 'apps/server/clients/cli/dist/index.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OPEN = '\u2061\u2062\u2063';
const CLOSE = '\u2063\u2062\u2061';
const MASKED = '••••••';

test('protecting what a share shows', { timeout: 900_000 }, async () => {
  const runId = `share-protection-${Date.now()}`;
  const temp = await mkdtemp(join(tmpdir(), 'tabularium-share-protection-'));
  const password = randomBytes(24).toString('hex');
  const passphrase = randomBytes(16).toString('hex');
  const compose = (...args) => exec('docker', ['compose', '-f', join(root, 'deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  let gateway, browser;
  try {
    await compose('up', '-d', '--wait');
    const port = (await compose('port', 'couchdb', '5984')).stdout.trim();
    gateway = await createGateway({ database: join(temp, 'app.sqlite'), bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
      couch: { url: `http://${port}`, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword: randomBytes(24).toString('hex') } });
    const url = await gateway.listen();
    let token;
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${url}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      assert(response.ok, `${method} ${path}: ${response.status}`);
      return response.json();
    };
    token = (await api('/sessions', 'POST', { username: 'admin', password })).token;
    const userPassword = randomBytes(12).toString('hex');
    await api('/me/password', 'PUT', { currentPassword: password, password: userPassword });
    token = (await api('/sessions', 'POST', { username: 'admin', password: userPassword })).token;
    const vault = await api('/vaults', 'POST', { name: '保护库' });
    const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'cli' });
    const client = { db: join(temp, 'db'), vault: join(temp, 'vault'), settings: join(temp, 'settings.json') };
    const rich = [
      '# 丁', '', '一段够长的正文，用来看换行是否和普通页面一致。'.repeat(6), '', '普通文字 **粗体** *斜体* `行内代码` ==高亮== ~~删除~~ [外链](https://example.com/)。', '',
      '- 第一项', '- [x] 完成的任务', '', '> [!note] 提示', '> 提示的内容', '', '| 列一 | 列二 |', '|---|---|', '| 甲 | 乙 |', '',
      '```python', 'def 函数(值):', '\treturn 值 + 1  # 注释', '```', '', '$E=mc^2$ 与', '', '$$\\frac{a}{b}$$', '', '![[图.png]]', '', '[[附件.pdf]]', '',
      '```mermaid', 'flowchart LR', '  甲方 --> 乙方', '```', '', '## 小节', '', '结尾的文字。', '',
    ].join('\n');
    const notes = {
      '保护/甲.md': `# 甲\n\n口令 ${OPEN}hunter2-secret${CLOSE} 结束。\n\n\`\`\`ini\ntoken = ${OPEN}code-secret${CLOSE}\n\`\`\`\n\n| 列 | 列 |\n|---|---|\n| [[私密\\|别名]] | x |\n\n嵌入：\n\n![[乙]]\n\n[跳到](#小节)\n\n[[乙#乙节]]\n\n${'填充段落。\n\n'.repeat(60)}## 小节\n\n结尾。\n`,
      '保护/乙.md': '乙的正文。\n\n## 乙节\n\n乙节内容。\n',
      '私密.md': '私密正文。\n',
      '单独.md': '单独的正文。\n',
      '可写.md': '可以标记的文字\n',
      '防/丁.md': rich,
      '防/图.png': png,
      '防/附件.pdf': Buffer.from('%PDF-1.4 正文'),
      '明/丁.md': rich,
      '明/图.png': png,
      '明/附件.pdf': Buffer.from('%PDF-1.4 正文'),
    };
    await mkdir(client.db, { recursive: true });
    const write = async (path, content) => { await mkdir(join(client.vault, path, '..'), { recursive: true }); await writeFile(join(client.vault, path), content); };
    for (const [path, content] of Object.entries(notes)) await write(path, content);
    await exec(process.execPath, [cliPath, 'init-settings', client.settings]);
    await writeFile(client.settings, JSON.stringify({ ...JSON.parse(await readFile(client.settings, 'utf8')),
      couchDB_URI: `${url}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
      isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }));
    const cli = (...args) => exec(process.execPath, [cliPath, client.db, '--settings', client.settings, '--vault', client.vault, ...args], { cwd: root, timeout: 90_000 });
    const push = async () => { await cli('mirror', client.vault); await cli('sync'); };
    await push();

    browser = await chromium.launch({ headless: true });
    const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    await ownerContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    const owner = await ownerContext.newPage();
    const visitorContext = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' });
    const visitor = await visitorContext.newPage();
    const errors = [];
    owner.on('pageerror', error => errors.push(error.message)); visitor.on('pageerror', error => errors.push(error.message));
    const unlock = async () => {
      await owner.goto(`${url}/notes/`);
      if (await owner.getByLabel('用户名').isVisible().catch(() => false)) {
        await owner.getByLabel('用户名').fill('admin');
        await owner.getByLabel('密码').fill(userPassword);
        await owner.getByRole('button', { name: '登录' }).click();
        await owner.getByRole('link', { name: '云笔记', exact: true }).click();
      }
      await owner.getByRole('button', { name: '保护库' }).click();
      await owner.getByLabel('E2EE 密码短语').fill(passphrase);
      await owner.getByRole('button', { name: '解锁' }).click();
      await expect(owner.locator('.vault-more')).toBeVisible({ timeout: 120_000 });
    };
    await unlock();
    const menu = async name => {
      const row = owner.locator('.row', { has: owner.getByRole('button', { name, exact: true }) });
      await row.hover();
      await row.getByRole('button', { name: '更多操作' }).click();
      await owner.getByRole('menuitem', { name: '分享…' }).click();
      return owner.locator('dialog.share-dialog');
    };
    const created = async (dialog, slug) => {
      await dialog.locator('.address input').fill(slug);
      await dialog.getByRole('button', { name: '创建链接' }).click();
      await expect(dialog.locator('#share-link')).toHaveValue(new RegExp(`/s/${slug}`), { timeout: 60_000 });
      const link = await dialog.locator('#share-link').inputValue();
      await dialog.getByRole('button', { name: '关闭' }).click();
      return link;
    };
    const article = visitor.locator('article');
    const eventually = (check, timeout = 90_000) => expect.poll(async () => {
      await visitor.reload();
      await article.waitFor({ timeout: 15_000 }).catch(() => {});
      return check();
    }, { timeout, intervals: [3000] });

    // A folder with a marked password and token, a link in a table, an embedded note and links to headings.
    let dialog = await menu('保护');
    await expect(dialog.locator('label.reference', { hasText: '私密.md' })).toBeVisible();
    await expect(dialog.getByLabel('脱敏')).toBeChecked();
    await expect(dialog.getByText('2 处')).toBeVisible();
    const folderLink = await created(dialog, 'folder');
    await visitor.goto(folderLink);
    await expect(article).toContainText('结尾。', { timeout: 30_000 });
    const text = await article.textContent();
    assert.doesNotMatch(text, /hunter2|code-secret|别名|私密|[\u2061-\u2063]/);
    assert.equal(text.split(MASKED).length - 1, 2);
    await expect(article.locator('.no-access')).toHaveCount(1);
    await expect(article.locator('a.internal[data-note]', { hasText: /^乙$/ }).first()).toBeVisible();

    // A link to a heading scrolls there and leaves the key in the address, so the page still opens afterwards.
    const keyed = () => visitor.evaluate(() => location.hash.length > 20);
    await article.getByRole('link', { name: '跳到' }).click();
    await expect(article.getByRole('heading', { name: '小节' })).toBeInViewport();
    assert(await keyed(), 'the key stays in the address');
    await visitor.reload();
    await expect(article).toContainText('结尾。');
    // A link opens in a new tab with its key; a link to another note's heading scrolls there.
    const inNewTab = await article.locator('a.internal[data-heading="乙节"]').evaluate(link => link.href);
    const tab = await visitorContext.newPage();
    await tab.goto(inNewTab);
    await expect(tab.locator('article')).toContainText('乙的正文。');
    await tab.close();
    await article.locator('a.internal[data-heading="乙节"]').click();
    await expect(article).toContainText('乙节内容。');
    assert(await keyed());
    const noteAddress = visitor.url();

    // Another device adds a file and changes a note while web notes is open: the share follows, and the address still holds.
    await write('保护/〇新.md', '新文件。\n');
    await write('保护/乙.md', '乙的正文，另一台设备改过。\n\n## 乙节\n\n乙节内容。\n');
    await push();
    await eventually(async () => (await article.textContent()) ?? '').toContain('另一台设备改过');
    await visitor.goto(noteAddress); await visitor.reload();
    await expect(article).toContainText('乙的正文');
    // An address that names nothing opens the first note.
    await visitor.goto(`${url}/s/folder?note=n1${new URL(folderLink).hash}`);
    await expect(visitor.locator('article h1, article p').first()).toBeVisible();

    // Another device deletes a shared note: web notes withdraws the share.
    dialog = await menu('单独');
    const singleLink = await created(dialog, 'single');
    await rm(join(client.vault, '单独.md'));
    await push();
    await cli('rm', '单独.md').catch(() => {});
    await cli('sync');
    await visitor.goto(singleLink);
    await expect.poll(async () => { await visitor.reload(); return visitor.getByText('这个分享已失效').isVisible(); }, { timeout: 90_000, intervals: [3000] }).toBe(true);

    // While the page is closed another device changes a note: the share catches up after the vault opens again.
    await owner.goto('about:blank');
    await write('保护/乙.md', '关闭期间改过的正文。\n');
    await push();
    await unlock();
    await visitor.goto(noteAddress);
    await eventually(async () => (await article.textContent()) ?? '').toContain('关闭期间改过');

    // Turning desensitizing off shares the text as written, without its marks; the same dialog keeps the choice.
    dialog = await menu('保护');
    await dialog.getByLabel('脱敏').uncheck();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog.getByRole('button', { name: '保存' })).toBeEnabled({ timeout: 60_000 });
    await dialog.getByRole('button', { name: '关闭' }).click();
    await visitor.goto(`${url}/s/folder${new URL(folderLink).hash}`);
    await expect(article).toContainText('hunter2-secret', { timeout: 30_000 });
    assert.doesNotMatch(await article.textContent(), /[\u2061-\u2063]/);
    dialog = await menu('保护');
    await expect(dialog.getByLabel('脱敏')).not.toBeChecked();
    await dialog.getByRole('button', { name: '关闭' }).click();

    // Marking in the editor: the menu marks the selection, the marks are not drawn, and copying leaves them behind.
    await owner.getByRole('button', { name: '可写', exact: true }).click();
    await owner.getByRole('button', { name: '编辑' }).click();
    const editor = owner.locator('.editor .cm-content').first();
    await editor.click();
    await owner.keyboard.press('ControlOrMeta+a');
    await owner.getByRole('button', { name: '敏感' }).click();
    await expect(editor.locator('.tabularium-sensitive')).toHaveText('可以标记的文字');
    assert.doesNotMatch(await editor.textContent(), /[\u2061-\u2063]/);
    await owner.keyboard.press('ControlOrMeta+a');
    await owner.keyboard.press('ControlOrMeta+c');
    assert.equal((await owner.evaluate(() => navigator.clipboard.readText())).trim(), '可以标记的文字');
    await owner.getByRole('button', { name: '完成' }).click();
    await expect(owner.locator('.md-body')).toContainText('可以标记的文字');
    assert.doesNotMatch(await owner.locator('.md-body').textContent(), /[\u2061-\u2063]/);

    // The same note twice: as ordinary public page, and with copy protection.
    dialog = await menu('明');
    await dialog.getByText('公开网页', { exact: true }).click();
    const plainLink = await created(dialog, 'plain');
    dialog = await menu('防');
    await dialog.getByText('公开网页', { exact: true }).click();
    await dialog.getByLabel('允许搜索引擎收录').check();
    await dialog.getByLabel('禁止复制').check();
    await expect(dialog.getByLabel('允许搜索引擎收录')).toBeDisabled();
    const protectedLink = await created(dialog, 'guarded');

    await mkdir(resolve('test-runs'), { recursive: true });
    await visitor.setViewportSize({ width: 1100, height: 1300 });
    await visitor.goto(plainLink);
    await expect(article.locator('.mermaid-diagram.drawn svg')).toHaveCount(1, { timeout: 60_000 });
    await expect(article.locator('.katex').first()).toBeVisible();
    await visitor.waitForTimeout(500);
    const plainHeight = await article.evaluate(element => element.getBoundingClientRect().height);
    await visitor.screenshot({ path: resolve('test-runs', `${runId}-plain.png`), fullPage: true });

    const requests = [];
    visitor.on('response', response => { if (response.url().includes('/files/') || response.url().endsWith('/shares/guarded')) requests.push(response); });
    await visitor.goto(protectedLink);
    await expect(visitor.locator('html.share-protected')).toHaveCount(1, { timeout: 60_000 });
    await expect(article.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(visitor.locator('.main.drawing')).toHaveCount(0, { timeout: 60_000 });
    await visitor.screenshot({ path: resolve('test-runs', `${runId}-protected.png`), fullPage: true });
    // The page holds no text of the note, in text or in attributes.
    const words = /一段够长|第一项|函数|注释|E=mc|\\frac|甲方|结尾的文字|提示的内容/;
    assert.doesNotMatch(await visitor.locator('.main').evaluate(element => element.innerHTML), words);
    // Nor do the responses that carried it.
    for (const response of requests) assert.doesNotMatch(Buffer.from(await response.body()).toString('utf8'), words);
    assert((await fetch(`${url}/s/guarded`)).headers.get('x-robots-tag'), 'a protected page stays out of search engines');
    const protectedHeight = await article.evaluate(element => element.getBoundingClientRect().height);
    // Apart from the copy button, gone with its row's height, the two pages differ by less than a line.
    assert(Math.abs(protectedHeight - plainHeight) < 28, `layout: ${plainHeight} and ${protectedHeight}`);
    // Keys and menus are closed; the attachment is a name only.
    const blocked = await visitor.evaluate(() => ['F12', 'i', 'u', 's', 'p', 'c'].map(key => {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: key !== 'F12', shiftKey: key === 'i', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    }));
    assert.deepEqual(blocked, [true, true, true, true, true, true]);
    assert.equal(await visitor.evaluate(() => { const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; }), true);
    await expect(article.locator('.code-copy')).toHaveCount(0);
    const downloads = []; visitor.on('download', download => downloads.push(download));
    await visitor.locator('nav .name', { hasText: '附件' }).click();
    await visitor.waitForTimeout(500);
    assert.deepEqual(downloads, []);
    // A narrower window draws the lines again.
    const widest = () => article.locator('p canvas').evaluateAll(list => Math.max(...list.map(canvas => canvas.getBoundingClientRect().width)));
    const before = await widest();
    const narrow = 600;
    await visitor.setViewportSize({ width: narrow, height: 800 });
    await expect.poll(widest, { timeout: 20_000 }).toBeLessThan(narrow);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await gateway?.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
