import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';

/** Keeps the pinned Obsidian runtime: without this the app downloads and loads a newer build into the temporary profile. */
export async function pinObsidianRuntime(vault: TemporaryVault) {
  for (const path of [join(vault.homePath, '.config/obsidian'), join(vault.xdgConfigPath, 'obsidian'), join(vault.homePath, 'Library/Application Support/obsidian'), vault.userDataPath]) {
    const registry = join(path, 'obsidian.json');
    await writeFile(registry, JSON.stringify({ ...JSON.parse(await readFile(registry, 'utf8')), updateDisabled: true }, null, 4));
  }
}
