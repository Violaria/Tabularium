// The web notes page in real Chromium against a real CouchDB and gateway. A CLI client writes encrypted notes;
// the page logs in, unlocks in the browser, browses, receives live changes, sends to Kindle and clears its data.
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
import { startSmtpSink, parseMessage } from '../../apps/server/test/smtp-sink.mjs';
import { epubErrors } from '../kindle/epubcheck.ts';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const cliPath = join(root, 'apps/server/clients/cli/dist/index.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('web notes page in real Chromium', { timeout: 600_000 }, async () => {
  const runId = `notes-${Date.now()}`;
  const temp = await mkdtemp(join(tmpdir(), 'tabularium-notes-'));
  const password = randomBytes(24).toString('hex');
  const passphrase = randomBytes(16).toString('hex');
  const compose = (...args) => exec('docker', ['compose', '-f', join(root, 'deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  let gateway, browser, sink;
  try {
    await compose('up', '-d', '--wait');
    const port = (await compose('port', 'couchdb', '5984')).stdout.trim();
    sink = await startSmtpSink();
    gateway = await createGateway({ database: join(temp, 'app.sqlite'), bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
      smtp: { host: '127.0.0.1', port: sink.port, security: 'none', user: sink.user, password: sink.password, from: 'tabularium@example.test' },
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
    const vault = await api('/vaults', 'POST', { name: '网页库' });
    await api('/me/kindle', 'PUT', { address: 'reader@kindle.com' });

    // A CLI device writes the encrypted notes.
    const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'cli' });
    const client = { db: join(temp, 'db'), vault: join(temp, 'vault'), settings: join(temp, 'settings.json') };
    const notes = {
      '笔记/中文.md': '# 中文笔记\n\n正文见 [[图示|看图]]。\n\n![[图.png]]\n\n<script>window.__xss = 1</script>\n<img src="x" onerror="window.__xss = 2">\n\n![远程](https://example.com/a.png)\n',
      '笔记/子/图示.md': '图示正文。\n',
      'assets/图.png': png,
      'readme.md': '第一版\n',
      '笔记/排版.md': [
        '# 排版示例', '', '一段正文，带 `inline code` 和 [外部链接](https://example.com)。', '', '## 安装', '',
        '```bash', 'cd /root', 'sudo ./ddns-go -s install -l :9876 -f 300 -c /root/.ddns_go_config.yaml  # 注册为服务', '```', '',
        '```yaml', 'server:', '  port: 9876', '  enabled: true', '```', '',
        '```python', 'def greet(name: str) -> str:', '    return f"hello {name}"', '```', '',
        '### 说明', '', '> 引用的一段话。', '', '> [!warning] 注意', '> 公网不要开放管理页面。', '', '> [!tip]', '> 先备份配置。', '',
        '| 项目 | 值 |', '| --- | --- |', '| 版本 | 6.14.1 |', '| 端口 | 9876 |', '',
        '- [x] 安装', '- [ ] 配置 DNS', '- 普通条目', '',
      ].join('\n'),
    };
    await mkdir(client.db, { recursive: true });
    for (const [path, content] of Object.entries(notes)) { await mkdir(join(client.vault, path, '..'), { recursive: true }); await writeFile(join(client.vault, path), content); }
    await exec(process.execPath, [cliPath, 'init-settings', client.settings]);
    await writeFile(client.settings, JSON.stringify({ ...JSON.parse(await readFile(client.settings, 'utf8')),
      couchDB_URI: `${url}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
      isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }));
    const cli = (...args) => exec(process.execPath, [cliPath, client.db, '--settings', client.settings, '--vault', client.vault, ...args], { cwd: root, timeout: 90_000 });
    await cli('mirror', client.vault); await cli('sync');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (process.env.NOTES_DEBUG) { page.on('console', m => console.log('console:', m.type(), m.text().slice(0, 300))); page.on('response', r => console.log('http', r.status(), r.request().method(), r.url().slice(0, 150))); page.on('requestfailed', r => console.log('failed', r.url().slice(0, 150), r.failure()?.errorText)); }
    const unlock = async secret => {
      await page.getByRole('button', { name: '网页库' }).click();
      await page.getByLabel('E2EE 密码短语').fill(secret);
      await page.getByRole('button', { name: '解锁' }).click();
    };

    // Login with the console account, a wrong passphrase, then the right one.
    await page.goto(`${url}/notes/`);
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill(userPassword);
    await page.getByRole('button', { name: '登录' }).click();
    // A sign-in starts at the home page, wherever the address was left.
    await expect(page.locator('.home-vault').first()).toBeVisible();
    assert.equal(new URL(page.url()).pathname, '/');
    await page.getByRole('link', { name: '云笔记', exact: true }).click();
    await unlock('wrong-passphrase');
    await expect(page.getByText('密码短语错误。')).toBeVisible({ timeout: 60_000 });
    // The passphrase is never readable on screen: a password field, or text drawn as dots (out of password managers' reach).
    assert(await page.getByLabel('E2EE 密码短语').evaluate(el => el.type === 'password' || getComputedStyle(el).webkitTextSecurity === 'disc'), 'the passphrase is masked');
    await page.getByLabel('E2EE 密码短语').fill(passphrase);
    await page.getByRole('button', { name: '解锁' }).click();
    await expect(page.locator('.vault-more')).toBeVisible({ timeout: 120_000 });
    // The replica's state is a symbol beside the vault name, with no words under it; the tree folds away and back.
    await expect(page.locator('.sync-mark[data-kind="ok"]')).toHaveAttribute('title', /已同步/);
    await expect(page.locator('.notes aside .status')).toHaveCount(0);
    await page.getByRole('button', { name: '收起目录' }).click();
    await expect(page.locator('.notes .layout')).toHaveClass(/collapsed/);
    assert.equal(await page.evaluate(() => localStorage.getItem('tabularium-notes:tree-collapsed')), '1');
    await page.getByRole('button', { name: '展开目录' }).click();
    await expect(page.locator('.notes .layout')).not.toHaveClass(/collapsed/);
    const devices = await api(`/vaults/${vault.id}/devices`);
    const browserDevice = devices.find(d => d.name.startsWith('网页 · Chrome'));
    assert(browserDevice, 'the browser is registered as a device');
    assert(browserDevice.machineId, 'the browser reports itself as a client');
    assert.match(browserDevice.name, /^网页 · Chrome · \S+$/);
    assert(!/\d{4}-\d{2}-\d{2}/.test(browserDevice.name), 'the name carries no date');

    // Tree, preview, image from the local replica, escaped HTML and in-page links.
    await page.getByRole('button', { name: '笔记', exact: true }).click();
    await page.getByRole('button', { name: '中文', exact: true }).click();
    const article = page.locator('article');
    await expect(article.getByRole('heading', { name: '中文笔记' })).toBeVisible();
    await expect(article).toContainText('<script>window.__xss = 1</script>');
    await expect(article.locator('a.remote-image')).toHaveText('[远程图片：远程]');
    await expect.poll(() => article.locator('img').evaluate(img => img.naturalWidth)).toBe(1);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await article.getByRole('link', { name: '看图' }).click();
    await expect(article).toContainText('图示正文。');
    const shots = resolve('test-runs', `notes-${Date.now()}`); await mkdir(shots, { recursive: true });
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await page.screenshot({ path: join(shots, 'reading.png') });
    await article.getByRole('link', { name: '看图' }).click();

    // Notes read like Obsidian: highlighted code blocks by kind with a copy button, callouts, quotes, tables and task lists.
    await page.getByRole('button', { name: '排版', exact: true }).click();
    await expect(article.getByRole('heading', { name: '排版示例' })).toBeVisible();
    assert.deepEqual(await article.locator('.code-block').evaluateAll(blocks => blocks.map(b => [b.dataset.kind, b.querySelector('.code-lang').textContent])),
      [['terminal', 'Bash'], ['config', 'YAML'], ['code', 'Python']]);
    assert(await article.locator('.code-block[data-kind="terminal"] .hljs-comment').count() > 0, 'shell comments highlighted');
    assert(await article.locator('.code-block[data-kind="config"] .hljs-attr').count() > 0, 'YAML keys highlighted');
    assert(await article.locator('.code-block[data-kind="code"] .hljs-keyword').count() > 0, 'Python keywords highlighted');
    await article.locator('.code-block').first().hover();
    await article.locator('.code-block').first().getByRole('button', { name: '复制' }).click();
    await expect(article.locator('.code-block').first().getByRole('button', { name: '已复制' })).toBeVisible();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'cd /root\nsudo ./ddns-go -s install -l :9876 -f 300 -c /root/.ddns_go_config.yaml  # 注册为服务\n');
    assert.deepEqual(await article.locator('.callout').evaluateAll(items => items.map(c => [c.dataset.callout, c.querySelector('.callout-title').textContent])), [['warning', '注意'], ['tip', 'Tip']]);
    assert.doesNotMatch(await article.textContent(), /\[!warning\]|\[ \]|\[x\]/);
    assert.deepEqual(await article.locator('li.task input').evaluateAll(boxes => boxes.map(b => b.checked)), [true, false]);
    await expect(article.locator('table thead th')).toHaveText(['项目', '值']);
    await page.screenshot({ path: join(shots, 'typography.png'), fullPage: true });
    await page.locator('.main').evaluate(main => main.scrollTo(0, main.scrollHeight));
    await page.screenshot({ path: join(shots, 'typography-end.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(shots, 'typography-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });

    // A change from another device arrives while the page is open.
    await page.getByRole('button', { name: 'readme', exact: true }).click();
    await expect(article).toContainText('第一版');
    await writeFile(join(client.vault, 'readme.md'), '第二版\n');
    await cli('mirror', client.vault); await cli('sync');
    await expect(article).toContainText('第二版', { timeout: 60_000 });

    // The tree follows the vault's Collation.md like the plug-in; a new rule file reorders it live.
    const topLevel = () => page.locator('aside nav > ul > li > .row .name').allTextContents();
    await expect.poll(topLevel).toEqual(['笔记', 'assets', 'readme']);
    // The former note is not read: the tree stays by name and the page says to convert it.
    await writeFile(join(client.vault, 'sortspec.md'), '---\nsorting-spec: |-\n  target-folder: /\n  readme\n  笔记\n---\n');
    await cli('mirror', client.vault); await cli('sync');
    await expect(page.locator('.sort-error')).toContainText('sortspec.md', { timeout: 60_000 });
    await expect.poll(topLevel).toEqual(['笔记', 'assets', 'readme', 'sortspec']);
    await writeFile(join(client.vault, 'Collation.md'), '顺序：\n\n- readme —— 先读这篇\n- 笔记\n');
    await cli('mirror', client.vault); await cli('sync');
    await expect.poll(topLevel, { timeout: 60_000 }).toEqual(['readme', '笔记', 'assets', 'Collation', 'sortspec']);
    await expect(page.locator('.sort-error')).toHaveCount(0);


    // The passphrase is in no browser storage; after a reload it is asked again.
    const stored = await page.evaluate(async () => {
      const records = await new Promise(done => {
        const request = indexedDB.open('tabularium-notes');
        request.onsuccess = () => { const all = request.result.transaction('vaults').objectStore('vaults').getAll(); all.onsuccess = () => done(all.result); };
      });
      return JSON.stringify([Object.entries(localStorage), records]);
    });
    assert(!stored.includes(passphrase), 'passphrase found in browser storage');
    // Make the stored credentials look close to expiry: the next unlock renews them. They are also a credential from
    // before clients, with only a name: the next unlock puts it under this browser's client.
    const older = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'Older browser' });
    await page.evaluate(older => new Promise(done => {
      const request = indexedDB.open('tabularium-notes');
      request.onsuccess = () => {
        const store = request.result.transaction('vaults', 'readwrite').objectStore('vaults');
        const all = store.getAll();
        all.onsuccess = () => { for (const { joined, ...record } of all.result) store.put({ ...record, deviceId: older.id, username: older.username, password: older.password, expiresAt: Date.now() }); store.transaction.oncomplete = done; };
      };
    }), older);
    // Leaving web notes for another module stops its synchronisation; coming back in the same page opens the vault again
    // without asking, since the page keeps the passphrase in memory (never in storage, as checked above).
    await page.getByRole('link', { name: '首页', exact: true }).click();
    await expect(page.locator('.home-vault').first()).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await (await fetch('/api/v1/admin/overview')).json()).activeProxyConnections)).toBe(0);
    await page.getByRole('link', { name: '云笔记', exact: true }).click();
    await expect(page.locator('.vault-more')).toBeVisible({ timeout: 60_000 });
    assert.equal(await page.getByLabel('E2EE 密码短语').count(), 0);
    // In a new page a link from a Tabularius citation or the home page goes straight to the vault's unlock form, then
    // opens the note.
    await page.goto('about:blank');
    await page.goto(`${url}/notes/?vault=${vault.id}&path=${encodeURIComponent('笔记/中文.md')}`);
    await page.getByLabel('E2EE 密码短语').fill(passphrase);
    await page.getByRole('button', { name: '解锁' }).click();
    await expect(page.locator('.vault-more')).toBeVisible({ timeout: 60_000 });
    await expect(article.getByRole('heading', { name: '中文笔记' })).toBeVisible();
    assert.equal(new URL(page.url()).search, '');
    const renewed = await page.evaluate(() => new Promise(done => {
      const request = indexedDB.open('tabularium-notes');
      request.onsuccess = () => { const all = request.result.transaction('vaults').objectStore('vaults').getAll(); all.onsuccess = () => done(all.result[0].expiresAt); };
    }));
    assert(renewed > Date.now() + 29 * 86_400_000, 'browser device renewed on unlock');
    const afterUnlock = await api(`/vaults/${vault.id}/devices`);
    assert.equal(afterUnlock.find(d => d.id === older.id).expiresAt, renewed);
    assert.equal(afterUnlock.find(d => d.id === older.id).machineId, browserDevice.machineId, 'the older credential joined the client');
    assert(!afterUnlock.some(d => d.id === browserDevice.id), 'and replaced the one this installation had');

    // A rebuilt vault stays locked: the page explains it and opens again once the owner unlocks it in account settings.
    await page.locator('.vault-more').click();
    await page.getByRole('menuitem', { name: '锁定' }).click();
    const milestone = `${url}/sync/${vault.id}/_local/obsydian_livesync_milestone`;
    const deviceAuth = { authorization: `Basic ${Buffer.from(`${device.username}:${device.password}`).toString('base64')}`, 'content-type': 'application/json' };
    const current = await (await fetch(milestone, { headers: deviceAuth })).json();
    assert((await fetch(milestone, { method: 'PUT', headers: deviceAuth, body: JSON.stringify({ ...current, locked: true }) })).ok);
    await page.getByLabel('E2EE 密码短语').fill(passphrase);
    await page.getByRole('button', { name: '解锁' }).click();
    await expect(page.getByText('请所有者在账户设置的笔记库页面解除锁定')).toBeVisible({ timeout: 60_000 });
    await api(`/vaults/${vault.id}/rebuild/lock`, 'DELETE');
    await page.getByRole('button', { name: '解锁' }).click();
    await expect(page.locator('.vault-more')).toBeVisible({ timeout: 60_000 });

    // Multiple selection sends one book per item.
    const notesFolder = page.getByRole('button', { name: '笔记', exact: true });
    if (await notesFolder.getAttribute('aria-expanded') !== 'true') await notesFolder.click();
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await page.getByRole('button', { name: '子', exact: true }).click();
    await page.locator('.row', { has: page.getByRole('button', { name: '中文', exact: true }) }).getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '多选…' }).click();
    await page.getByLabel('选择 子').check();
    await page.getByRole('button', { name: '推送 2 项至 Kindle' }).click();
    await expect(page.getByText('已推送至 Kindle：《中文》、《子》')).toBeVisible({ timeout: 60_000 });
    assert.deepEqual(sink.messages.map(message => parseMessage(message.raw).fileName), ['中文.epub', '子.epub']);
    for (const [index, message] of sink.messages.entries()) {
      const file = join(temp, `${index}.epub`);
      await writeFile(file, parseMessage(message.raw).data);
      assert.equal(await epubErrors(file), 0);
    }
    assert(parseMessage(sink.messages[0].raw).data.includes(png), 'image packed into the web-built book');

    // The delivery history can be cleared; what was sent today still counts towards the daily limit.
    const usedToday = (await api('/me/kindle')).sentToday;
    assert(usedToday > 0 && (await api('/me/kindle/deliveries')).length > 0);
    await api('/me/kindle/deliveries', 'DELETE');
    assert.deepEqual(await api('/me/kindle/deliveries'), []);
    assert.equal((await api('/me/kindle')).sentToday, usedToday);

    // Clearing removes the local replica and revokes the browser's device.
    await page.locator('.vault-more').click();
    await page.getByRole('menuitem', { name: '清除本地数据' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '清除本地数据', exact: true }).click();
    await expect(page.getByText('本地数据已清除，设备已撤销。')).toBeVisible({ timeout: 30_000 });
    const left = await page.evaluate(async id => {
      const names = (await indexedDB.databases()).map(d => d.name).filter(name => name.includes(id));
      const users = await (await navigator.storage.getDirectory()).getDirectoryHandle('tabularium');
      const vaults = [];
      for await (const [, user] of users.entries()) for await (const [name] of user.entries()) vaults.push(name);
      return { names, vaults, local: Object.keys(localStorage).filter(key => key.includes(id)) };
    }, vault.id);
    assert.deepEqual(left, { names: [], vaults: [], local: [] });
    assert(!(await api(`/vaults/${vault.id}/devices`)).some(d => d.id === older.id));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await gateway?.close();
    await sink?.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
