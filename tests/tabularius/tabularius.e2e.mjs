// Tabularius against a real CouchDB, gateway, CLI devices and Chromium, with scripted stand-ins for the providers:
// enabling, the hosted client, search, streamed answers with citations, outbound filtering, restart, both providers, disabling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../../apps/server/dist/server.js';
import { anthropic, embedder, openai } from '../../apps/server/dist/tabularius/providers.js';
import { startMockProviders } from './mock-providers.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const cliPath = join(root, 'apps/obsidian/src/apps/cli/dist/index.cjs');
const until = async (what, check, ms = 90_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('Tabularius', { timeout: 900_000 }, async () => {
  const runId = `tabularius-${Date.now()}`;
  const temp = await mkdtemp(join(tmpdir(), 'tabularius-'));
  const password = randomBytes(24).toString('hex');
  const passphrase = randomBytes(16).toString('hex');
  const compose = (...args) => exec('docker', ['compose', '-f', join(root, 'deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  const mock = await startMockProviders();
  process.env.ANTHROPIC_BASE_URL = mock.url; process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`; process.env.OPENAI_API_KEY = 'test-openai';
  const database = join(temp, 'app.sqlite');
  const key = randomBytes(32);
  let gateway, browser, couchUrl;
  const syncPassword = randomBytes(24).toString('hex');
  const start = async provider => {
    gateway = await createGateway({ database, bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
      couch: { url: couchUrl, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword },
      tabularius: { key, root: join(temp, 'tabularius'), cli: cliPath, provider, embedder: embedder('test-embed', `${mock.url}/v1`, 'test-embed-key') } });
    return gateway.listen();
  };
  try {
    await compose('up', '-d', '--wait');
    couchUrl = `http://${(await compose('port', 'couchdb', '5984')).stdout.trim()}`;
    let url = await start(anthropic('claude-opus-5-5'));
    let token;
    const call = async (path, method = 'GET', body, as = token) => fetch(`${url}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}) } });
    const api = async (path, method, body, as) => {
      const response = await call(path, method, body, as);
      assert(response.ok, `${method ?? 'GET'} ${path}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    };
    token = (await api('/sessions', 'POST', { username: 'admin', password })).token;
    const userPassword = randomBytes(12).toString('hex');
    await api('/me/password', 'PUT', { currentPassword: password, password: userPassword });
    token = (await api('/sessions', 'POST', { username: 'admin', password: userPassword })).token;
    const vault = await api('/vaults', 'POST', { name: '紫藤库' });

    // Notes written by a CLI device, as from Obsidian.
    const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'cli' });
    const client = { db: join(temp, 'db'), vault: join(temp, 'vault'), settings: join(temp, 'settings.json') };
    await mkdir(client.db, { recursive: true });
    await mkdir(join(client.vault, '运维'), { recursive: true });
    await mkdir(join(client.vault, '私密'), { recursive: true });
    const note = '# 紫藤服务器\n\n紫藤服务器的管理端口是 8443。\n\npassword: hunter2\n\n部署密钥 sk-abcdefghijklmnopqrstuvwx，内部编号 ZETA-42。\n';
    await writeFile(join(client.vault, '运维/紫藤服务器.md'), note);
    await writeFile(join(client.vault, '私密/日记.md'), '紫藤服务器 私密日记 secretdiary\n');
    await writeFile(join(client.vault, 'Tabularius.md'), '本库的规范：回答用中文。\n');
    await exec(process.execPath, [cliPath, 'init-settings', client.settings]);
    await writeFile(client.settings, JSON.stringify({ ...JSON.parse(await readFile(client.settings, 'utf8')),
      couchDB_URI: `${url}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
      isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }));
    const cli = (...args) => exec(process.execPath, [cliPath, client.db, '--settings', client.settings, '--vault', client.vault, ...args], { cwd: root, timeout: 90_000 });
    await cli('mirror', client.vault); await cli('sync');

    // Enabling: a wrong passphrase stores nothing; the right one starts the hosted client.
    let response = await call(`/tabularius/vaults/${vault.id}`, 'POST', { passphrase: 'wrong-passphrase', confirm: true });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Wrong passphrase');
    assert.equal((await call(`/tabularius/vaults/${vault.id}`, 'POST', { passphrase })).status, 400, 'confirmation is required');
    const db = new DatabaseSync(database, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM tabularius_vaults').get().n, 0);
    // The private folder is excluded from the start, so its notes are never indexed or embedded.
    await api(`/tabularius/vaults/${vault.id}`, 'POST', { passphrase, confirm: true, excluded: '私密', masks: 'ZETA-\\d+' });
    assert((await api(`/vaults/${vault.id}/devices`)).some(d => d.name === 'Tabularius' && !d.revoked));
    const status = async () => (await api('/tabularius')).vaults.find(v => v.id === vault.id);
    await until('the hosted client to fetch and index the vault', async () => { const s = await status(); return s.replicated && s.notes === 2 && s; });
    assert.equal(db.prepare('SELECT passphrase FROM tabularius_vaults').get().passphrase.includes(Buffer.from(passphrase)), false, 'the passphrase is stored encrypted');

    // Chat in the browser: a streamed answer citing the note, with a link to web notes.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${url}/tabularius/?vault=${vault.id}`);
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill(userPassword);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByText('已同步')).toBeVisible({ timeout: 30_000 });
    await page.getByPlaceholder('询问你的笔记').fill('紫藤服务器');
    await page.getByRole('button', { name: '发送' }).click();
    const answer = page.locator('.turn.assistant').last();
    await expect(answer.locator('.answer')).toContainText('根据', { timeout: 60_000 });
    await expect(answer.locator('.tools')).toContainText('检索：紫藤服务器');
    await expect(answer.locator('.tools')).toContainText('读取：运维/紫藤服务器.md');
    const href = `/notes/#${vault.id}/${encodeURIComponent('运维')}/${encodeURIComponent('紫藤服务器.md')}`;
    await expect(answer.locator('.answer a.cite')).toHaveAttribute('href', href);
    await expect(page.locator('.conversation')).toHaveCount(1);
    // A second question in the same conversation.
    await page.getByPlaceholder('询问你的笔记').fill('管理端口');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.locator('.turn.assistant')).toHaveCount(2);
    await expect(page.locator('.turn.assistant').last().locator('.answer')).toContainText('根据', { timeout: 60_000 });
    await expect(page.locator('.conversation')).toHaveCount(1);

    // What reached the provider: no excluded note, no credentials, the vault's rules, and thinking replayed unchanged.
    const sent = [...mock.requests.anthropic.map(r => r.raw), ...mock.requests.embeddings.map(r => r.raw)].join('\n');
    for (const secret of ['secretdiary', '私密日记', 'hunter2', 'sk-abcdefghijklmnop', 'ZETA-42']) assert(!sent.includes(secret), `${secret} reached a provider`);
    assert(mock.requests.anthropic.some(r => r.raw.includes('[REDACTED]')));
    const first = mock.requests.anthropic[0];
    assert.match(JSON.stringify(first.body.system), /本库的规范/);
    assert.equal(first.body.fallbacks, 'default');
    assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    const last = mock.requests.anthropic.at(-1).body;
    assert.equal(last.messages[1].content[0].signature, 'sig-1', 'the first thinking block is replayed');
    assert.deepEqual(mock.requests.anthropic.map(r => JSON.stringify(r.body.system)), mock.requests.anthropic.map(() => JSON.stringify(first.body.system)), 'the system prompt stays the same');

    // Isolation: another user cannot see the conversation.
    const conversation = (await api(`/tabularius/vaults/${vault.id}/conversations`))[0];
    const other = await api('/users', 'POST', { username: 'other', password: 'other-initial-password' });
    let otherToken = (await api('/sessions', 'POST', { username: 'other', password: 'other-initial-password' }, null)).token;
    await api('/me/password', 'PUT', { currentPassword: 'other-initial-password', password: 'other-second-password' }, otherToken);
    otherToken = (await api('/sessions', 'POST', { username: 'other', password: 'other-second-password' }, null)).token;
    assert.equal((await call(`/tabularius/conversations/${conversation.id}`, 'GET', undefined, otherToken)).status, 404);
    assert.equal((await call(`/tabularius/vaults/${vault.id}/conversations`, 'GET', undefined, otherToken)).status, 404);
    assert(other.id);

    // Rules changed later: a newly excluded note leaves the index at once; an invalid pattern is refused.
    await api(`/tabularius/vaults/${vault.id}/rules`, 'PUT', { excluded: '私密\nTabularius.md', masks: 'ZETA-\\d+' });
    assert.equal((await status()).notes, 1);
    assert.equal((await call(`/tabularius/vaults/${vault.id}/rules`, 'PUT', { excluded: '', masks: '(' })).status, 400);

    // A change from another device reaches the index.
    await writeFile(join(client.vault, '运维/紫藤服务器.md'), `${note}\n银杏节点也在这台机器上。\n`);
    await cli('mirror', client.vault); await cli('sync');
    await until('the edit to be indexed', () => db.prepare("SELECT count(*) AS n FROM tabularius_chunks WHERE text LIKE '%银杏节点%'").get().n > 0);

    // Restart with the other provider: the client resumes without the passphrase and the conversation continues.
    await page.close();
    await gateway.close();
    url = await start(openai('gpt-test'));
    await until('the hosted client to resume', async () => (await status()).replicated);
    const stream = await (await call(`/tabularius/conversations/${conversation.id}/messages`, 'POST', { message: '银杏节点' })).text();
    assert.match(stream, /event: tool\ndata: {"name":"search_notes"/);
    assert.match(stream, /event: done\ndata: {"read":\["运维\/紫藤服务器.md"\]}/);
    const openaiSent = mock.requests.openai.map(r => r.raw).join('\n');
    assert(openaiSent.includes('银杏节点') && !openaiSent.includes('hunter2') && !openaiSent.includes('secretdiary'));
    assert.equal(mock.requests.openai[0].body.messages[0].role, 'system');
    const transcript = await api(`/tabularius/conversations/${conversation.id}`);
    assert.deepEqual(transcript.messages.filter(m => m.role === 'user').map(m => m.text), ['紫藤服务器', '管理端口', '银杏节点']);

    // Disabling removes everything the server held for this vault.
    await api(`/tabularius/vaults/${vault.id}`, 'DELETE');
    for (const table of ['tabularius_vaults', 'tabularius_files', 'tabularius_chunks', 'tabularius_conversations', 'tabularius_messages']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    }
    await assert.rejects(access(join(temp, 'tabularius', vault.id)));
    assert((await api(`/vaults/${vault.id}/devices`)).find(d => d.name === 'Tabularius').revoked);
    db.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await gateway?.close();
    await mock.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
