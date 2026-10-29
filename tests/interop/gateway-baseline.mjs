import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createGateway } from '../../apps/server/dist/server.js';

export async function startTestGateway(runDir, upstream, password, secrets) {
  const syncPassword = randomBytes(24).toString('hex');
  secrets.push(syncPassword);
  const config = { database: join(runDir, 'gateway.sqlite'), bootstrapUser: 'baseline', bootstrapPassword: password,
    origins: ['app://obsidian.md', 'http://localhost', 'capacitor://localhost'], loginLimit: 100,
    couch: { url: upstream, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword } };
  let gateway = await createGateway(config);
  let url = await gateway.listen();
  let token;
  const vaults = new Map();
  async function api(path, method, body) {
    const response = await fetch(url + '/api/v1' + path, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, `Management API ${path}: ${response.status}`); return response.json();
  }
  token = (await api('/sessions', 'POST', { username: 'baseline', password })).token;
  secrets.push(token);
  const updated = randomBytes(24).toString('hex'); secrets.push(updated);
  await api('/me/password', 'PUT', { currentPassword: password, password: updated });
  return {
    get url() { return url; },
    physical(name) { return `tab_${vaults.get(name).id.replaceAll('-', '')}`; },
    async create(name) { vaults.set(name, await api('/vaults', 'POST', { name })); },
    async credentials(name, deviceName) {
      const vault = vaults.get(name);
      const device = await api(`/vaults/${vault.id}/devices`, 'POST', { name: deviceName });
      secrets.push(device.password, Buffer.from(`${device.username}:${device.password}`).toString('base64'));
      return { database: vault.id, username: device.username, password: device.password };
    },
    async arm(name, deviceId) { await api(`/vaults/${vaults.get(name).id}/rebuild`, 'POST', { deviceId, confirm: name }); },
    async restart(upstream) { await gateway.close(); config.couch.url = upstream; gateway = await createGateway(config); url = await gateway.listen(); },
    async close() { await gateway.close(); },
  };
}
