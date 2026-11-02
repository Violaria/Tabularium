# Tabularium

[English](README.md) · [中文](README.zh-CN.md) · Lingua Latīna

Tabularium est ministrator domi hospitatus qui tabularia Obsidian cryptographia ab extremo ad extremum synchronizat, una cum additamento Obsidian quod ad eum conectit. Commentarii in quoque instrumento cryptantur antequam mittuntur; ministrator eos in CouchDB servat nec legere potest. Inscriptio libera non est: rationes usorum ab administratore creantur.

Praeter synchronizationem ministrator applicationem interretialem praebet: consolam administrationis, commentarios interretiales qui in navigatro leguntur et emendantur (in navigatro decryptos), paginas commentariorum communicatorum, missionem ad Kindle, exempla tutelaria statuta, et curatorem artificialem optionalem cui nomen est Tabularius, quem dominus tabularii singulis tabulariis accendere potest.

Versio 0.24.5. Opus adhuc strenue excolitur nec sub licentia sua iam editum est; vide infra «Licentiae».

## Repositoria codicis

Hoc est repositorium parens. Ministrator et additamentum submoduli sunt cum repositoriis suis:

| Via | Repositorium | Contentum |
| --- | --- | --- |
| `apps/server` | [Tabularium-Server](https://github.com/Violaria/Tabularium-Server) | porta Node.js, repositorium applicationis SQLite, applicatio interretialis, Tabularius |
| `apps/obsidian` | [Tabularium-Obsidian](https://github.com/Violaria/Tabularium-Obsidian) | additamentum Obsidian, ramus Self-hosted LiveSync; etiam fons commentariorum interretialium et LiveSync CLI quo ministrator utitur |
| `packages/custom-sort` | hic | ordinatio indicis plicarum ex Custom File Explorer sorting, ad usum additamenti composita |
| `deploy/` | hic | plicae Compose, instrumenta exemplorum tutelarium, restitutionis, renovationis et reversionis, constructio editionis |
| `tests/` | hic | probationes per partes: synchronizatio cum clientibus veris, Tabularius ab initio ad finem, exempla tutelaria, fasciculi editionis |

Imago ministratoris ex ambobus submodulis construitur; ergo hic construe et proba.

## Constructio

Requiruntur Node.js 24.10.0 et npm 11.6.1 (vide `.nvmrc` et `engines` in `package.json`); Docker cum Compose 2.24 vel recentiore ministratori et plerisque probationibus opus est.

```bash
git clone --recurse-submodules git@github.com:Violaria/Tabularium.git
cd Tabularium
npm run bootstrap   # dependentiae spatii laboris, fasciculi ordinationis et additamenti
npm run build       # ministrator, fasciculus ordinationis, main.js additamenti, CLI
npm run check       # examina typorum et lint omnium
```

Probationes:

| Iussum | Quid probatur |
| --- | --- |
| `npm run test:server` | porta et API contra CouchDB verum |
| `npm run test:server:browser` | consola administrationis in navigatro sine facie |
| `npm run test:unit` | partes singulae additamenti |
| `npm run test:tabularius` | Tabularius ab initio ad finem, praebitoribus exemplarium scriptis |
| `npm run test:backup` | exempla tutelaria, restitutio et exempla statuta |
| `npm run test:gateway` | synchronizatio cum clientibus veris, ne quid regrediatur (Obsidian in computatro requiritur) |
| `npm run test:release` | institutio nova ex fasciculo editionis constructo |

## Usus localis

```bash
cp deploy/local/.env.example deploy/local/.env
# tres tesseras constitue; tessera prima administratoris saltem 12 characteres habeat
docker compose --env-file deploy/local/.env -f deploy/local/compose.yaml up --build -d --wait
curl http://127.0.0.1:3000/health/ready
```

Aperi `http://127.0.0.1:3000/`, ut `admin` inito et tesseram muta. Optiones cursus (epistulae, communicatio, praebitores AI, exempla tutelaria) in paginis interretis constituuntur; `.env` ea tantum continet quibus continentia ante initium egent.

## Editiones et institutio

`npm run release` `release/<versio>/` scribit: imaginem ministratoris ut plicam tar, additamentum ut zip, capsam instructionis (`compose.yaml`, `couchdb.ini`, `.env.example`, `backup/`), licentias tertiorum et summas probatorias. In hospite destinato:

```bash
cd release/<versio>
sha256sum -c SHA256SUMS
docker load -i tabularium-server-<versio>.tar
docker tag tabularium-server:<versio> tabularium-server
cd deploy
cp .env.example .env    # tesseras et TABULARIUM_PUBLIC_URL imple
docker compose -p tabularium --env-file .env up -d --wait
```

Porta tantum in `127.0.0.1` auscultat. Ante eam pone procuratorem inversum HTTPS qui responsa non retinet (fluxus mutationum synchronizationis conexio diuturna est), cuius tempus legendi quinque minuta portae excedit, et qui corpora petitionum 64 MiB accipit. Pro nginx: `proxy_buffering off`, `proxy_request_buffering off`, `proxy_read_timeout 600s`, `client_max_body_size 64m`.

Additamentum instituitur plicas `main.js`, `manifest.json` et `styles.css` ex zip in `.obsidian/plugins/tabularium/` exscribendo et id accendendo.

## Exempla tutelaria et renovationes

`deploy/backup/cli.ts` cum Node.js 24.10.0 currit, nullis aliis dependentiis:

```text
node deploy/backup/cli.ts backup   --compose <plica>... --env-file <plica> --project <nomen> --output <capsa>
node deploy/backup/cli.ts verify   <capsa-exempli>
node deploy/backup/cli.ts restore  <capsa-exempli> --project <nomen> --target <capsa> --port <portus>
node deploy/backup/cli.ts restore-scheduled <capsa-exemplorum> <punctum> --image <imago> --compose <plica>... --env-file <plica> --project <nomen> --target <capsa> --port <portus>
node deploy/backup/cli.ts upgrade  --image <imago> --compose <plica>... --env-file <plica> --project <nomen> --output <capsa>
node deploy/backup/cli.ts rollback <capsa-exempli> --compose <plica>... --env-file <plica> --project <nomen> --output <capsa>
```

`backup` officia breviter sistit et ambo volumina datorum cum imagine in archivum condit. `upgrade` tale exemplum facit, imaginem novam primum in copia experitur, deinde commutat; `rollback` ad exemplum ante renovationem factum redit. Restitutiones semper in novum inceptum Compose fiunt, numquam super currens. Exempla statuta ab ipso ministratore scribuntur et sub «Administratio → Exempla tutelaria» constituuntur.

## Licentiae

Additamentum licentiam MIT Self-hosted LiveSync servat (iura auctoris vorotamoroz); vide `apps/obsidian/LICENSE`. Fasciculus ordinationis ex Custom File Explorer sorting a SebastianMC venit; vide `packages/custom-sort/UPSTREAM.md`. Licentia reliqui Tabularii nondum electa est. Fasciculus editionis omnes dependentias tertiorum in `THIRD_PARTY_LICENSES.md` enumerat.
