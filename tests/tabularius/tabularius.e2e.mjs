// Tabularius against a real CouchDB, gateway, CLI devices and Chromium, with scripted stand-ins for the providers:
// enabling, the hosted client, search, streamed answers with citations, outbound filtering, restart, both providers, disabling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../../apps/server/dist/server.js';
import { anthropic, embedder, openai } from '../../apps/server/dist/tabularius/providers.js';
import { ragflow } from '../../apps/server/dist/tabularius/knowledge.js';
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
  const start = async (provider, embeddingModel = 'test-embed') => {
    gateway = await createGateway({ database, bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
      couch: { url: couchUrl, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword },
      tabularius: { key, root: join(temp, 'tabularius'), cli: cliPath, provider,
        embedder: embedder(embeddingModel, `${mock.url}/v1`, 'test-embed-key', 4), knowledge: ragflow(`${mock.url}/mcp`, ['ds-ops', 'ds-notes']) } });
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

    // Proposals: checked before they are saved, reviewed as a diff in the browser, applied to the vault and synced to devices.
    await writeFile(join(client.vault, '运维/索引.md'), '# 索引\n\n- [紫藤服务器](紫藤服务器.md)\n- [[紫藤服务器]]\n');
    await cli('mirror', client.vault); await cli('sync');
    const hosted = join(temp, 'tabularius', vault.id, 'vault');
    await until('the index note to reach the hosted copy', () => access(join(hosted, '运维/索引.md')).then(() => true, () => false));
    // From here the other device runs as a live daemon, like Obsidian: it applies remote moves and deletions and pushes local edits.
    await writeFile(client.settings, JSON.stringify({ ...JSON.parse(await readFile(client.settings, 'utf8')), liveSync: true }));
    const daemon = spawn(process.execPath, [cliPath, client.db, '--settings', client.settings, '--vault', client.vault, 'daemon'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let daemonLog = '';
    daemon.stdout.on('data', chunk => { daemonLog += chunk; }); daemon.stderr.on('data', chunk => { daemonLog += chunk; });
    const exists = path => access(path).then(() => true, () => false);
    let appliedAt;
    try {
    await until('the device daemon to start', () => daemonLog.includes('Initial replication complete'));
    const propose = async input => {
      await page.getByPlaceholder('询问你的笔记').fill(`PROPOSE ${JSON.stringify(input)}`);
      await page.getByRole('button', { name: '发送' }).click();
      await expect(page.locator('#ask button')).toBeEnabled({ timeout: 60_000 });
      return page.locator('.turn.assistant').last();
    };
    let turn = await propose({ title: '无效', summary: '', changes: [{ op: 'edit', path: '运维/紫藤服务器.md', edits: [{ old: '不存在的文字', new: 'x' }] }] });
    await expect(turn.locator('.tools')).toContainText('提案未通过校验');
    await expect(turn.locator('.answer')).toContainText('old text not found');
    turn = await propose({ title: '紫藤归档', summary: '把紫藤服务器移到服务器文件夹并改名。', changes: [
      { op: 'move', from: '运维/紫藤服务器.md', to: '运维/服务器/紫藤.md' },
      { op: 'edit', path: '运维/索引.md', edits: [{ old: '# 索引', new: '# 运维索引' }] },
    ] });
    await expect(turn.locator('.tools .badge')).toHaveText('待审阅');
    await turn.locator('.proposal-link').click();
    await expect(page.locator('.proposal .file')).toHaveCount(2);
    await expect(page.locator('.proposal')).toContainText('运维/紫藤服务器.md → 运维/服务器/紫藤.md');
    await expect(page.locator('.diff .add')).toContainText(['+# 运维索引', '+- [紫藤服务器](服务器/紫藤.md)', '+- [[紫藤]]']);
    await expect(page.getByText('请不要在其他设备上编辑这些笔记')).toBeVisible();
    appliedAt = Date.now();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.getByText('已应用，改动正在同步到各设备。')).toBeVisible();
    assert.equal(db.prepare("SELECT action FROM audit_events WHERE action LIKE 'tabularius.apply'").all().length, 1);

    // The other device receives the moved note with its credentials intact, without conflicts or old modification times.
    const moved = join(client.vault, '运维/服务器/紫藤.md');
    await until('the applied proposal to reach the other device', async () => await exists(moved) && !await exists(join(client.vault, '运维/紫藤服务器.md')));
    assert.match(await readFile(moved, 'utf8'), /password: hunter2/);
    await until('the index note to update', async () => (await readFile(join(client.vault, '运维/索引.md'), 'utf8')) === '# 运维索引\n\n- [紫藤服务器](服务器/紫藤.md)\n- [[紫藤]]\n');

    // An edit next to a masked credential keeps the original value.
    await page.getByRole('button', { name: '对话', exact: true }).click();
    turn = await propose({ title: '端口格式', summary: '', changes: [{ op: 'edit', path: '运维/服务器/紫藤.md',
      edits: [{ old: '紫藤服务器的管理端口是 8443。\n\npassword: [REDACTED]', new: '管理端口：`8443`。\n\npassword: [REDACTED]' }] }] });
    const second = (await api(`/tabularius/vaults/${vault.id}/proposals`))[0];
    assert.equal(second.title, '端口格式');
    await api(`/tabularius/proposals/${second.id}/apply`, 'POST');
    assert.match(await readFile(join(hosted, '运维/服务器/紫藤.md'), 'utf8'), /管理端口：`8443`。\n\npassword: hunter2\n/);

    // A note changed after the proposal: nothing is written, and the proposal shows why.
    turn = await propose({ title: '索引措辞', summary: '', changes: [{ op: 'edit', path: '运维/索引.md', edits: [{ old: '# 运维索引', new: '# 运维目录' }] }] });
    const third = (await api(`/tabularius/vaults/${vault.id}/proposals`))[0];
    await writeFile(join(client.vault, '运维/索引.md'), '# 运维索引\n\n另一台设备的修改\n');
    await until('the edit to reach the hosted copy', async () => (await readFile(join(hosted, '运维/索引.md'), 'utf8')).includes('另一台设备'));
    response = await call(`/tabularius/proposals/${third.id}/apply`, 'POST');
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'Proposal cannot be applied');
    assert.match(await readFile(join(hosted, '运维/索引.md'), 'utf8'), /# 运维索引/);
    await turn.locator('.proposal-link').click();
    await expect(page.getByText('运维/索引.md 在提案之后被修改过')).toBeVisible();
    await page.getByRole('button', { name: '放弃' }).click();
    await expect(page.getByText('已放弃这个提案。')).toBeVisible();
    assert.equal((await call(`/tabularius/proposals/${third.id}/apply`, 'POST')).status, 409);
    assert.equal((await call(`/tabularius/proposals/${third.id}`, 'GET', undefined, otherToken)).status, 404);
    await page.getByRole('button', { name: '提案', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(3);
    await until('the device to settle', async () => (await readFile(moved, 'utf8')).includes('管理端口：`8443`'));
    } finally {
      const stopped = new Promise(resolve => daemon.once('exit', resolve));
      daemon.kill('SIGTERM');
      await stopped;
    }
    // No conflicts anywhere, the old path is gone, and the moved note carries a modification time from the apply.
    const listing = (await cli('ls')).stdout.trim().split('\n').map(line => line.split('\t'));
    assert(listing.every(([, , , rev]) => !rev.endsWith('*')), `no conflicts:\n${listing.join('\n')}`);
    assert(Number(listing.find(([path]) => path === '运维/服务器/紫藤.md')[2]) >= appliedAt - 1000, 'the moved note has a new modification time');
    assert(!listing.some(([path]) => path === '运维/紫藤服务器.md'));
    assert(!await exists(join(hosted, '运维/紫藤服务器.md')));

    // The local knowledge base: only an administrator switches it on; datasets are fixed by the server; results are masked and filtered.
    mock.knowledge.push(
      { key: '银杏', content: '服务运维 / 银杏节点\n\n银杏节点的 token: kbsecret123', document_name: '运维/服务器/紫藤.md', dataset_name: '运维笔记', similarity: 0.91 },
      { key: '银杏', content: '银杏节点的备用说明', document_name: '服务运维/银杏备用.md', dataset_name: '运维笔记', similarity: 0.62 },
      { key: '银杏', content: '银杏 私密 kbdiary', document_name: '私密/日记.md', dataset_name: '其他笔记', similarity: 0.5 });
    const otherVault = await api('/vaults', 'POST', { name: '别人的库' }, otherToken);
    assert.equal((await call(`/tabularius/vaults/${otherVault.id}/knowledge`, 'PUT', { enabled: true }, otherToken)).status, 403);
    assert.equal((await api('/tabularius', 'GET', undefined, otherToken)).knowledge, false);
    assert.equal((await api('/tabularius')).knowledge, true);
    // The stream and the final answer, which the scripted model makes a copy of the tool result.
    const ask = async text => {
      const stream = await (await call(`/tabularius/conversations/${conversation.id}/messages`, 'POST', { message: text })).text();
      return { stream, answer: (await api(`/tabularius/conversations/${conversation.id}`)).messages.at(-1).text };
    };
    assert.match((await ask('KB 银杏')).answer, /unknown tool search_knowledge_base/, 'no knowledge base tool while it is off');
    assert(!mock.requests.anthropic.at(-1).body.tools.some(tool => tool.name === 'search_knowledge_base'));
    await api(`/tabularius/vaults/${vault.id}/knowledge`, 'PUT', { enabled: true });
    let { stream: kbStream, answer: kb } = await ask('KB 银杏');
    assert.match(kbStream, /event: tool\ndata: {"name":"search_knowledge_base","input":{"question":"银杏"}}/);
    assert.match(kb, /\[\[运维\/服务器\/紫藤.md\]\]/, 'a document present in the vault is cited as a note');
    assert.match(kb, /Knowledge base 运维笔记: 服务运维\/银杏备用.md/);
    assert.doesNotMatch(kb, /kbdiary|私密/);
    assert.deepEqual(mock.requests.mcp.find(r => r.body.method === 'tools/call').body.params.arguments, { question: '银杏', dataset_ids: ['ds-ops', 'ds-notes'], page_size: 8 });
    // RAGFlow restarted: the next call reconnects once.
    mock.restart();
    assert.match((await ask('KB 银杏')).answer, /备用说明/);
    assert.equal(mock.requests.mcp.filter(r => r.body.method === 'initialize').length, 2);
    for (const secret of ['kbsecret123', 'kbdiary']) assert(!mock.requests.anthropic.map(r => r.raw).join('\n').includes(secret), `${secret} reached a provider`);

    // Restart with the other provider: the client resumes without the passphrase and the conversation continues.
    await page.close();
    await gateway.close();
    url = await start(openai('gpt-test'), 'test-embed-2');
    await until('the hosted client to resume', async () => (await status()).replicated);
    // A different embedding model rebuilds the index with its own vectors.
    await until('the index to be rebuilt with the new model', () => db.prepare('SELECT embedding_model FROM tabularius_vaults').get()?.embedding_model === 'test-embed-2' && db.prepare('SELECT count(*) AS n FROM tabularius_chunks').get().n > 0);
    assert(mock.requests.embeddings.some(r => r.body.model === 'test-embed-2'));
    assert(mock.requests.embeddings.every(r => r.body.input.length <= 4), 'embedding requests respect the batch size');
    const stream = await (await call(`/tabularius/conversations/${conversation.id}/messages`, 'POST', { message: '银杏节点' })).text();
    assert.match(stream, /event: tool\ndata: {"name":"search_notes"/);
    assert.match(stream, /event: done\ndata: {"read":\["运维\/服务器\/紫藤.md"\]}/);
    const openaiSent = mock.requests.openai.map(r => r.raw).join('\n');
    assert(openaiSent.includes('银杏节点') && !openaiSent.includes('hunter2') && !openaiSent.includes('secretdiary'));
    assert.equal(mock.requests.openai[0].body.messages[0].role, 'system');
    const transcript = await api(`/tabularius/conversations/${conversation.id}`);
    assert.deepEqual(transcript.messages.filter(m => m.role === 'user' && !/^(PROPOSE|KB) /.test(m.text)).map(m => m.text), ['紫藤服务器', '管理端口', '银杏节点']);
    assert.deepEqual(transcript.messages.flatMap(m => m.tools ?? []).filter(tool => tool.proposal).map(tool => tool.proposal.status), ['applied', 'applied', 'discarded']);

    // Disabling removes everything the server held for this vault.
    await api(`/tabularius/vaults/${vault.id}`, 'DELETE');
    for (const table of ['tabularius_vaults', 'tabularius_files', 'tabularius_chunks', 'tabularius_conversations', 'tabularius_messages', 'tabularius_proposals', 'tabularius_changes']) {
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
