import { parseArgs } from 'node:util';
import { backup, verify } from './archive.ts';
import { restore } from './restore.ts';
import { rollback, upgrade } from './upgrade.ts';

const usage = `Usage:
  node deploy/backup/cli.ts backup   --compose <file> --env-file <file> --project <name> --output <dir>
  node deploy/backup/cli.ts verify   <backup-dir>
  node deploy/backup/cli.ts restore  <backup-dir> --project <name> --target <dir> --port <port>
  node deploy/backup/cli.ts upgrade  --image <image> --compose <file> --env-file <file> --project <name> --output <dir>
  node deploy/backup/cli.ts rollback <backup-dir> --compose <file> --env-file <file> --project <name> --output <dir>`;
const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
  compose: { type: 'string' }, 'env-file': { type: 'string' }, project: { type: 'string' },
  output: { type: 'string' }, target: { type: 'string' }, port: { type: 'string' }, image: { type: 'string' },
} });
function need(name: keyof typeof values) {
  if (!values[name]) { console.error(usage); process.exit(2); }
  return values[name] as string;
}
const deployment = () => ({ compose: need('compose'), envFile: need('env-file'), project: need('project'), output: need('output') });
const print = (report: unknown) => console.log(JSON.stringify(report, null, 2));
try {
  if (command === 'backup') {
    const report = await backup(deployment());
    print(report);
    process.exitCode = report.backup.ok && report.source.ok ? 0 : 1;
  } else if (command === 'verify' && positionals.length === 1) {
    const { path, manifest } = await verify(positionals[0]);
    print({ ok: true, path, id: manifest.id, files: manifest.files.length });
  } else if (command === 'restore' && positionals.length === 1) {
    print((await restore(positionals[0], { project: need('project'), target: need('target'), port: need('port') })).report);
  } else if (command === 'upgrade' && positionals.length === 0) {
    const report = await upgrade({ ...deployment(), image: need('image') });
    print(report);
    process.exitCode = report.ok ? 0 : 1;
  } else if (command === 'rollback' && positionals.length === 1) {
    const report = await rollback(positionals[0], deployment());
    print(report);
    process.exitCode = report.ok ? 0 : 1;
  } else { console.error(usage); process.exitCode = 2; }
} catch (error) {
  print({ ok: false, error: (error as Error).message });
  process.exitCode = 1;
}
