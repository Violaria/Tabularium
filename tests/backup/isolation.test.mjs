// A restored copy or an upgrade trial runs on its own: its Compose override keeps only the project's own networks, and
// the copied environment starts no profiles. Checked with the deployment's Compose file and `docker compose config`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Compose } from '../../deploy/backup/docker.ts';
import { isolatedOverride } from '../../deploy/backup/restore.ts';

const root = resolve(import.meta.dirname, '../..');

test('a restored copy leaves external networks and the sandbox profile out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabularium-isolation-'));
  try {
    await copyFile(join(root, 'deploy/local/compose.yaml'), join(dir, 'compose.yaml'));
    await copyFile(join(root, 'deploy/local/couchdb.ini'), join(dir, 'couchdb.ini'));
    // Production adds RAGFlow's network to the server, as compose.ragflow.yaml does.
    await writeFile(join(dir, 'compose.ragflow.yaml'), 'services:\n  server:\n    networks: [edge, database, ragflow-access]\nnetworks:\n  ragflow-access:\n    name: ragflow-access\n    external: true\n');
    const env = `${await readFile(join(root, 'deploy/local/.env.example'), 'utf8')}\nCOMPOSE_PROFILES=sandbox\nTABULARIUM_IMAGE=tabularium-server:test\n`;
    await writeFile(join(dir, '.env'), env);
    // What restore does to the copied environment file.
    const { isolatedEnvironment } = await import('../../deploy/backup/restore.ts');
    await writeFile(join(dir, '.env'), isolatedEnvironment(await readFile(join(dir, '.env'), 'utf8')));
    assert.equal((await readFile(join(dir, '.env'), 'utf8')).match(/^COMPOSE_PROFILES=.*$/gm).join(), 'COMPOSE_PROFILES=');
    const files = [join(dir, 'compose.yaml'), join(dir, 'compose.ragflow.yaml')];
    const original = await new Compose(files, join(dir, '.env'), 'isolation').config();
    assert.deepEqual(Object.keys(original.services.server.networks).sort(), ['database', 'edge', 'ragflow-access', 'sandbox']);
    await writeFile(join(dir, 'compose.override.yaml'), isolatedOverride(original, 'tabularium-server:test', '18080'));
    const restored = await new Compose([...files, join(dir, 'compose.override.yaml')], join(dir, '.env'), 'isolation').config();
    assert.deepEqual(Object.keys(restored.services.server.networks).sort(), ['database', 'edge', 'sandbox'], 'the project networks stay');
    assert(!('sandbox' in restored.services), 'no profile, no sandbox');
    assert.equal(restored.services.server.image, 'tabularium-server:test');
    assert.equal(restored.services.server.environment.TABULARIUM_BACKUP_DIR, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
