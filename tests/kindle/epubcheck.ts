// Runs EPUBCheck on a file, prints every message and returns the number of errors.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const exec = promisify(execFile);
const jar = resolve(import.meta.dirname, '../../.tools/epubcheck/epubcheck-5.2.1/epubcheck.jar');

export async function epubErrors(file: string) {
  await exec('unzip', ['-tq', file]);
  const report = `${file}.json`;
  await exec('java', ['-jar', jar, file, '--json', report]).catch(() => undefined);
  const { messages } = JSON.parse(await readFile(report, 'utf8')) as { messages: { severity: string; ID: string; message: string; locations: { path: string }[] }[] };
  for (const m of messages) console.log(`${m.severity} ${m.ID} ${m.message} (${m.locations.map(l => l.path).join(', ')})`);
  const errors = messages.filter(m => ['ERROR', 'FATAL'].includes(m.severity));
  console.log(`${basename(file)}: ${errors.length} errors, ${messages.length - errors.length} other messages`);
  return errors.length;
}
