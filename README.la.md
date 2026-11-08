# Tabularium

[English](README.md) · [中文](README.zh-CN.md) · Lingua Latīna

Tabularium est ministrator domi hospitatus qui tabularia commentariorum cryptographia ab extremo ad extremum synchronizat, una cum additamento Obsidian et consola interretiali quae ad eum conectunt. Commentarii in quoque instrumento cryptantur antequam mittuntur; ministrator eos in CouchDB servat nec legere potest. Inscriptio libera non est: rationes usorum ab administratore creantur.

Paginae interretiales etiam commentarios interretiales continent: commentarii in navigatro legi et emendari possunt, et pluribus modis in interrete publico communicari (ab omnibus aut sola tessera legendi, nexu ad tempus valido aut perpetuo); commentarios etiam ad Kindle tuum mittere potes. Communicatio commentariorum in interrete et missio ad Kindle etiam in additamento Obsidian praebentur.

Praeter synchronizationem paginae interretiales ministratoris administrationem, exempla tutelaria statuta et administratorem artificialem cui nomen est Tabularius (scribam tabularii) praebent, quem dominus tabularii singulis tabulariis accendere potest. Pluribus API (OpenAI, Anthropic, Google Gemini, DeepSeek) et machinis inferentiae exemplarium localiter institutorum (vLLM, Ollama, TensorRT-LLM) uti potest; rationes omnia mandata quae cuiusque praebitoris API accipit statuere possunt. Scribae etiam quaestionem RAG addere potes, si ministratorem RAGFlow instituisti.

## Facultates

### Synchronizatio

Synchronizatio protocollo replicationis CouchDB utitur. Nucleus synchronizationis clientis est `@tabularium/sync-core` in repositorio additamenti, quo additamentum Obsidian, commentarii interretiales et cliens lineae mandatorum communiter utuntur.

- **Forma datorum**: quodque tabularium in ministratore repositorium CouchDB proprium est, et quodque instrumentum repositorium locale suum habet. Mutationes plicarum primum in repositorium locale scribuntur, deinde cum ministratore utroque versu replicantur. Commentarius ut unum documentum metadatorum servatur (praefixo `f:`, quod frusta eius enumerat) et frusta contenti (praefixo `h:`, ex contento nominata, ita ut frusta paria semel serventur); mutato uno loco, sola frusta mutata mittuntur.
- **Synchronizatio viva**: clientes fluxum mutationum ministratoris sequuntur (`_changes` ut fluxum continuum aut interrogationem longam), ita ut mutationes aliorum instrumentorum intra paucas secundas adveniant. Additamentum vivo modo, ad tempus statutum aut per eventus (initium, servationem, mutationem plicae) synchronizare potest. Synchronizatio viva in singulis instrumentis suspendi potest: mutationes in instrumento manent et mittuntur cum resumitur aut «Synchroniza nunc» premitur.
- **Discrepantiae**: si duo instrumenta eundem commentarium diversis lineis mutant, mutationes sponte miscentur; si eundem locum, omnes versiones servantur. Additamentum versionem recentiorem servare potest; commentarii interretiales versiones iuxta ostendunt, ut unam servare aut textum mixtum emendare possis. Menu contextus additamenti «Historia versionum» versiones commentarii in instrumento enumerat, ut comparentur, exscribantur aut restituantur.
- **Porta**: clientes ad `/sync/<ID tabularii>/` conectunt, quod porta ad nomen repositorii physici a ministratore generatum refert. Sola puncta quibus replicatio eget admittit (fluxum mutationum, `_revs_diff`, `_bulk_get`, `_bulk_docs`, `_local` et cetera), corpus cuiusque scriptionis legit, sola documenta forma cryptata et viis obscuratis accipit, cetera singillatim reicit. Petitiones in singulis instrumentis limitantur; conexiones longae post quinque minuta finiuntur et cliens denuo conectit.
- **Rationes et instrumenta**: rationes usorum ab administratore in pagina creantur; tessera prima in primo ingressu mutatur. Quisque cliens (tabularium Obsidian aut profilum navigatri) ingrediens testimonium instrumenti proprium accipit, triginta dies validum, quod sponte renovatur cum minus quam quindecim dies supersunt; instrumentum triginta dies non adhibitum exspirat. «Ratio → Instrumenta» instrumenta per clientes cum tempore ultimae synchronizationis enumerat, ubi nominari aut revocari possunt; revocato instrumento, conexiones eius statim clauduntur.
- **Tabularium reaedificare**: ut ministrator commentariis unius instrumenti superscribatur, dominus tabularii primum illi instrumento fenestram quindecim minutorum concedit. Porta reaedificationem in novum repositorium physicum vertit et ad id transit, vetere servato ut redire possis; cetera instrumenta deinde «Tabularium clausum» nuntiant, a ministratore denuo accipiunt, et dominus tabularium reserat.
- **Cliens lineae mandatorum**: idem nucleus etiam ut cliens lineae mandatorum praebetur, qui tabularium in ministratore ut plicarum apertarum collectionem imitari potest, ad recensionem git aut scripta.

### Cryptographia

- Commentarii in instrumento cryptantur antequam in repositorium synchronizationis intrant. Tessera E2EE per PBKDF2-SHA256 (310 000 iterationes) in clavem principalem extenditur, ex qua HKDF clavem cuique frusto derivat, et frusta AES-256-GCM cryptantur. Sal PBKDF2 cum tabulario in ministratore servatur; tessera in quoque instrumento manet.
- Obscuratio viarum etiam vias plicarum cryptat, ita ut ID documentorum et metadata in ministratore nec nomina plicarum nec structuram tabularum ferant.
- Dum ad Tabularium conectit, additamentum cryptographiam (E2EE V2) et obscurationem viarum imponit, et ministrator sola documenta hac forma accipit; ita ministrator semper textum cryptatum tenet. Ministrator rationes, instrumenta, tempora petitionum et commeatum videt.
- Testimonium synchronizationis et tessera in `data.json` additamenti clave in solo instrumento servata cryptantur. Conexio tabulario Obsidian unde ingressus est alligatur; si plica additamenti in aliud tabularium exscribitur, conexio in initio deletur.
- Tabularius uni tabulario accensus ministratori tesseram eius (clave ministratoris cryptatam) et exemplum apertum dat; pagina hoc ante accensionem explicat, et exstinctio ea delet.

### Ordo plicarum

Scribe `Collation.md` in radice tabularii; index indentatus in corpore eius ordo indicis plicarum est:

```markdown
- Consilium operis —— primum consilium lege
  - Postulata
  - ...
  - Archivum
- Acta conventuum
- Collation
```

- Singula plicae aut tabulae, indentatio tabulam continentem significat. Res enumeratae primae ordine enumerato veniunt, ceterae ordine solito sequuntur, et `...` locum rerum non enumeratarum notat (supra «Archivum» semper ultimum est).
- Textus post ` —— ` hominibus scribitur; in lectione in iconem ⓘ post nomen conditur. Res ut `[[nomen]]` scribi possunt, ut clicu aperiantur; ceterus textus liber est.
- Tabula interior suam `Collation.md` habere potest, quae regulas superiores pro illa tabula mutat.
- Menu contextus «Ordo» indicis plicarum «Ad summum move», «Ad imum move» (quae indicem rescribunt) et «In Collation.md ostende» habet.
- Ordo solum ordinem ostensum mutat. Commentarius regularum ut ceteri synchronizatur, et index plicarum Obsidian, arbor commentariorum interretialium et index tabularum communicatarum eum sequuntur.

### Commentarii interretiales

Cliens commentariorum in navigatro, ad commentarios legendos et emendandos in computatro sine Obsidian.

- Synchronizatio et decryptio in navigatro fiunt, et quisque navigatrum instrumentum habetur. Commentarii in systemate plicarum privato navigatri (OPFS) et IndexedDB servantur, et tessera in sola memoria paginae vivit. Primus aditus totum tabularium accipit; postea solae mutationes synchronizantur.
- Lectio Obsidian similis est: callouts, indices officiorum, tabulae, formulae KaTeX, `==illuminationes==`, figurae Mermaid, et codicis frusta per linguam colorata (plus sexaginta linguae).
- Editor tres modos habet: redditionem vivam (ut Live Preview Obsidian), fontem et praevisionem divisam. Textu selecto, instrumentarium formae apparet, et menu «+» tabulas, codicis frusta, figuras Mermaid, formulas, callouts et adiuncta inserit. Commentarii duabus secundis post finem scribendi servantur, et titulus «Localiter servatum», «Sursum mittendum», «Synchronizatum» aut «Discrepantia» ostendit.
- Commentarios et tabulas crea, renomina, move, dele; renominatio aut motio nexus wiki et Markdown in aliis commentariis renovat. Adiuncta in editorem trahi possunt.
- Navigatrum paginas servat, ita ut tabularium plene acceptum sine rete reserari, legi et emendari possit; mutationes interea factae mittuntur cum rete redit.
- «Dele data localia» exemplum in hoc navigatro delet et instrumentum eius revocat; exitus idem offert.

### Communicatio

Commentarium aut tabulam in interrete communica: visitatores sine ratione in navigatro legunt. «Communica…» in menu «⋯» commentariorum interretialium et in menu contextus Obsidian est.

- **Duo genera**: nexus cryptatus (praefinitus) in instrumento ante missionem cryptatur, clavis in sola parte nexus post `#` est, et ministrator textum cryptatum servat. Pagina publica aperte servatur et machinis quaerendi indicari permittere potest (tum pagina titulum et descriptionem circiter 160 litterarum fert).
- **Nexus**: `https://<dominium>/s/<inscriptio>`, inscriptione a te electa aut fortuita.
- **Validitas**: unus dies, septem, triginta, perpetua, aut ad diem electum; exacta validitate ministrator contentum communicatum delet.
- **Tessera aditus**: optionalis. In nexibus cryptatis tessera decryptioni interest; in paginis publicis ministrator eam probat.
- **Commentarii et adiuncta relata**: dialogus commentarios et adiuncta enumerat ad quae contentum communicatum refert sed quae extra id sunt, et ea gradatim notas; imagines et adiuncta inserta praefinito communicantur. Relationes non notatae in pagina communicata «Aditus nullus» ostendunt, nominibus, viis et textu nexus celatis.
- **Tabulae**: omnes commentarii et adiuncta tabulae communicantur, index per `Collation.md` ordinatur, et quisque commentarius inscriptionem stabilem habet.
- **Renovatio sponte**: circiter decem secundis postquam plica in communicatione mutatur, creatur, renominatur aut deletur, communicatio sub eodem nexu regeneratur. Instrumentum quod communicationem ultimum servavit renovat; communicatio commentarium renominatum aut motum sequitur, et deleto revocatur.
- **Sine exscriptione** (optionalis): pagina communicata textum, formulas, figuras et imagines in tabulam pictoriam (canvas) pingit, et paginae publicae quoque cryptatae transmittuntur; selectio, exscriptio, clicus dexter, tractio, impressio et compendia solita instrumentorum elaboratoris prohibentur.
- **Species**: paginae communicatae coloribus communicantis utuntur et ut commentarii interretiales redduntur, figuris Mermaid inclusis.
- **Administratio**: «Ratio → Communicata» omnes communicationes tuas cum numero aditionum enumerat, ubi validitatem mutare, eas revocare aut exspiratas purgare potes; administratores omnium communicationes in «Administratio → Communicata» curant.

### Contentum secretum et arcanum

In editore tesseram, signum aut nomen rationis selige et «Secretum» in instrumentario formae preme, aut iussum eiusdem nominis exsequere: signa invisibilia circa textum ponuntur. Lectio textum solitum ostendit; in modis emendandi Obsidian textus notatus colore subiecto et oculo rubro parvo distinguitur, et cursor signa uno gradu transit. Iterum adhibitum notam tollit; per plures lineas quaeque linea separatim notatur et syntaxis Markdown servatur.

Signa sunt tres operatores mathematici invisibiles Unicode: U+2061 (applicatio functionis), U+2062 (multiplicatio invisibilis), U+2063 (separator invisibilis). Signum initiale est U+2061 U+2062 U+2063 hoc ordine, signum finale ordine inverso U+2063 U+2062 U+2061. Pars notata intra unam lineam manet; si signum finale deest, usque ad finem lineae tegitur.

- **Communicatio**: «Secreta tege» praefinito accensum est, et textus notatus in `••••••` mutatur antequam instrumentum relinquit (etiam in codicis frustis), ita ut ministrator et visitatores solum signum vicarium accipiant. Dialogus quot loci tangantur ostendit.
- **Tabularius**: textus notatus in `[REDACTED]` mutatur antequam exemplari mittitur, et restituitur cum propositio commentarium rescribit.
- **Mitte ad Kindle**: textus originalis sine signis ostenditur.

### Mitte ad Kindle

Additamentum et commentarii interretiales ex commentariis in instrumento librum EPUB 3 conficiunt (titulus, index ex titulis secundi gradus, imagines PNG/JPEG/GIF, codicis frusta, EPUBCheck probatus), et ministrator eum per rationem SMTP ab administratore constitutam ad inscriptionem Kindle usoris mittit. Unum commentarium, tabulam (quaeque tabula interior pars fit), aut plura selecta singula ut libros mittere potes. Ministrator dominium inscriptionis Kindle, limitem 50 MB et numerum diurnum cuiusque usoris probat, et de quaque missione solum tempus, nomen plicae, magnitudinem et exitum servat.

### Additamentum Obsidian

ID additamenti est `tabularium`; Obsidian 1.13 vel recentius requirit et in computatris et telephonis operatur.

- **Ingressus**: inscriptionem ministratoris, nomen usoris et tesseram insere, tabularium elige aut crea, tesseram E2EE scribe; additamentum instrumentum emittit et conexionem implet. Instrumentum quod iam commentarios habet ministratorem sequi aut tempora mutationis comparare potest.
- **Optiones**: Conexio, Synchronizatio, Ordo plicarum, Ad Kindle mittere, Scriptor, Species, Cura, Auxilium; quaeque res quaestione optionum Obsidian inveniri potest. Paginae auxilii et historia versionum cum additamento veniunt.
- **Cura**: a ministratore denuo accipere, ministratori hoc instrumento superscribere, reserare, relatio diagnostica, plicas imperfectas invenire, in omnibus discrepantiis recentiorem servare. Actiones periculosae unum dialogum confirmationis communem habent, qui effectum in cetera instrumenta dicit.
- **Emendatio**: idem instrumentarium formae ac commentarii interretiales («Secretum» incluso) et menu contextus «Insere»; quaeque res iussum est cui compendium claviaturae assignari potest.
- **Nexus fracti**: «Nexus fractos inspicere» nexus ad plicas absentes enumerat et plicas eiusdem nominis ut fines proponit; «Nexus fractos sponte reficere» in uno instrumento semper accenso accendi potest.
- Ordo plicarum, communicatio, missio ad Kindle et suspensio synchronizationis vivae omnes in menu contextus indicis plicarum sunt.

### Tabularius (scriba)

Administrator commentariorum artificialis singulis tabulariis accensus, sub «Tabularius» in applicatione interretiali.

- **Quaestiones et inquisitio**: ministrator clientem hospitatum pro tabulario agit, exemplum apertum synchronizat et indicat (inquisitio totius textus SQLite FTS5 cum inquisitione embedding optionali, duobus eventuum indicibus mixtis). Responsa paulatim apparent, et commentarii citati clicu in commentariis interretialibus aperiuntur.
- **Ordinatio et propositiones**: ut commentarios ordinet, renominet, moveat aut deleat, propositionem cum diff cuiusque plicae submittit; tu eam recenses et totam adhibes aut abicis. Ante adhibitionem quaeque plica probatur num alibi mutata sit; motiones et renominationes nexus ad eas ducentes renovant; tempora mutationis sunt tempus adhibitionis. Regulae ordinandi in mandatis ministratoris et tabularii scribuntur et curam `Content.md` cuiusque tabulae et `Collation.md` radicis complecti possunt.
- **Praebitores et rationes**: Anthropic, OpenAI, Google Gemini, DeepSeek, et vLLM, Ollama, TensorRT-LLM localia. Indices exemplarium ex API praebitorum leguntur. Ratio exemplar, parametra et mandatum additum coniungit; forma eius omnia parametra quae cuiusque praebitoris API officialis accipit enumerat, et colloquium ea super rationem accommodare potest.
- **Colloquia**: adiuncta imaginum, plicarum textus et PDF; incepta et archivum; memoria per colloquia (per rationem servata, in pagina curata); inquisitio colloquiorum priorum; colloquia longa modo cuiusque praebitoris contracta aut decurtata.
- **Verificatio per rete**: versiones, iussa, parametra et nexus commentarii singillatim probat, quodque ut congruens, obsoletum, falsum aut non verificabile aestimat, et fontes enumerat. Claude, OpenAI et Gemini inquisitione propria utuntur; cetera exemplaria SearXNG ministratoris.
- **Harenarium et SSH**: codicem et iussa ex commentariis in continente semel adhibito exsequitur (opibus et tempore limitatis, praefinito sine rete), et iussa per SSH in hospitibus ab administratore inscriptis intra gradum permissionis exsequitur.
- **Gradus permissionis**: tantum lectio, restrictus (iussa permissa et inscriptiones internae inscriptae) et plenus, a ministratore terminati. Hospites ut «vetiti» inscripti in nullo gradu attingi possunt, et mutationes commentariorum semper per propositiones fiunt.
- **Quid mittatur**: viae exclusae ab indice et a petitionibus ad praebitorem absunt; regulae tegendi (expressiones regulares RE2, praefinito claves API usitatas, claves privatas et valores ut `password:` complectentes) testimonia in `[REDACTED]` mutant.
- **Thesaurus scientiae localis**: inquisitio RAGFlow per MCP, et embedding ex servitio locali.

### Applicatio interretialis et administratio

Una pagina ingressus et una forma communis: Domus, Commentarii interretiales, Tabularius et Ratio, et administratoribus Administratio.

- **Domus**: status tabulariorum, tempus ultimae synchronizationis cuiusque instrumenti, spatium occupatum, commentarii et colloquia recentia, summarium ministratoris.
- **Ratio**: tabularia (concessio reaedificationis, reseratio), instrumenta, communicata, inscriptio Kindle, tessera, et facies (lingua et colores: Rosa, Silva, Lavandula, et quotlibet colores proprii).
- **Administratio**: rationes usorum, tabularia, instrumenta, usus, status ministratoris et acta; «Optiones ministri» (epistulae et Kindle, communicatio, vita sessionum et instrumentorum, limites petitionum, retentio actorum); «Optiones LLM» (praebitores, rationes, mandata, embedding, aditus ad rete, summus gradus permissionis, hospites SSH, harenarium); «Communicata»; «Exempla tutelaria». Omnes optiones currentes hic mutantur et statim valent.
- **Exempla tutelaria statuta**: ministrator exempla incrementalia sine intermissione cotidie, hebdomadatim aut menstrue facit, cum tempore, zona temporis, numero servandorum et intervallo exemplorum plenorum; quodque punctum post magnitudinem et SHA-256 probata publicatur, et defectus in pagina «Conspectus» notatur.
- Additamentum et omnes paginae interretiales Anglice, Sinice et Latine praebentur.

## Repositoria codicis

Hoc est repositorium parens. Ministrator et additamentum submoduli sunt cum repositoriis suis:

| Via | Repositorium | Contentum |
| --- | --- | --- |
| `apps/server` | [Tabularium-Server](https://github.com/Violaria/Tabularium-Server) | porta Node.js, repositorium applicationis SQLite, applicatio interretialis, Tabularius |
| `apps/obsidian` | [Tabularium-Obsidian](https://github.com/Violaria/Tabularium-Obsidian) | additamentum Obsidian; etiam fons commentariorum interretialium et clientis lineae mandatorum quo ministrator utitur |
| `deploy/` | hic | plicae Compose, instrumenta exemplorum tutelarium, restitutionis, renovationis et reversionis, constructio editionis |
| `tests/` | hic | probationes per partes: synchronizatio cum clientibus veris, Tabularius ab initio ad finem, exempla tutelaria, fasciculi editionis |

Imago ministratoris ex ambobus submodulis construitur; ergo hic construe et proba.

## Constructio

Requiruntur Node.js 24.10.0 et npm 11.6.1 (vide `.nvmrc` et `engines` in `package.json`); Docker cum Compose 2.24 vel recentiore ministratori et plerisque probationibus opus est.

```bash
git clone --recurse-submodules git@github.com:Violaria/Tabularium.git
cd Tabularium
npm run bootstrap   # dependentiae spatii laboris et additamenti
npm run build       # ministrator, main.js additamenti, CLI
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
