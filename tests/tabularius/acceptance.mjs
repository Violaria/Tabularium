// Acceptance of Tabularius on a read-only copy of a real vault, with real services: the model on vLLM, OpenAI or Anthropic, Infinity
// embeddings, the RAGFlow MCP and, for vLLM, SearXNG. A recording proxy in front of the model checks that masked values
// never reach it. Usage: TABULARIUS_VLLM_KEY=... node tests/tabularius/acceptance.mjs [vault], or with
// TABULARIUS_PROVIDER=openai, TABULARIUS_MODEL and OPENAI_API_KEY, or TABULARIUS_PROVIDER=anthropic and ANTHROPIC_API_KEY; the transcript goes to test-runs/.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../../apps/server/dist/server.js';
import { createFilter } from '../../apps/server/dist/tabularius/filter.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const cliPath = join(root, 'apps/obsidian/src/apps/cli/dist/index.cjs');
const sourceVault = resolve(process.argv[2] ?? '/opt/obsidian/Commentarii');
const env = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const providerName = process.env.TABULARIUS_PROVIDER ?? 'vllm';
const upstreamUrl = { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com' }[providerName] ?? process.env.TABULARIUS_VLLM_URL ?? 'http://127.0.0.1:8000';
const model = process.env.TABULARIUS_MODEL ?? { openai: undefined, anthropic: 'claude-opus-5-5' }[providerName] ?? (providerName === 'openai' ? env('TABULARIUS_MODEL') : 'Esmeralda');
const embeddingUrl = process.env.TABULARIUS_EMBEDDING_URL ?? 'http://127.0.0.1:8180/v1';
const mcpUrl = process.env.TABULARIUS_RAGFLOW_MCP_URL ?? 'http://127.0.0.1:9382/mcp';
const datasets = (process.env.TABULARIUS_RAGFLOW_DATASETS ?? '303720b6d3af11f1b9469553e347eb9c,303a8dfad3af11f1b9469553e347eb9c').split(',');
const searxng = process.env.TABULARIUS_SEARXNG_URL ?? 'http://127.0.0.1:7888';
const until = async (what, check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 2000)); }
  throw new Error(`Timed out waiting for ${what}`);
};

// Every request body sent to the model, as the model sees it.
const recorded = [];
const exchanges = [];
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    recorded.push(body.toString('utf8'));
    const target = new URL(req.url, upstreamUrl);
    const upstream = (target.protocol === 'https:' ? secureRequest : request)(target, { method: req.method, headers: { ...req.headers, host: target.host } }, response => {
      res.writeHead(response.statusCode, response.headers);
      const index = recorded.length;
      let streamed = '';
      response.on('data', chunk => { streamed += chunk; res.write(chunk); });
      response.on('end', () => { res.end(); exchanges.push({ index, request: JSON.parse(body.toString('utf8') || 'null'), response: streamed }); });
    });
    upstream.on('error', error => { res.writeHead(502); res.end(error.message); });
    upstream.end(body);
  });
}).listen(0, '127.0.0.1');
await new Promise(r => proxy.once('listening', r));
// The OpenAI and Anthropic SDKs read their base URLs from the environment.
if (providerName === 'openai') process.env.OPENAI_BASE_URL = `http://127.0.0.1:${proxy.address().port}/v1`;
if (providerName === 'anthropic') process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.address().port}`;

const runId = `tacc-${Date.now()}`;
const temp = await mkdtemp(join(tmpdir(), 'tabularius-acceptance-'));
const runDir = join(root, 'test-runs', runId);
await mkdir(runDir, { recursive: true });
const password = randomBytes(24).toString('hex');
const passphrase = randomBytes(16).toString('hex');
const compose = (...args) => exec('docker', ['compose', '-f', join(root, 'deploy/test/compose.yaml'), '-p', runId, ...args], {
  env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 120_000,
});
const transcript = [];
const results = [];
let gateway;
try {
  // Read-only copy; dot files are not synchronised by the plug-in.
  const copy = join(temp, 'vault');
  await exec('rsync', ['-a', '--exclude=.*', `${sourceVault}/`, `${copy}/`]);
  await compose('up', '-d', '--wait');
  const couchUrl = `http://${(await compose('port', 'couchdb', '5984')).stdout.trim()}`;
  const database = join(temp, 'app.sqlite');
  gateway = await createGateway({ database, bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
    couch: { url: couchUrl, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword: randomBytes(24).toString('hex') },
    tabularius: { key: randomBytes(32), root: join(temp, 'tabularius'), cli: cliPath,
      // The provider, its key, the knowledge base, embeddings, the web and the limits, as the environment would configure them on a first start.
      initial: {
        providers: { [providerName]: providerName === 'vllm'
          ? { url: `http://127.0.0.1:${proxy.address().port}/v1`, key: env('TABULARIUS_VLLM_KEY'), models: [model], context: 65_536 }
          : { key: env(providerName === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'), models: [model] } },
        defaultModel: `${providerName}/${model}`, knowledge: { url: mcpUrl, datasets },
        embedding: { url: embeddingUrl, model: 'bge-m3', batch: 32 },
        web: { enabled: true, searxng: providerName === 'vllm' ? searxng : '', allowed: [], blocked: [], maxUses: 5, intranet: [] },
        limits: { modeLimit: 'read-only' },
      } } });
  const url = await gateway.listen();
  let token;
  const call = (path, method = 'GET', body) => fetch(`${url}/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const api = async (path, method, body) => {
    const response = await call(path, method, body);
    assert(response.ok, `${method ?? 'GET'} ${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  token = (await api('/sessions', 'POST', { username: 'admin', password })).token;
  const userPassword = randomBytes(12).toString('hex');
  await api('/me/password', 'PUT', { currentPassword: password, password: userPassword });
  token = (await api('/sessions', 'POST', { username: 'admin', password: userPassword })).token;
  const vault = await api('/vaults', 'POST', { name: 'Commentarii 副本' });

  // The copy uploaded by a CLI device, as from Obsidian.
  const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: 'cli' });
  const client = { db: join(temp, 'db'), settings: join(temp, 'settings.json') };
  await mkdir(client.db, { recursive: true });
  await exec(process.execPath, [cliPath, 'init-settings', client.settings]);
  await writeFile(client.settings, JSON.stringify({ ...JSON.parse(await readFile(client.settings, 'utf8')),
    couchDB_URI: `${url}/sync`, couchDB_DBNAME: vault.id, couchDB_USER: device.username, couchDB_PASSWORD: device.password,
    isConfigured: true, encrypt: true, passphrase, E2EEAlgorithm: 'v2', usePathObfuscation: true, liveSync: false, syncOnStart: false, syncOnSave: false, usePluginSync: false }));
  const cli = (...args) => exec(process.execPath, [cliPath, client.db, '--settings', client.settings, '--vault', copy, ...args], { cwd: root, timeout: 30 * 60_000, maxBuffer: 1 << 26 });
  let started = Date.now();
  await cli('mirror', copy); await cli('sync');
  const uploaded = (await cli('ls')).stdout.trim().split('\n').length;
  console.log(`[acceptance] uploaded ${uploaded} files in ${Math.round((Date.now() - started) / 1000)} s`);

  started = Date.now();
  await api(`/tabularius/vaults/${vault.id}`, 'POST', { passphrase, confirm: true });
  const status = async () => (await api('/tabularius')).vaults.find(v => v.id === vault.id);
  const db = new DatabaseSync(database, { readOnly: true });
  // Indexed once the hosted copy holds every uploaded file, the count of notes holds still and every chunk has its embedding.
  const hosted = join(temp, 'tabularius', vault.id, 'vault');
  let previous = -1;
  const indexed = await until('the hosted client to fetch and index the vault', async () => {
    const s = await status();
    if (s.indexError) throw new Error(`index: ${s.indexError}`);
    const files = (await readdir(hosted, { recursive: true, withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile()).length;
    const pending = db.prepare('SELECT count(*) AS n FROM tabularius_chunks WHERE vault_id=? AND embedding IS NULL').get(vault.id).n;
    const settled = s.replicated && files >= uploaded && s.notes === previous && pending === 0;
    previous = s.notes;
    return settled && s;
  }, 60 * 60_000).catch(async error => { console.log(JSON.stringify(await status())); throw error; });
  console.log(`[acceptance] indexed ${indexed.notes} notes, ${indexed.chunks} chunks in ${Math.round((Date.now() - started) / 1000)} s`);
  // The vault's Tabularius.md becomes its prompt by importing it, as an owner would on the settings page.
  await api(`/tabularius/vaults/${vault.id}/prompt`, 'PUT', { prompt: (await api(`/tabularius/vaults/${vault.id}/prompt/import`, 'POST', {})).prompt });

  // Values the filter masks in the hosted copy; none may appear in what the model receives. A value that also appears
  // unmasked elsewhere (an ordinary word after "token:") is not a credential.
  const filter = createFilter('', '');
  const secrets = new Set();
  const masked = [];
  for (const { path } of db.prepare('SELECT path FROM tabularius_files').all()) {
    const text = await readFile(join(hosted, path), 'utf8').catch(() => '');
    const redaction = filter.redact(text);
    masked.push(redaction.text);
    for (const span of redaction.spans) { const value = text.slice(span.start, span.end); if (value.length >= 6) secrets.add(value); }
  }
  const everywhere = masked.join('\n');
  for (const value of secrets) if (everywhere.includes(value)) secrets.delete(value);

  let conversation;
  const ask = async (text, fresh = false) => {
    const path = fresh || !conversation ? `/tabularius/vaults/${vault.id}/conversations` : `/tabularius/conversations/${conversation}/messages`;
    const t0 = Date.now();
    const stream = await (await call(path, 'POST', { message: text })).text();
    const id = JSON.parse(stream.match(/event: conversation\ndata: (.*)/)?.[1] ?? 'null')?.id ?? conversation;
    conversation = id;
    const tools = [...stream.matchAll(/event: tool\ndata: (.*)/g)].map(m => JSON.parse(m[1]));
    const done = JSON.parse(stream.match(/event: done\ndata: (.*)/)?.[1] ?? 'null');
    const error = stream.match(/event: error\ndata: (.*)/)?.[1];
    const answer = (await api(`/tabularius/conversations/${id}`)).messages.at(-1).text;
    transcript.push({ question: text, seconds: Math.round((Date.now() - t0) / 1000), tools, done, error, answer });
    console.log(`[acceptance] ${text}\n  tools: ${tools.map(t => t.name).join(', ') || '-'}  (${Math.round((Date.now() - t0) / 1000)} s)${error ? `\n  error: ${error}` : ''}`);
    return { stream, tools, done, error, answer };
  };
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`[acceptance] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

  // Questions answered from the notes, with citations.
  let r = await ask('本地知识库的 RAGFlow MCP 服务在容器网络里的地址是什么？', true);
  check('问答：从笔记回答并引用', !r.error && /9382/.test(r.answer) && /\[\[服务运维\/本地知识库\//.test(r.answer));
  r = await ask('Tabularium 生产部署在 oblivaria 的哪个目录？升级时要带哪些 Compose 文件？', true);
  check('问答：多轮检索后作答', !r.error && /\/opt\/tabularium/.test(r.answer), r.done?.read.join(', '));

  // The local knowledge base.
  await api(`/tabularius/vaults/${vault.id}/knowledge`, 'PUT', { enabled: true });
  r = await ask('请用本地知识库检索：Infinity 提供的 embedding 模型叫什么、多少维？', true);
  check('知识库：调用 RAGFlow 检索', !r.error && r.tools.some(t => t.name === 'search_knowledge_base') && /bge-m3/i.test(r.answer));

  // The web through SearXNG.
  await api(`/tabularius/vaults/${vault.id}/web`, 'PUT', { enabled: true });
  r = await ask('联网查证：vLLM 项目在 GitHub 上的仓库地址是什么？请给出来源。', true);
  check(providerName === 'vllm' ? '联网：SearXNG 搜索并给出来源' : '联网：提供商自带搜索并给出来源', !r.error && r.tools.some(t => t.name === 'web_search') && r.done?.sources.length > 0, r.done?.sources.map(s => s.url).join(', '));

  // Memories across conversations.
  r = await ask('请记住：我希望回答先给结论，再给理由。', true);
  check('记忆：保存', !r.error && r.tools.some(t => t.name === 'add_memory'));
  const memories = await api('/tabularius/memories');
  r = await ask('我对回答的格式有什么偏好？', true);
  check('记忆：新对话中想起', !r.error && memories.length > 0 && /结论/.test(r.answer));

  // A curation proposal by the Tabularius rules, applied to the copy and synchronised back to the device.
  r = await ask('请按 Tabularius.md 的规范检查「服务运维/本地知识库」目录：Content.md 是否列全了该目录的笔记？如果有遗漏或不符合规范的地方，提交一个整理提案；如果都符合，就提交一个只改一处措辞的小提案。', true);
  const proposals = await api(`/tabularius/vaults/${vault.id}/proposals`);
  check('提案：按规范生成', !r.error && proposals.length > 0, proposals.map(p => `${p.title} (${p.files ?? ''})`).join('; '));
  if (proposals.length) {
    const proposal = await api(`/tabularius/proposals/${proposals[0].id}`);
    await writeFile(join(runDir, 'proposal.json'), JSON.stringify(proposal, null, 2));
    const response = await call(`/tabularius/proposals/${proposals[0].id}/apply`, 'POST');
    check('提案：应用', response.ok, `${response.status}`);
    if (response.ok) {
      await cli('sync');
      const listing = (await cli('ls')).stdout.trim().split('\n').map(line => line.split('\t'));
      check('提案：同步回设备且无冲突', listing.every(([, , , rev]) => !rev?.endsWith('*')));
    }
  }

  // Masked values never reach the model, including what the notes, the knowledge base and the web returned.
  const sent = recorded.join('\n');
  const leaked = [...secrets].filter(secret => sent.includes(secret) || sent.includes(JSON.stringify(secret).slice(1, -1)));
  check('屏蔽：凭据未发给模型', leaked.length === 0, `${secrets.size} 个屏蔽值，${recorded.length} 次模型请求，泄露 ${leaked.length} 个`);
} finally {
  await writeFile(join(runDir, 'transcript.json'), JSON.stringify({ results, transcript }, null, 2));
  await writeFile(join(runDir, 'model.json'), JSON.stringify(exchanges), { mode: 0o600 });
  await gateway?.close();
  proxy.close();
  await compose('down', '-v').catch(error => console.error(error.message));
  await rm(temp, { recursive: true, force: true });
  console.log(`[acceptance] transcript: ${relative(root, runDir)}/transcript.json`);
}
const failed = results.filter(r => !r.ok);
console.log(`[acceptance] ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
