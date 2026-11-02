import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TemporaryVault } from '../../apps/obsidian/test/e2e-obsidian/runner/vault.ts';
import { startObsidianSession, type ObsidianSession } from '../../apps/obsidian/test/e2e-obsidian/runner/session.ts';
import { createE2eObsidianDeviceLocalState, waitForCoreReady } from '../../apps/obsidian/test/e2e-obsidian/runner/syncWorkflow.ts';
import { evalObsidianJson } from '../../apps/obsidian/test/e2e-obsidian/runner/cli.ts';

/** Keeps the pinned Obsidian runtime: without this the app downloads and loads a newer build into the temporary profile. */
export async function pinObsidianRuntime(vault: TemporaryVault) {
  for (const path of [join(vault.homePath, '.config/obsidian'), join(vault.xdgConfigPath, 'obsidian'), join(vault.homePath, 'Library/Application Support/obsidian'), vault.userDataPath]) {
    const registry = join(path, 'obsidian.json');
    await writeFile(registry, JSON.stringify({ ...JSON.parse(await readFile(registry, 'utf8')), updateDisabled: true }, null, 4));
  }
}

export async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 90_000, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out${last ? `: ${String(last)}` : ''}`);
}

/** Starts Obsidian with an unconfigured Tabularium plug-in. */
/** Starts Obsidian with the plug-in; `pluginData` is written to its data.json first (settings left by an earlier start). */
export async function startTabularium(vault: TemporaryVault, obsidianCli: string, pluginData: Record<string, unknown> = {}) {
  await pinObsidianRuntime(vault);
  const session = await startObsidianSession({ binary: process.env.OBSIDIAN_BINARY!, cliBinary: obsidianCli, vault, pluginData, localStorageEntries: createE2eObsidianDeviceLocalState(vault.name) });
  await until(() => evalObsidianJson<boolean>(obsidianCli, "(async()=>JSON.stringify(Boolean(app.plugins.plugins['tabularium']?.tabularium)))()", session.cliEnv));
  return session;
}

// Answers upstream's fetch questions for a device whose vault starts empty.
const confirmations = ['Overwrite all with remote files', 'Keep local files even if not on remote'];

/**
 * connect() ends by reloading Obsidian, so it is started without waiting and the reload is awaited separately: a mark
 * left on the old page tells it apart from the reloaded one, since a device that was already configured reports ready
 * before the reload. `buttons` adds answers for dialogues a particular start is expected to show.
 */
export async function connectTabularium(session: ObsidianSession, obsidianCli: string, options: Record<string, unknown>, buttons: string[] = []) {
  await evalObsidianJson(obsidianCli, `(async()=>{window.__tabulariumConnecting=true;window.__tabulariumLogin=app.plugins.plugins['tabularium'].tabularium.connect(${JSON.stringify(options)}).then(()=>'done',e=>'error: '+e.message);return JSON.stringify(true);})()`, session.cliEnv);
  await until(async () => {
    await evalObsidianJson(obsidianCli, `(async()=>{for(const b of document.querySelectorAll('.modal button'))if(${JSON.stringify([...confirmations, ...buttons])}.includes(b.textContent?.trim()))b.click();return JSON.stringify(true);})()`, session.cliEnv);
    if (await evalObsidianJson<boolean>(obsidianCli, "(async()=>JSON.stringify(Boolean(window.__tabulariumConnecting)))()", session.cliEnv).catch(() => true)) return false;
    return (await waitForCoreReady(obsidianCli, session.cliEnv, 5000)).appReady;
  }, 120_000).catch(async (error) => {
    // Shows what the app is waiting for: open dialogues and their buttons.
    const dialogues = await evalObsidianJson(obsidianCli, "(async()=>JSON.stringify([...document.querySelectorAll('.modal')].map(m=>({title:m.querySelector('.modal-title')?.textContent,text:m.textContent?.slice(0,600),buttons:[...m.querySelectorAll('button')].map(b=>b.outerHTML.slice(0,300))}))))()", session.cliEnv).catch(String);
    throw new Error(`${(error as Error).message}\nOpen dialogues: ${JSON.stringify(dialogues)}`);
  });
}
export type { ObsidianSession, TemporaryVault };
