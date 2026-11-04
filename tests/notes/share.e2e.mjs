// Sharing notes from web notes, opened by an anonymous browser: encrypted links with the key in the fragment, the
// owner's decision on each reference ("no access" without names), automatic updates and new references, passwords,
// a public page, withdrawal, and the share lists in account settings and administration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../../apps/server/dist/server.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const cliPath = join(root, 'apps/server/clients/cli/dist/index.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('sharing notes and folders from web notes', { timeout: 600_000 }, async () => {
  const runId = `share-${Date.now()}`;
  const temp = await mkdtemp(join(tmpdir(), 'tabularium-share-'));
  const password = randomBytes(24).toString('hex');
  const passphrase = randomBytes(16).toString('hex');
  const compose = (...args) => exec('docker', ['compose', '-f', join(root, 'deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  let gateway, browser;
  try {
    await compose('up', '-d', '--wait');
    const port = (await compose('port', 'couchdb', '5984')).stdout.trim();
    const database = join(temp, 'app.sqlite');
    gateway = await createGateway({ database, bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
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
    const vault = await api('/vaults', 'POST', { name: '分享库' });
    const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'cli' });
    const client = { db: join(temp, 'db'), vault: join(temp, 'vault'), settings: join(temp, 'settings.json') };
    const notes = {
      '笔记/计划.md': '# 计划\n\n见 [[私密日记|日记]]，预算在 [[预算]]。\n\n![[图.png]]\n\n```mermaid\nflowchart LR\n  甲 --> 乙\n```\n',
      '笔记/预算.md': '预算正文。\n',
      '笔记/图.png': png,
      '私密日记.md': '非常私密的内容。\n',
      '另一篇.md': '另一篇的正文。\n',
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
    const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })).newPage();
    const visitor = await (await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' })).newPage();
    const errors = [];
    owner.on('pageerror', error => errors.push(error.message)); visitor.on('pageerror', error => errors.push(error.message));
    await owner.goto(`${url}/notes/`);
    await owner.getByLabel('用户名').fill('admin');
    await owner.getByLabel('密码').fill(userPassword);
    await owner.getByRole('button', { name: '登录' }).click();
    await owner.getByRole('link', { name: '云笔记', exact: true }).click();
    await owner.getByRole('button', { name: '分享库' }).click();
    await owner.getByLabel('E2EE 密码短语').fill(passphrase);
    await owner.getByRole('button', { name: '解锁' }).click();
    await expect(owner.locator('.vault-more')).toBeVisible({ timeout: 120_000 });
    await owner.getByRole('button', { name: '笔记', exact: true }).click();
    const menu = async name => {
      const row = owner.locator('.row', { has: owner.getByRole('button', { name, exact: true }) });
      await row.hover();
      await row.getByRole('button', { name: '更多操作' }).click();
      await owner.getByRole('menuitem', { name: '分享…' }).click();
      return owner.locator('dialog.share-dialog');
    };
    const reference = (dialog, path) => dialog.locator('label.reference', { hasText: path }).getByRole('checkbox');

    // Share one note: the embedded image is shared by default, linked notes are not; the owner adds the budget note.
    let dialog = await menu('计划');
    await expect(dialog.getByRole('heading', { name: '分享「计划」' })).toBeVisible();
    await expect(reference(dialog, '私密日记.md')).not.toBeChecked();
    await expect(reference(dialog, '笔记/预算.md')).not.toBeChecked();
    await expect(reference(dialog, '笔记/图.png')).toBeChecked();
    await reference(dialog, '笔记/预算.md').check();
    await dialog.locator('.address input').fill('plan');
    await dialog.getByRole('button', { name: '创建链接' }).click();
    const linkField = dialog.locator('#share-link');
    await expect(linkField).toHaveValue(new RegExp(`/s/plan#[A-Za-z0-9_-]{43}$`), { timeout: 60_000 });
    const planLink = await linkField.inputValue();
    await owner.screenshot({ path: resolve('test-runs', `${runId}-dialog.png`) }).catch(() => {});
    await dialog.getByRole('button', { name: '关闭' }).click();

    // The visitor sees the note, its image and the shared budget; the diary appears only as "no access".
    await visitor.goto(planLink);
    const article = visitor.locator('article');
    await expect(visitor.getByRole('heading', { name: '计划' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => article.locator('img').evaluate(img => img.naturalWidth)).toBe(1);
    await expect(article.locator('.no-access')).toHaveCount(1);
    await expect(article.locator('.no-access')).toContainText('无访问权限');
    // Diagrams are drawn as in web notes, styles and all.
    await expect(article.locator('.mermaid-diagram.drawn svg')).toHaveCount(1, { timeout: 30_000 });
    assert(await article.locator('.mermaid-diagram.drawn svg style').count(), 'the diagram keeps its own style');
    assert.doesNotMatch(await visitor.content(), /私密|日记/);
    await mkdir(resolve('test-runs'), { recursive: true });
    await visitor.screenshot({ path: resolve('test-runs', `${runId}-viewer.png`) });
    await article.getByRole('link', { name: '预算' }).click();
    await expect(visitor.getByRole('heading', { name: '预算' })).toBeVisible();
    await expect(article).toContainText('预算正文。');
    // Without the fragment the page cannot decrypt anything.
    await visitor.goto(planLink.replace(/#.*$/, ''));
    await expect(visitor.getByText('链接不完整')).toBeVisible();
    // The server holds ciphertext only.
    const stored = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try { return db.prepare("SELECT f.data FROM share_files f JOIN shares s ON s.id=f.share_id WHERE s.slug='plan'").all().map(row => Buffer.from(row.data).toString('utf8')).join('\n'); }
      finally { db.close(); }
    };
    assert.doesNotMatch(stored(), /计划|预算|图\.png/);

    // Editing the note updates the share after a quiet period; a reference added later stays unshared and is reported.
    await owner.getByRole('button', { name: '计划', exact: true }).click();
    await owner.getByRole('button', { name: '编辑' }).click();
    await owner.locator('.editor .cm-content').first().click();
    await owner.keyboard.press('ControlOrMeta+End');
    await owner.keyboard.insertText('\n新加的一行，见 [[另一篇]]。\n');
    await owner.getByRole('button', { name: '完成' }).click();
    await expect.poll(async () => {
      await visitor.goto(planLink); await visitor.reload();
      return (await article.textContent({ timeout: 10_000 }).catch(() => '')) ?? '';
    }, { timeout: 60_000, intervals: [3000] }).toContain('新加的一行');
    await expect(article.locator('.no-access')).toHaveCount(2);
    assert.doesNotMatch(await visitor.content(), /另一篇/);
    dialog = await menu('计划');
    await expect(dialog.getByText('自动更新时发现 1 个新的引用')).toBeVisible();
    await expect(reference(dialog, '另一篇.md')).not.toBeChecked();
    await expect(dialog.locator('label.reference', { hasText: '另一篇.md' }).locator('.new')).toBeVisible();
    await dialog.getByRole('button', { name: '关闭' }).click();

    // A folder with a password: the visitor is asked for it, and a wrong one is refused.
    dialog = await menu('笔记');
    await dialog.getByLabel('访问密码', { exact: true }).fill('pass-123');
    await dialog.getByRole('button', { name: '创建链接' }).click();
    await expect(linkField).toHaveValue(/#/, { timeout: 60_000 });
    const folderLink = await linkField.inputValue();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await visitor.goto(folderLink);
    await expect(visitor.getByRole('heading', { name: '这个分享需要密码' })).toBeVisible();
    await visitor.getByLabel('密码').fill('wrong');
    await visitor.getByRole('button', { name: '打开' }).click();
    await expect(visitor.getByText('密码错误。')).toBeVisible();
    await visitor.getByLabel('密码').fill('pass-123');
    await visitor.getByRole('button', { name: '打开' }).click();
    await expect(visitor.locator('aside .share-title')).toHaveText('笔记');
    await expect(visitor.locator('nav .row .name')).toHaveText(['计划', '图.png', '预算']);
    await visitor.getByRole('button', { name: '预算', exact: true }).click();
    await expect(article).toContainText('预算正文。');

    // A public page: plain text on the server, indexable when the owner allows it.
    dialog = await menu('另一篇');
    await dialog.getByText('公开网页', { exact: true }).click();
    await dialog.getByLabel('允许搜索引擎收录').check();
    await dialog.locator('.address input').fill('public-note');
    await dialog.getByRole('button', { name: '创建链接' }).click();
    await expect(linkField).toHaveValue(/\/s\/public-note$/, { timeout: 60_000 });
    await dialog.getByRole('button', { name: '关闭' }).click();
    const response = await fetch(`${url}/s/public-note`);
    assert.equal(response.headers.get('x-robots-tag'), null); await response.arrayBuffer();
    await visitor.goto(`${url}/s/public-note`);
    await expect(article).toContainText('另一篇的正文。');

    // Withdrawing the first share: the link stops working at once.
    dialog = await menu('计划');
    await dialog.getByRole('button', { name: '撤回分享' }).click();
    await owner.locator('dialog.dialog:not(.share-dialog)').getByRole('button', { name: '撤回分享' }).click();
    await expect(dialog).toHaveCount(0);
    await visitor.goto(planLink);
    await expect(visitor.getByText('这个分享已失效')).toBeVisible();

    // Account settings list the user's shares; administration lists everyone's.
    await owner.goto(`${url}/account/shares`);
    await expect(owner.locator('tr[data-share]')).toHaveCount(3);
    await expect(owner.locator('tr[data-share]', { hasText: '/s/plan' })).toContainText('已撤回');
    await owner.locator('tr[data-share]', { hasText: '/s/public-note' }).locator('[data-expiry]').selectOption('7');
    await expect(owner.getByText('已修改有效期。')).toBeVisible();
    await owner.goto(`${url}/admin/shares`);
    await expect(owner.locator('tr[data-share]')).toHaveCount(3);
    await owner.locator('tr[data-share]', { hasText: '/s/public-note' }).getByRole('button', { name: '撤回分享' }).click();
    await owner.locator('dialog.dialog').getByRole('button', { name: '撤回分享' }).click();
    await expect(owner.getByText('已撤回分享。')).toBeVisible();
    assert.equal((await fetch(`${url}/api/v1/public/shares/public-note`)).status, 410);
    // Withdrawn and expired shares can be cleared: they leave the list, and their addresses stop answering.
    await owner.getByRole('button', { name: '清理失效分享' }).click();
    await owner.locator('dialog.dialog').getByRole('button', { name: '清理失效分享' }).click();
    await expect(owner.locator('tr[data-share]', { hasText: '/s/public-note' })).toHaveCount(0);
    assert.equal((await fetch(`${url}/api/v1/public/shares/public-note`)).status, 404);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await gateway?.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
