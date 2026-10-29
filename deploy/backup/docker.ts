import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);

export async function docker(args: string[]) {
  try {
    return (await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new Error(`docker ${args.slice(0, 3).join(' ')}: ${(stderr || message).trim()}`);
  }
}

export async function requireCompose() {
  const version = (await docker(['compose', 'version', '--short'])).trim().replace(/^v/, '');
  const [major, minor] = version.split('.').map(Number);
  if (major < 2 || (major === 2 && minor < 24)) throw new Error(`Docker Compose ${version} is older than 2.24`);
  return version;
}

interface ComposeService {
  image?: string;
  environment?: Record<string, string>;
  volumes?: { type: string; source: string; target: string }[];
}
export interface ComposeConfig { services: Record<string, ComposeService>; volumes: Record<string, { name: string }> }
export interface ContainerState { id: string; running: boolean; exitCode: number }

export class Compose {
  readonly files: string[];
  readonly envFile: string;
  readonly project: string;
  constructor(files: string[], envFile: string, project: string) {
    this.files = files.map(file => resolve(file)); this.envFile = resolve(envFile); this.project = project;
  }
  get directory() { return dirname(this.files[0]); }
  run(...args: string[]) {
    return docker(['compose', ...this.files.flatMap(file => ['-f', file]), '--env-file', this.envFile, '-p', this.project, ...args]);
  }
  async config() { return JSON.parse(await this.run('config', '--format', 'json')) as ComposeConfig; }
  volume(config: ComposeConfig, service: string, target: string) {
    const mount = config.services[service].volumes?.find(v => v.type === 'volume' && v.target === target);
    if (!mount) throw new Error(`Service ${service} has no volume at ${target}`);
    return config.volumes[mount.source].name;
  }
  async state(service: string): Promise<ContainerState | undefined> {
    const line = (await this.run('ps', '-a', '--format', 'json', service)).trim().split('\n')[0];
    if (!line) return undefined;
    const row = JSON.parse(line) as { ID: string; State: string; ExitCode: number };
    return { id: row.ID, running: row.State === 'running', exitCode: row.ExitCode };
  }
  // Runs a CouchDB request inside the container with its own administrator environment, so no secret reaches the host command line.
  async couch(path: string) {
    return JSON.parse(await this.run('exec', '-T', 'couchdb', 'sh', '-c',
      'curl -sf -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://127.0.0.1:5984$1"', 'sh', path));
  }
}

export async function volumeExists(name: string) {
  try { await docker(['volume', 'inspect', name]); return true; } catch { return false; }
}
