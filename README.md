# Tabularium

English · [中文](README.zh-CN.md) · [Lingua Latīna](README.la.md)

Tabularium is a self-hosted server for synchronising Obsidian vaults with end-to-end encryption, together with the Obsidian plug-in that connects to it. Notes are encrypted on each device before they are uploaded; the server stores them in CouchDB and cannot read them. Registration is closed: an administrator creates the accounts.

Besides synchronisation, the server provides a web app: an administration console, a browser client for reading and editing notes (decrypted in the browser), shared note pages, sending notes to a Kindle, scheduled backups, and Tabularius, an optional AI curator that a vault owner can enable for one vault at a time.

Version 0.24.5. The project is in active development and is not yet published under a licence of its own; see Licences below.

## Repositories

This is the parent repository. The server and the plug-in are submodules with their own repositories:

| Path | Repository | Contents |
| --- | --- | --- |
| `apps/server` | [Tabularium-Server](https://github.com/Violaria/Tabularium-Server) | Node.js gateway, SQLite application database, web app, Tabularius |
| `apps/obsidian` | [Tabularium-Obsidian](https://github.com/Violaria/Tabularium-Obsidian) | Obsidian plug-in, a fork of Self-hosted LiveSync; also the source of the browser client and of the LiveSync CLI the server runs |
| `packages/custom-sort` | here | File Explorer sorting from Custom File Explorer sorting, packaged for the plug-in |
| `deploy/` | here | Compose files, backup, restore, upgrade and rollback tools, release build |
| `tests/` | here | Tests across components: real-client synchronisation, Tabularius end to end, backups, release packages |

The server image is built from both submodules, so build and test from this repository.

## Building

Node.js 24.10.0 and npm 11.6.1 are required (see `.nvmrc` and `engines` in `package.json`); Docker with Compose 2.24 or later is needed for the server and most tests.

```bash
git clone --recurse-submodules git@github.com:Violaria/Tabularium.git
cd Tabularium
npm run bootstrap   # dependencies of the workspace, the sorting package and the plug-in
npm run build       # server, sorting package, plug-in main.js, CLI
npm run check       # type checks and lint for everything
```

Tests:

| Command | Covers |
| --- | --- |
| `npm run test:server` | gateway and API against a real CouchDB |
| `npm run test:server:browser` | administration console in a headless browser |
| `npm run test:unit` | plug-in unit tests |
| `npm run test:tabularius` | Tabularius end to end, with scripted model providers |
| `npm run test:backup` | backup, restore and scheduled backups |
| `npm run test:gateway` | synchronisation regression with real clients (needs desktop Obsidian) |
| `npm run test:release` | a clean install from the built release package |

## Running locally

```bash
cp deploy/local/.env.example deploy/local/.env
# set the three passwords; the administrator's initial password needs at least 12 characters
docker compose --env-file deploy/local/.env -f deploy/local/compose.yaml up --build -d --wait
curl http://127.0.0.1:3000/health/ready
```

Open `http://127.0.0.1:3000/`, sign in as `admin` and change the password. Runtime settings (email, sharing, AI providers, backups) are configured on the web pages; `.env` only holds what the containers need before they start.

## Releases and installation

`npm run release` writes `release/<version>/`: the server image as a tar file, the plug-in as a zip, the deployment directory (`compose.yaml`, `couchdb.ini`, `.env.example`, `backup/`), third-party licences and checksums. On the target host:

```bash
cd release/<version>
sha256sum -c SHA256SUMS
docker load -i tabularium-server-<version>.tar
docker tag tabularium-server:<version> tabularium-server
cd deploy
cp .env.example .env    # fill in the passwords and TABULARIUM_PUBLIC_URL
docker compose -p tabularium --env-file .env up -d --wait
```

The gateway listens on `127.0.0.1` only. Put an HTTPS reverse proxy in front of it that does not buffer responses (the synchronisation change feed is a long-lived stream), has a read timeout longer than the gateway's five-minute connection limit, and accepts request bodies of 64 MiB. For nginx: `proxy_buffering off`, `proxy_request_buffering off`, `proxy_read_timeout 600s`, `client_max_body_size 64m`.

Install the plug-in by copying `main.js`, `manifest.json` and `styles.css` from the zip into `.obsidian/plugins/tabularium/` and enabling it.

## Backups and upgrades

`deploy/backup/cli.ts` runs with Node.js 24.10.0 and no other dependencies:

```text
node deploy/backup/cli.ts backup   --compose <file>... --env-file <file> --project <name> --output <dir>
node deploy/backup/cli.ts verify   <backup-dir>
node deploy/backup/cli.ts restore  <backup-dir> --project <name> --target <dir> --port <port>
node deploy/backup/cli.ts restore-scheduled <backups-dir> <point-id> --image <image> --compose <file>... --env-file <file> --project <name> --target <dir> --port <port>
node deploy/backup/cli.ts upgrade  --image <image> --compose <file>... --env-file <file> --project <name> --output <dir>
node deploy/backup/cli.ts rollback <backup-dir> --compose <file>... --env-file <file> --project <name> --output <dir>
```

`backup` stops the services briefly and archives both data volumes and the image. `upgrade` takes such a backup, starts the new image on a copy first, then switches; `rollback` returns to the backup taken before an upgrade. Restores always go into a new Compose project, never over the running one. Scheduled backups are written by the server itself and configured under Admin → Backups.

## Licences

The plug-in keeps the MIT licence of Self-hosted LiveSync (copyright vorotamoroz); see `apps/obsidian/LICENSE`. The sorting package comes from Custom File Explorer sorting by SebastianMC; see `packages/custom-sort/UPSTREAM.md`. The licence for the rest of Tabularium has not been chosen yet. A release package lists every third-party dependency in `THIRD_PARTY_LICENSES.md`.
