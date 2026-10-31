// Editing on the web notes page in real Chromium against a real CouchDB and gateway, checked through a CLI client:
// edit, conflict from concurrent edits and its resolution, new/rename/delete, attachments, and offline use.
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
const cliPath = join(root, 'apps/obsidian/src/apps/cli/dist/index.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('editing on the web notes page', { timeout: 900_000 }, async () => {
  const runId = `notes-edit-${Date.now()}`;
  const temp = await mkdtemp(join(tmpdir(), 'tabularium-notes-edit-'));
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
    const vault = await api('/vaults', 'POST', { name: '编辑库' });

    // A CLI device: writes the starting notes and later checks what the page uploaded.
    const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'cli' });
    const client = { db: join(temp, 'db'), vault: join(temp, 'vault'), settings: join(temp, 'settings.json') };
    await mkdir(client.db, { recursive: true });
    await mkdir(join(client.vault, '笔记'), { recursive: true });
    await writeFile(join(client.vault, '笔记/甲.md'), '甲第一版\n');
    await writeFile(join(client.vault, 'readme.md'), 'readme\n');
    await exec(process.execPath, [cliPath, 'init-settings', client.settings]);
    await writeFile(client.settings, JSON.stringify({ ...JSON.parse(await readFile(client.settings, 'utf8')),
      couchDB_URI: `${url}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
      isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }));
    const cli = (...args) => exec(process.execPath, [cliPath, client.db, '--settings', client.settings, '--vault', client.vault, ...args], { cwd: root, timeout: 90_000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    const push = async (path, content) => { await writeFile(join(client.vault, path), content); await cli('mirror', client.vault); await cli('sync'); };
    /** Pulls until the CLI's copy of `path` satisfies `check`. */
    const remote = async (path, check) => {
      const end = Date.now() + 60_000;
      let last;
      while (Date.now() < end) {
        await cli('sync');
        last = await cli('cat', path).then(r => r.stdout, () => undefined);
        if (check(last)) return last;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error(`${path} on the CLI: ${last}`);
    };
    const text = buffer => buffer?.toString('utf8');
    await cli('mirror', client.vault); await cli('sync');

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // The application's own dialogs: type into the text dialog, or confirm with the named action.
    const answer = async value => { const dialog = page.getByRole('dialog'); await dialog.getByRole('textbox').fill(value); await dialog.locator('button[type=submit]').click(); };
    const confirmAction = name => page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    const unlock = async () => {
      await page.getByRole('button', { name: '编辑库' }).click();
      await page.getByLabel('E2EE 密码短语').fill(passphrase);
      await page.getByRole('button', { name: '解锁' }).click();
      await expect(page.locator('.vault-more')).toBeVisible({ timeout: 120_000 });
    };
    const state = page.locator('.save-state');
    const editor = page.locator('.editor .cm-content').first();
    const type = async content => { await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(content); };

    await page.goto(`${url}/notes/`);
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill(userPassword);
    await page.getByRole('button', { name: '登录' }).click();
    await unlock();
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Edit and save: reaches the other device.
    await page.getByRole('button', { name: '笔记', exact: true }).click();
    await page.getByRole('button', { name: '甲', exact: true }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    await type('网页上的修改\n');
    await expect(state).toHaveText('已同步', { timeout: 30_000 });
    assert.match(text(await remote('笔记/甲.md', c => text(c)?.includes('网页上的修改'))), /甲第一版\n网页上的修改/);

    // Concurrent edits on different lines: merged automatically, no conflict is left on either side.
    await context.setOffline(true);
    await type('离线时网页的修改\n');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(state).toHaveText('待上传', { timeout: 15_000 });
    await push('笔记/甲.md', `CLI 加在开头\n${text((await cli('cat', '笔记/甲.md')).stdout)}`);
    await context.setOffline(false);
    const both = c => text(c)?.startsWith('CLI 加在开头\n') && text(c)?.includes('离线时网页的修改');
    await remote('笔记/甲.md', both);
    await expect(editor).toContainText('CLI 加在开头', { timeout: 60_000 });
    await expect(page.locator('.conflict-mark')).toHaveCount(0);
    await expect(page.locator('.conflict')).toHaveCount(0);

    // Concurrent edits of the same line: a conflict, settled in the merge editor.
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByRole('button', { name: 'readme', exact: true }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    await context.setOffline(true);
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('网页版本的同一行\n');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(state).toHaveText('待上传', { timeout: 15_000 });
    await push('readme.md', 'CLI 版本的同一行\n');
    await context.setOffline(false);
    await expect(page.locator('.conflict')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.conflict-mark')).toHaveCount(1);
    await expect(page.locator('.version')).toHaveCount(2);
    const merged = page.locator('.conflict .cm-content');
    await merged.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('合并后的内容\n');
    await page.getByRole('button', { name: '保存合并内容' }).click();
    await expect(page.getByText('冲突已解决。')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.conflict-mark')).toHaveCount(0);
    assert.equal(text(await remote('readme.md', c => text(c) === '合并后的内容\n')), '合并后的内容\n');
    const info = text((await cli('info', 'readme.md')).stdout);
    assert.match(info, /"conflicts": "N\/A"/, `the CLI still sees a conflict: ${info}`);

    // New note, rename, delete.
    await page.getByRole('button', { name: '新建笔记' }).click();
    await answer('新建/乙');
    await expect(page.locator('.editor')).toBeVisible();
    await type('新笔记正文\n');
    await expect(state).toHaveText('已同步', { timeout: 30_000 });
    await remote('新建/乙.md', c => text(c) === '新笔记正文\n');
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.locator('.row', { has: page.getByRole('button', { name: '乙', exact: true }) }).getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '重命名或移动…' }).click();
    await answer('新建/丙.md');
    await expect(page.getByRole('button', { name: '丙', exact: true })).toBeVisible({ timeout: 30_000 });
    await remote('新建/丙.md', c => text(c) === '新笔记正文\n');
    await remote('新建/乙.md', c => c === undefined || c.length === 0);
    await page.locator('.row', { has: page.getByRole('button', { name: '丙', exact: true }) }).getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '删除' }).click();
    await confirmAction('删除');
    await expect(page.getByRole('button', { name: '丙', exact: true })).toHaveCount(0, { timeout: 30_000 });
    await remote('新建/丙.md', c => c === undefined || c.length === 0);

    // Attachment: stored next to the note, linked at the cursor, received byte for byte.
    await page.getByRole('button', { name: '甲', exact: true }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    const picture = join(temp, '图.png');
    await writeFile(picture, png);
    await page.locator('input[type=file]').setInputFiles(picture);
    await expect(editor).toContainText('![[图.png]]');
    await expect(state).toHaveText('已同步', { timeout: 30_000 });
    assert.deepEqual(await remote('笔记/图.png', c => c?.length === png.length), png);
    await page.getByRole('button', { name: '完成' }).click();
    await expect(page.locator('article img')).toHaveCount(1);

    // Offline: the page loads from the service worker cache, unlocks from the local copy and uploads later.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText('下列笔记库曾在本浏览器中打开过，可以离线使用。')).toBeVisible({ timeout: 30_000 });
    await unlock();
    await expect(page.locator('.status')).toHaveText('离线：修改将在联网后上传');
    await page.getByRole('button', { name: 'readme', exact: true }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    await type('离线编辑\n');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(state).toHaveText('待上传', { timeout: 15_000 });
    await context.setOffline(false);
    await expect(state).toHaveText('已同步', { timeout: 60_000 });
    await remote('readme.md', c => text(c) === '合并后的内容\n离线编辑\n');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await gateway?.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});

