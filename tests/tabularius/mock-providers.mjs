// Stand-ins for the Anthropic Messages API, OpenAI Chat Completions, OpenAI embeddings and RAGFlow's MCP server, enough for the official SDKs.
// The model is scripted: search for the user's question, read the first note found, then answer citing it with a quote;
// a question "PROPOSE <json>" proposes those changes instead.
// Every request body is kept so tests can check what would have left the server.
import { createServer } from 'node:http';
import { once } from 'node:events';

const lastUserText = messages => {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    const text = message.content.find(block => block.type === 'text');
    if (text) return text.text;
  }
  return '';
};

/** The next step of the script, from the tool results so far in the current question. */
function plan(results, question) {
  // "PROPOSE <json>" makes the model call propose_changes with that input, then repeat the tool's answer.
  if (question.startsWith('PROPOSE ')) return results.length ? { text: results[0] } : { tool: 'propose_changes', input: JSON.parse(question.slice(8)) };
  // "KB <question>" searches the knowledge base and repeats what came back.
  if (question.startsWith('KB ')) return results.length ? { text: results[0] } : { tool: 'search_knowledge_base', input: { question: question.slice(3) } };
  if (!results.length) return { tool: 'search_notes', input: { query: question } };
  const found = /\[\[([^\]]+)\]\]/.exec(results[0]);
  if (results.length === 1 && found) return { tool: 'read_note', input: { path: found[1] } };
  const quote = results.at(-1).split('\n').find(line => line.trim()) ?? '';
  return { text: found ? `根据 [[${found[1]}]]：${quote}` : '笔记里没有相关内容。' };
}

export async function startMockProviders() {
  const requests = { anthropic: [], openai: [], embeddings: [], mcp: [] };
  const sessions = new Set();
  let sessionCount = 0;
  const knowledge = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    const path = req.url.split('?')[0];
    if (path === '/v1/messages') {
      requests.anthropic.push({ headers: req.headers, body, raw });
      // Tool results since the last plain user question.
      const results = [];
      for (const message of [...body.messages].reverse()) {
        if (message.role === 'assistant') continue;
        if (typeof message.content === 'string') break;
        const blocks = message.content.filter(block => block.type === 'tool_result');
        if (!blocks.length) break;
        results.unshift(...blocks.map(block => typeof block.content === 'string' ? block.content : block.content.map(c => c.text).join('')));
      }
      const step = plan(results, lastUserText(body.messages));
      const n = requests.anthropic.length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      // A thinking block with a signature, which the server must replay unchanged on later requests.
      send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: `sig-${n}` } });
      send('content_block_stop', { index: 0 });
      if (step.tool) {
        send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: `toolu_${n}`, name: step.tool, input: {} } });
        send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
      } else {
        send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
        for (const piece of step.text.match(/.{1,8}/gs)) send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: piece } });
      }
      send('content_block_stop', { index: 1 });
      send('message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
      send('message_stop', {});
      res.end();
      return;
    }
    if (path === '/v1/chat/completions') {
      requests.openai.push({ headers: req.headers, body, raw });
      const results = [];
      for (const message of [...body.messages].reverse()) {
        if (message.role !== 'tool') { if (message.role === 'user') break; continue; }
        results.unshift(message.content);
      }
      const step = plan(results, lastUserText(body.messages));
      const n = requests.openai.length;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `c${n}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (step.tool) {
        const args = JSON.stringify(step.input);
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: step.tool, arguments: args.slice(0, 5) } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: '' });
        for (const piece of step.text.match(/.{1,8}/gs)) chunk({ content: piece });
        chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    if (path === '/mcp') {
      // RAGFlow's MCP server: sessions are forgotten by restart(), as when RAGFlow restarts.
      requests.mcp.push({ headers: req.headers, body });
      const session = req.headers['mcp-session-id'];
      if (body.method === 'initialize') {
        const id = `session-${++sessionCount}`; sessions.add(id);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ragflow', version: '0' } } }));
        return;
      }
      if (!sessions.has(session)) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })); return; }
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      const chunks = knowledge.filter(chunk => chunk.content.includes(body.params.arguments.question) || body.params.arguments.question.includes(chunk.key));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify({ chunks }) }] } }));
      return;
    }
    if (path === '/v1/embeddings') {
      requests.embeddings.push({ headers: req.headers, body, raw });
      // Deterministic vectors: character counts folded into 32 dimensions.
      const vector = text => { const v = Array(32).fill(0); for (const char of text) v[char.codePointAt(0) % 32] += 1; return v; };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: body.model, data: body.input.map((text, index) => ({ object: 'embedding', index, embedding: vector(text) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, requests, knowledge, restart: () => sessions.clear(), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
