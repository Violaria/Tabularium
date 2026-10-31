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
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createGateway } from '../../apps/server/dist/server.js';
import { anthropic, embedder, openai, vllm } from '../../apps/server/dist/tabularius/providers.js';
import { ragflow } from '../../apps/server/dist/tabularius/knowledge.js';
import { serveSandbox } from '../../apps/server/dist/sandbox.js';
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
  // The sandbox service against this host's Docker, with the one image the tests have locally.
  const sandboxToken = randomBytes(24).toString('hex');
  const sandbox = await serveSandbox({ socket: '/var/run/docker.sock', images: ['alpine:3'], token: sandboxToken, port: 0, host: '127.0.0.1' });
  process.env.ANTHROPIC_BASE_URL = mock.url; process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  process.env.OPENAI_BASE_URL = `${mock.url}/v1`; process.env.OPENAI_API_KEY = 'test-openai';
  const database = join(temp, 'app.sqlite');
  const key = randomBytes(32);
  let gateway, browser, couchUrl;
  const syncPassword = randomBytes(24).toString('hex');
  const start = async (provider, embeddingModel = 'test-embed', blocked = []) => {
    gateway = await createGateway({ database, bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
      couch: { url: couchUrl, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword },
      tabularius: { key, root: join(temp, 'tabularius'), cli: cliPath, provider,
        embedder: embedder(embeddingModel, `${mock.url}/v1`, 'test-embed-key', 4), knowledge: ragflow(`${mock.url}/mcp`, ['ds-ops', 'ds-notes']),
        web: { options: { allowed: [], blocked, maxUses: 3 }, searxng: mock.url, intranet: ['127.0.0.1'] }, modeLimit: 'restricted', params: {},
        sandbox: { url: `http://127.0.0.1:${sandbox.port}`, token: sandboxToken, images: ['alpine:3'] } } });
    return gateway.listen();
  };
  try {
    await compose('up', '-d', '--wait');
    await exec('docker', ['build', '-q', '-t', 'tabularius-test-sshd', join(root, 'tests/tabularius/sshd')], { timeout: 300_000 });
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
    // A new conversation: the input in the middle of the page, the client's state in the top-right corner.
    await expect(page.locator('.sync-pill.ok')).toContainText('已同步', { timeout: 30_000 });
    await expect(page.locator('.sync-pill')).toContainText('已索引');
    await expect(page.locator('.chat-start .composer')).toBeVisible();
    await expect(page.locator('.chat-title')).toHaveText('');
    const shots = resolve('test-runs', `tabularius-${Date.now()}`); await mkdir(shots, { recursive: true });
    await page.screenshot({ path: join(shots, 'start.png') });
    await page.getByPlaceholder('询问你的笔记').fill('紫藤服务器');
    await page.getByRole('button', { name: '发送' }).click();
    const answer = page.locator('.turn.assistant').last();
    await expect(answer.locator('.answer')).toContainText('根据', { timeout: 60_000 });
    await expect(answer.locator('.tools')).toContainText('检索：紫藤服务器');
    await expect(answer.locator('.tools')).toContainText('读取：运维/紫藤服务器.md');
    const href = `/notes/?vault=${vault.id}&path=${encodeURIComponent('运维/紫藤服务器.md')}`;
    await expect(answer.locator('.answer a.cite')).toHaveAttribute('href', href);
    await expect(page.locator('.conversation')).toHaveCount(1);
    await expect(page.locator('.chat-bottom .composer')).toBeVisible();
    await page.screenshot({ path: join(shots, 'chat.png') });
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
    await page.getByRole('button', { name: '应用', exact: true }).click();
    // The application's own confirmation dialog names the action on its button.
    await page.getByRole('dialog').getByRole('button', { name: '应用', exact: true }).click();
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

    // Permission modes: restricted and full are for administrators, up to the server's limit; parameters are checked per provider.
    assert.equal((await call(`/tabularius/vaults/${otherVault.id}/mode`, 'PUT', { mode: 'restricted' }, otherToken)).status, 403);
    assert.equal((await call(`/tabularius/vaults/${vault.id}/mode`, 'PUT', { mode: 'full' })).status, 400);
    assert.equal((await api(`/tabularius/vaults/${vault.id}/mode`, 'PUT', { mode: 'restricted' })).mode, 'restricted');
    assert.deepEqual((await api('/tabularius')).modes, ['read-only', 'restricted']);
    assert.deepEqual((await api('/tabularius', 'GET', undefined, otherToken)).modes, ['read-only']);
    assert.equal((await call(`/tabularius/vaults/${vault.id}/params`, 'PUT', { params: '{"temperature": 0.5}' })).status, 400, 'Claude takes no sampling parameters');
    await api(`/tabularius/vaults/${vault.id}/params`, 'PUT', { params: '{"effort": "high"}' });

    // The web with Claude: server-side search, a paused turn continued unchanged, cited sources and an activity record.
    assert(mock.requests.anthropic.every(r => !r.body.tools.some(tool => tool.type?.startsWith('web_'))), 'no web tools while the web is off');
    await api(`/tabularius/vaults/${vault.id}/web`, 'PUT', { enabled: true });
    const anthropicBefore = mock.requests.anthropic.length;
    let web = await ask('WEB 最新版本');
    assert.match(web.stream, /event: tool\ndata: {"name":"web_search","input":{"query":"最新版本"}}/);
    assert.match(web.stream, /"sources":\[{"url":"https:\/\/example.com\/release","title":"Release notes"}\]/);
    const [searching, continued] = mock.requests.anthropic.slice(anthropicBefore).map(r => r.body);
    assert.deepEqual(searching.tools.filter(tool => tool.type?.startsWith('web_')).map(tool => [tool.type, tool.max_uses]), [['web_search_20260318', 3], ['web_fetch_20260318', 6]]);
    assert.equal(searching.output_config.effort, 'high');
    assert.equal(continued.messages.at(-1).role, 'assistant');
    assert.equal(continued.messages.at(-1).content.find(block => block.type === 'web_search_tool_result').content[0].encrypted_content, `enc-${anthropicBefore + 1}`);
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='tabularius.web'").get().n, 1);
    const shown = (await api(`/tabularius/conversations/${conversation.id}`)).messages.at(-1);
    assert.deepEqual(shown.sources, [{ url: 'https://example.com/release', title: 'Release notes' }]);
    assert.equal(shown.text, '最新版本是 2.0。');
    await api(`/tabularius/vaults/${vault.id}/params`, 'PUT', { params: '' });

    // Memories: Tabularius stores one when asked, a new conversation starts with it, and only its owner can see or change it.
    assert.match((await ask('REMEMBER 回答用繁体中文')).answer, /Remembered as/);
    const [memory] = await api('/tabularius/memories');
    assert.equal(memory.content, '回答用繁体中文');
    assert.deepEqual(await api('/tabularius/memories', 'GET', undefined, otherToken), []);
    assert.equal((await call(`/tabularius/memories/${memory.id}`, 'PUT', { content: 'x' }, otherToken)).status, 404);
    assert.equal((await call(`/tabularius/memories/${memory.id}`, 'DELETE', undefined, otherToken)).status, 404);
    assert.equal((await call('/tabularius/memories', 'POST', { content: '' })).status, 400);
    const fresh = await (await call(`/tabularius/vaults/${vault.id}/conversations`, 'POST', { message: '紫藤服务器' })).text();
    const freshId = /"id":"([^"]+)"/.exec(fresh)[1];
    assert.match(JSON.stringify(mock.requests.anthropic.at(-1).body.system), new RegExp(`\\[${memory.id}\\] 回答用繁体中文`));
    // Earlier conversations: found by their words and read back.
    const recall = await (await call(`/tabularius/conversations/${freshId}/messages`, 'POST', { message: 'RECALL 管理端口' })).text();
    assert.match(recall, /"name":"search_conversations"/);
    assert.match(recall, /"name":"read_conversation","input":{"id":"[^"]+"}/);
    assert.match((await api(`/tabularius/conversations/${freshId}`)).messages.at(-1).text, /User: 紫藤服务器/);
    // Long conversations: Claude compacts on the server.
    const lastClaude = mock.requests.anthropic.at(-1);
    assert.deepEqual(lastClaude.body.context_management, { edits: [{ type: 'compact_20260112' }] });
    assert.match(lastClaude.headers['anthropic-beta'], /compact-2026-01-12/);
    await api(`/tabularius/conversations/${freshId}`, 'DELETE');

    // SSH: a host registered by an administrator, with its own key and a pinned host key; commands checked by mode.
    assert.equal((await call('/tabularius/hosts', 'GET', undefined, otherToken)).status, 403);
    const sshd = `${runId}-sshd`;
    // A fixed host port, so the container keeps it across the restart below.
    const free = createServer().listen(0, '127.0.0.1');
    await once(free, 'listening');
    const sshPort = free.address().port;
    free.close(); await once(free, 'close');
    await exec('docker', ['run', '-d', '--name', sshd, '-p', `127.0.0.1:${sshPort}:2222`, '-e', 'AUTHORIZED_KEY=', 'tabularius-test-sshd']);
    try {
      const host = await api('/tabularius/hosts', 'POST', { name: 'test', address: '127.0.0.1', port: sshPort, username: 'tab', policy: 'allowed', commands: '' });
      assert.match(host.publicKey, /^ssh-ed25519 /);
      assert.equal((await call(`/tabularius/hosts/${host.id}/check`, 'POST')).status, 502, 'the key is not installed yet');
      await exec('docker', ['exec', sshd, 'sh', '-c', `printf '%s\\n' '${host.publicKey}' > /home/tab/.ssh/authorized_keys`]);
      assert.match((await until('sshd to accept the key', async () => {
        const response = await call(`/tabularius/hosts/${host.id}/check`, 'POST');
        return response.ok && response.json();
      }, 30_000)).fingerprint, /^SHA256:/);
      const sshAsk = async text => (await ask(text)).answer;
      // Restricted mode: read-only commands and the allow list; output masked before it reaches the provider.
      assert.match(await sshAsk('SSH test cat /home/tab/app.env'), /Exit code: 0[\s\S]*host: db.local\npassword: \[REDACTED\]/);
      assert(!mock.requests.anthropic.map(r => r.raw).join('').includes('hunter9'), 'the credential in the output was masked');
      assert.match(await sshAsk('SSH test cat a; rm b'), /refused: shell operators/);
      assert.match(await sshAsk('SSH test touch /tmp/made'), /not in this host's allow list/);
      await api(`/tabularius/hosts/${host.id}`, 'PUT', { policy: 'allowed', commands: 'touch /tmp/*' });
      assert.match(await sshAsk('SSH test touch /tmp/made'), /Exit code: 0/);
      await exec('docker', ['exec', sshd, 'test', '-f', '/tmp/made']);
      // Read-only mode refuses the same command.
      await api(`/tabularius/vaults/${vault.id}/mode`, 'PUT', { mode: 'read-only' });
      assert.match(await sshAsk('SSH test touch /tmp/other'), /only read-only commands/);
      await api(`/tabularius/vaults/${vault.id}/mode`, 'PUT', { mode: 'restricted' });
      // A host that asks first: the command waits for the user's decision in the page's stream.
      await api(`/tabularius/hosts/${host.id}`, 'PUT', { policy: 'authorize', commands: 'touch /tmp/*' });
      const decided = async (text, approved) => {
        const response = await call(`/tabularius/conversations/${conversation.id}/messages`, 'POST', { message: text });
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let stream = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          stream += value;
          const waiting = /event: approval\ndata: ({"id":"[^"]+","host":"test","command":"[^"]+"})\n/.exec(stream);
          if (waiting && !stream.includes('"approved"')) {
            assert.equal((await call(`/tabularius/approvals/${JSON.parse(waiting[1]).id}`, 'POST', { approved }, otherToken)).status, 404, 'only the asking user decides');
            await api(`/tabularius/approvals/${JSON.parse(waiting[1]).id}`, 'POST', { approved });
          }
        }
        return (await api(`/tabularius/conversations/${conversation.id}`)).messages.at(-1).text;
      };
      assert.match(await decided('SSH test touch /tmp/approved', true), /Exit code: 0/);
      await exec('docker', ['exec', sshd, 'test', '-f', '/tmp/approved']);
      assert.match(await decided('SSH test touch /tmp/denied', false), /did not approve/);
      await assert.rejects(exec('docker', ['exec', sshd, 'test', '-f', '/tmp/denied']));
      // Forbidden hosts are never connected; a changed host key stops every command.
      await api(`/tabularius/hosts/${host.id}`, 'PUT', { policy: 'forbidden', commands: '' });
      assert.match(await sshAsk('SSH test uptime'), /forbidden host/);
      await api(`/tabularius/hosts/${host.id}`, 'PUT', { policy: 'allowed', commands: '' });
      await exec('docker', ['exec', sshd, 'sh', '-c', 'rm /etc/ssh/ssh_host_* && ssh-keygen -A']);
      await exec('docker', ['restart', sshd]);
      assert.match(await until('sshd to restart', async () => { const a = await sshAsk('SSH test uptime'); return !/ECONNREFUSED|ECONNRESET/.test(a) && a; }, 30_000), /does not match the recorded/);
      const record = await api('/tabularius/commands');
      assert.deepEqual([...new Set(record.map(c => c.status))].sort(), ['denied', 'done', 'failed', 'refused']);
      assert(record.some(c => c.command === 'touch /tmp/approved' && c.status === 'done'));
      assert(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='tabularius.ssh'").get().n >= 8);
    } finally {
      await exec('docker', ['rm', '-f', sshd]).catch(() => {});
    }

    // Sandbox: a throwaway container with a read-only root, no network, nobody's uid and a time limit; output masked.
    const box = async input => (await ask(`SANDBOX ${JSON.stringify(input)}`)).answer;
    let out = await box({ image: 'alpine:3', command: 'cat data.txt; id -u; touch /x; echo written > /work/ok && cat ok', files: { 'data.txt': 'password: hunter7\n' } });
    assert.match(out, /Exit code: 0/);
    assert.match(out, /password: \[REDACTED\]\n65534\n[\s\S]*written/);
    assert.match(out, /Read-only file system/);
    // The credential was in the request the user typed; what must not carry it is the command output returned to the model.
    const results = mock.requests.anthropic.flatMap(r => r.body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []));
    assert(results.some(b => JSON.stringify(b).includes('65534')) && !results.some(b => JSON.stringify(b).includes('hunter7')));
    assert.match(await box({ image: 'alpine:3', command: 'wget -q -T 3 -O- http://example.com' }), /Exit code: [1-9]/);
    assert.match(await box({ image: 'alpine:3', command: 'echo hi', network: true }), /only in full permission mode/);
    assert.match(await box({ image: 'alpine:3', command: 'sleep 30', timeout: 2 }), /Timed out and stopped/);
    assert.match(await box({ image: 'python:3.13-slim', command: 'python -V' }), /not available/);
    assert.equal((await fetch(`http://127.0.0.1:${sandbox.port}/run`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await exec('docker', ['ps', '-aq', '--filter', 'label=tabularius.sandbox'])).stdout.trim(), '', 'no sandbox container is left');
    assert(db.prepare("SELECT count(*) AS n FROM tabularius_commands WHERE host_id='sandbox'").get().n >= 5);

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
    assert.match(stream, /event: done\ndata: {"read":\["运维\/服务器\/紫藤.md"\],"sources":\[\]}/);
    const openaiSent = mock.requests.openai.map(r => r.raw).join('\n');
    assert(openaiSent.includes('银杏节点') && !openaiSent.includes('hunter2') && !openaiSent.includes('secretdiary'));
    // The Responses API: instructions carry the system prompt, encrypted reasoning items are replayed, OpenAI searches the web itself.
    assert.match(mock.requests.openai[0].body.instructions, /本库的规范/);
    assert.equal(mock.requests.openai[0].body.store, false);
    assert.equal(mock.requests.openai[0].body.truncation, 'auto');
    assert(mock.requests.openai.at(-1).body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'enc-1'), 'reasoning items are replayed');
    web = await ask('WEB 最新版本');
    assert(mock.requests.openai.at(-1).body.tools.some(tool => tool.type === 'web_search'));
    assert.match(web.stream, /event: tool\ndata: {"name":"web_search","input":{"query":"最新版本"}}/);
    assert.match(web.stream, /"sources":\[{"url":"https:\/\/example.com\/release","title":"Release notes"}\]/);

    // vLLM: reasoning goes back on assistant messages; the web through SearXNG and the server's fetch, by permission mode.
    await gateway.close();
    // A small context window makes the long history drop its earliest exchanges.
    url = await start(vllm('esmeralda', `${mock.url}/v1`, undefined, 6000), 'test-embed-2', ['blocked.example.org']);
    await until('the hosted client to resume', async () => (await status()).replicated);
    web = await ask('WEB 版本');
    assert.match(web.answer, /版本 2.0\n+2026 年发布 & 支持 bge-m3。/);
    assert.doesNotMatch(web.answer, /ignore\(\)/);
    assert.match(web.stream, /"sources":\[{"url":"http:\/\/127.0.0.1:\d+\/page","title":"发布说明"}\]/);
    const vllmLast = mock.requests.vllm.at(-1).body;
    assert(vllmLast.messages.some(m => m.role === 'assistant' && m.reasoning === 'thinking-1'), 'reasoning is replayed to vLLM');
    assert(vllmLast.tools.some(tool => tool.function.name === 'fetch_url'));
    assert.match(vllmLast.messages[1].content, /left out to fit the context window/);
    assert(!JSON.stringify(vllmLast.messages).includes('"紫藤服务器"'), 'the first question was left out');
    assert(!JSON.stringify(vllmLast.messages).includes('blocked.example.org'), 'search results outside the domain rules are dropped');
    assert.equal(mock.requests.page.length, 1);
    // An answer from the search results alone lists the results it links to as sources.
    const snippet = await ask('SNIPPET 版本');
    assert.match(snippet.stream, /"sources":\[{"url":"http:\/\/127.0.0.1:\d+\/page","title":"发布说明"}\]/);
    assert.equal(mock.requests.page.length, 1);
    // At the tool limit the model answers without tools instead of stopping with nothing.
    const vllmBefore = mock.requests.vllm.length;
    assert.equal((await ask('LOOP 紫藤')).answer, '搜索了 8 次');
    assert.deepEqual(mock.requests.vllm.slice(vllmBefore).map(r => r.body.tool_choice ?? 'auto'), [...Array(8).fill('auto'), 'none']);
    assert.deepEqual(mock.requests.vllm.at(-1).body.messages.at(-1), { role: 'user', content: 'The tool limit for this answer is reached. Answer now with what you have found, without calling tools.' });
    // A URL the conversation never showed is refused, so note content cannot be smuggled out in a query string.
    assert.match((await ask('WEBLEAK 版本')).answer, /only URLs that appeared in the conversation/);
    assert.equal(mock.requests.page.length, 1);
    // Read-only mode reaches only public addresses.
    await api(`/tabularius/vaults/${vault.id}/mode`, 'PUT', { mode: 'read-only' });
    assert.match((await ask('WEB 版本')).answer, /address this mode does not allow/);
    assert.equal(mock.requests.page.length, 1);
    const transcript = await api(`/tabularius/conversations/${conversation.id}`);
    assert.deepEqual(transcript.messages.filter(m => m.role === 'user' && !/^(PROPOSE|KB|WEB|WEBLEAK|SNIPPET|LOOP|REMEMBER|SSH|SANDBOX) /.test(m.text)).map(m => m.text), ['紫藤服务器', '管理端口', '银杏节点']);
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
    await sandbox.close();
    await compose('down', '-v').catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
});
