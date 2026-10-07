# Remote connections — punto di ripartenza

## Directory e computer abbinati — 7 ottobre 2026

La lista “Computers you can control” usava l'intera directory account: vecchie
installazioni con lo stesso hostname comparivano come duplicati e proponevano
Connect senza pairing locale. Il MacBook corrente era già escluso; l'altra
riga era una vecchia installazione. Ora `hosts.listConnections` espone gli ID
dei pairing confermati nello scope controller/account/workspace, separati
dalle connessioni attive e da quelle da riconnettere automaticamente. La UI
incrocia host ID e environment ID, esclude il controller e conserva i pairing
disconnessi. Nessuna fusione per hostname, cancellazione account o migrazione.
Client nuovi con server precedenti chiedono l'aggiornamento invece di mostrare
la directory come se fosse già abbinata. Add continua a usare il codice.

Verifica iniziale: regressione browser riprodotta prima del fix (due righe
Mini), poi 7 test browser e 13 test server passati; fmt/lint/typecheck passati
(928 warning lint preesistenti, zero errori). Il test SQLite verifica tutti i
confini dello scope, pending/revoked, disconnect e forget. Suite completa:
16.252 test passati, 251 saltati, 11/11 task riusciti. Build CLI/web/contratti
riuscita su entrambi i Mac.

MacBook: patch applicata alla vera Synara (Dev), account e pairing conservati;
RPC espone solo il Mini corrente e la UI mostra una sola riga anche offline.
Durante l'auto-rebuild del desktop Mini il backend si era fermato e il tunnel
rispondeva 530. Dopo lo sblocco, l'avviso ha identificato un digest delle
migrazioni incorporato dal vecchio watcher non allineato al checkout: il
controllo ha fermato l'avvio **prima di aprire il database**. Arrestato il vecchio
runner, eseguito `bun run build:desktop` (4/4 task riusciti) e riavviato
`bun run dev:desktop --home-dir ./.synara/phone-playground`, dopo dry-run e
verifica delle porte. Home, account e pairing conservati, nessun bypass o reset.

Verifica conclusa nelle app native: Mini startupReady con proiezioni sane;
MacBook health remoto 200, un solo Mini connesso via Cloudflare e Open apre
la chat demo con la risposta storica `MACBOOK TO MINI OK`. Nessun nuovo turno
provider né login. App lasciate aperte. Screenshot MacBook nella cartella
`~/.local/share/synara-tests/remote-macbook-mvp-20261007/operator/`:
`paired-hosts-list-offline.jpg` e `paired-hosts-list-connected.jpg`.

## Account nella rail — 7 ottobre 2026

Ripristinato `AccountFooterControl`, rimasto importato ma non montato dopo il
passaggio alla rail. Sostituisce l'ingranaggio fisso con l'avatar del profilo
autenticato (foto o iniziali); da disconnessi mostra Sign in. Il menu esistente
conserva profilo, Connections, Settings e Sign out, e aggiunge Usage. Riutilizza
ProfileAvatar, SidebarIconButton e i menu condivisi, senza un secondo flusso
di autenticazione. Passati 11 test browser account/login, 28 test account e
tipografia, fmt/lint/typecheck; nessun logout delle sessioni reali per provarlo.

## App desktop MacBook — 7 ottobre 2026

- Avviata la vera app Electron Synara (Dev) dal checkout isolato MacBook,
  con asset compilati e backend gestito dal desktop. Home di test conservata
  e copiata in un backup privato prima del passaggio; Stable e Canary intatte.
- Trovato un difetto non visibile nel test web: la negoziazione del bridge
  remoto rispondeva 200 senza header CORS, impedendo al renderer `synara://app`
  di leggerla. La route remota ora riflette soltanto le origin già ammesse
  dalla policy esistente, come la negoziazione locale. Autenticazione e ruolo
  owner restano obbligatori secondo la configurazione; nessuna wildcard.
- Regressione sulla route HTTP reale: fallisce prima del fix per header assente,
  passa dopo. Verifica anche origin estranee, client non-owner, autenticazione
  mancante e risposte 426/503. Sul Mini passano 55 test mirati in 7 file,
  fmt, lint (928 warning, zero errori) e typecheck (12 package).
- Prova live sul MacBook: riapertura da Finder, account e pairing conservati;
  Connections apre il workspace Mini e carica progetti e chat. È una build
  locale di sviluppo, non un nuovo rilascio firmato o un aggiornamento Stable.

## Verifica live aggiuntiva — 7 ottobre 2026

- Mini: l'app Dev corrente conserva la home `.synara/phone-playground/dev`;
  Connections mostra una sessione iOS attiva via Cloudflare. Non è la vecchia
  istanza temporanea sulla porta 4775.
- Un nuovo turno reale Codex nella chat demo restituisce `MINI MVP CHECK OK`;
  il simulatore iPhone legge la stessa risposta e aggiorna il recap a 3 prompt.
  Nessun telefono fisico usato. La cartella demo vuota è stata inizializzata come
  repository Git indipendente: prima i checkpoint risalivano alla repo Synara
  esterna e fallivano sul percorso ignorato `.synara`. Il nuovo turno non produce
  quell'errore. È una correzione dell'ambiente demo, non del codice distribuito.
- MacBook: vecchio checkout e home `/private/tmp/synara-remote-macbook-20260929`
  assenti; nessun listener su 4776. I vecchi endpoint restituiscono 530 e non
  rappresentano il Mini corrente. Stable e Canary lasciate intatte.
- Ricreato un checkout isolato sul MacBook al commit `89b261503`, con home
  persistente dedicata e server Node 24 su 4778. Build web/CLI/contratti riuscita
  in 52 secondi. Configurata l'API trial esistente dopo aver rilevato che il
  default puntava al vecchio servizio account. Login Google e lettura directory
  riusciti; sessione conservata dopo riavvio del server isolato. Il Mini corrente
  risponde 200 con TLS verificato e DNS normale. Checkout MacBook:
  `/Users/emanueledipietro/.codex/worktrees/remote-macbook-mvp-20261007/synara`;
  home `/Users/emanueledipietro/.local/share/synara-tests/remote-macbook-mvp-20261007`.
- Nuovo pairing MacBook autorizzato e completato con la nuova identità della
  home isolata: il Mini mostra il MacBook fra i dispositivi autorizzati.
  Da Dia sul MacBook il workspace remoto si apre via Cloudflare; un turno reale
  nella chat demo del Mini restituisce `MACBOOK TO MINI OK`.
  Dopo ricostruzione del runtime senza diagnostica temporanea, riavvio del solo
  server isolato MacBook e reload di Dia, il Mini si riconnette e la risposta
  ricompare senza un nuovo pairing. Stable e Canary restano intatte.
- Individuata e corretta la doppia creazione del codice all'apertura di Add a
  device sotto React StrictMode: la seconda richiesta revocava il primo invito,
  ma la UI poteva mostrare proprio il codice revocato. La creazione iniziale
  avviene ora una sola volta per apertura; chiudere e riaprire genera un nuovo
  codice. Il test browser esistente riproduce il difetto prima del fix (2
  richieste invece di 1) e passa dopo; nessun bypass delle verifiche di pairing.
  La prova live usa un invito unico generato dall'RPC ufficiale del Mini.
- Verifiche mirate del fix: 7 test browser e 17 test ConnectionsRows passati;
  fmt, lint (928 warning, zero errori) e typecheck (12 package) passati. La suite
  completa documentata sotto precede questo fix UI e non è stata ripetuta.
- **Non ancora qualificato:** direzione Mini → nuova istanza MacBook, revoca
  live, sleep/wake e interruzioni di rete prolungate. Le approvazioni del vecchio test non sono
  state ereditate. Nessun telefono fisico usato.

## MVP backend e simulatori — 7 ottobre 2026

Checkpoint verificato sul desktop `b85257f6e`, iPhone `ee91d12` e iPad `8e8d1d1`.
Sostituisce le vecchie note che indicavano Inbox cloud non pubblicata.

- Supabase: applicate le migrazioni API 0016–0017, con hash/timestamp originali
  nel journal Drizzle. `inbox_recaps` appartiene al ruolo account dedicato,
  RLS attiva, nessun SELECT per `anon`/`authenticated`; tabelle sponsor intatte.
- API Cloudflare: Worker `b5c6be3a-1d49-48f6-9fc6-41bb58e38cf7`, immagine
  `synara-account-api-trial:mvp-20261007`, digest registry
  `sha256:2fe75916125ebd4adf20a7ab92c124cff2913865922c053378688a9d245d85f1`.
  Health/instance 200, Inbox senza sessione 401 (prima 404), profilo API/pagina 200.
  Binding e segreti precedenti conservati. Il rollback del container è il digest
  precedente `sha256:cc29bdc4ac33d31dc64b5f093d13b6a1de0f8e9fb6775d8fda5ea3fdffe079d4`;
  le migrazioni additive possono restare, senza cancellare lo storico.
- Salvataggio automatico verificato: tre recap reali del Mini, 5–7 ottobre,
  arrivati senza premere Save now. Letti da entrambi i simulatori; iPad appena
  autenticato li recupera senza una connessione attiva al Mac. Nessun seed
  manuale o accesso diretto al database dal client.
- Migrazione desktop: conservata la 131 ProjectSourceFolders già rilasciata,
  spostate le cinque migrazioni private a 132–136. Riconosciuta esplicitamente
  la vecchia sequenza privata 131–135, usando backup e recovery esistenti.
  Test verificano watermark, identità, pairing, revoche e connessioni disabilitate.
- Container: installer Bun eseguito nativamente su Apple Silicon; dipendenze
  limitate al runtime API (40 pacchetti). Layer node_modules da circa 3,21 GB
  a 85 MB. Avvio arm64 contro PostgreSQL usa la stessa ricetta e passa;
  amd64 verificato su Cloudflare, poiché Bun sotto QEMU locale va in SIGSEGV.

Verifiche: fmt/lint/typecheck passati (928 warning lint, zero errori); lineage
compatibile con 96 tag rilasciati. Suite workspace finale a concorrenza 2:
**16.462 passati, 39 saltati, 11 package riusciti**, con PostgreSQL isolato.
La prima suite e un rerun CUA hanno mostrato errori sensibili al timing;
nessuna assertion rimossa, rerun completo verde. Restano warning Swift 6/header
nelle build Debug iPhone e iPad, entrambe avviate su iOS/iPadOS 27.

Performance preliminari: 15 campioni a riposo nel simulatore iPhone Debug,
RSS 222,6–224,8 MiB, CPU media 0,98%, picco 7,3%. Cinque richieste calde per
endpoint dal Mini: mediana health 128 ms, instance 125,8 ms, rifiuto Inbox senza
sessione 122,9 ms. Questi numeri non misurano query Inbox autenticata, cold start,
FPS, batteria o prestazioni di un iPhone reale.

Limiti: telefono fisico mai usato. Nessuna prova 5G/reinstallazione reale,
nuovo pairing iPad o revoca live in questo checkpoint. Il vecchio pairing iPad
richiede ancora approvazione; la cronologia cloud è indipendente. Login reale
email-code e ripristino sessione iPhone verificati, ma WorkOS resta Staging.
Nessun passaggio a produzione WorkOS, pagamento, merge o TestFlight.

## Analytics in this monorepo — 5 October 2026

Dashboard, Worker, D1 migrations, legacy forwarder and tests now live in
[`apps/analytics`](../../../apps/analytics/README.md) on this branch/PR. The
separate repository PR #3 is historical; it is no longer a release dependency.
Source imported from `synara-beta-diagnostics` commit `c2fe29c`, including all
four Product sections. Existing Cloudflare resources and client URLs are retained.
Use the workspace commands for future builds and deployments.

Deploy dalla repo Synara (`67f9dec`) verificato: versione Worker
`29cd18af-d988-4d93-9a71-d31b91d0f0e6`, `/healthz` 200, API senza login 401,
dashboard autenticata funzionante. PR backend #3 chiusa come sostituita.
Suite finale a concorrenza 2: **16.102 passati, 251 saltati, 11 package riusciti**;
i salti includono 200 test PostgreSQL senza database isolato. Formatting, lint
(con warning), typecheck, CI contracts, build e dry-run Worker, install frozen
e lineage migrazioni passati. Due errori AppSnap di cleanup/timeout nel primo
giro parallelo non si ripetono nei 52 test isolati né nella suite finale.

Sender Swift reali dei due branch nativi verificati contro Worker/D1 locale:
5 eventi sintetici iOS e 5 iPadOS, filtri separati, consenso inizialmente spento,
coda svuotata e opt-out corretti. Nessuna nuova prova UI/simulatore o raccolta
globale dei completamenti nativi. Recap mobile aggiornati e pushati.

Aggiornato il **5 ottobre 2026**. I checkpoint datati sostituiscono gli stati precedenti solo per le superfici espressamente verificate. L'ultimo passaggio implementa le analytics di prodotto su desktop, iPhone/iPad e backend Cloudflare; i checkpoint precedenti restano storici.

## Contatori turni e provider — 5 ottobre 2026

Dashboard Product estesa con richieste accettate separate dai turni terminali
osservati, andamento giornaliero dei turni, riusciti/falliti/annullati e tabella
provider con token disponibili e numero di campioni. Mancanti restano sconosciuti,
zero dichiarati restano zero. Nessuna nuova migrazione o raccolta di nomi modello.
Corretto il server: il provider viene conservato su tutti i completamenti, invece
che sul solo Claude. La regressione Codex/Pi falliva prima e passa dopo il fix.

Passati 146 test projection/ingestion, formato/lint/typecheck workspace (warning
preesistenti, zero errori), 119 test Worker, typecheck e build backend. Verifica
Wrangler/D1 e browser locale con quattro turni sintetici: due riusciti, uno fallito,
uno annullato; richieste separate, provider e campioni token corretti.
Riutilizzati Stat, TableWrap, EChart e le tabelle/eventi esistenti.
Dashboard pubblicata: Worker `481d06ef-2370-4825-8323-c848e3004d78`, verificato
anche con cf CLI. Health 200, API senza sessione 401 e nuova vista autenticata
controllati online; nessun nuovo dato sintetico inserito in produzione.

Restano osservazioni desktop: manca una fonte unica sul computer che esegue il
turno per contare indipendentemente dai client e deduplicare tra dispositivi. Non
presentare i nuovi contatori come consumo globale completo. La correzione del
provider richiede la nuova build server/desktop; nessuna nuova build mobile qui.

## Implementazione analytics opt-in — 5 ottobre 2026

Implementati contratto, sender desktop, consenso locale in Settings → General → Privacy,
osservatori di navigazione/trasporto e parità nativa nei due branch mobili esistenti.
Il nuovo flusso è **spento per impostazione predefinita** in Stable/Beta e indipendente
sia dalle diagnostiche crash Beta sia dalle statistiche account/Inbox. Dettagli e limiti:
[contratto operativo](PRODUCT-ANALYTICS-AUDIT.md), [privacy](../../diagnostics.md#product-analytics).
Riutilizzati SettingsRow/SettingsSection/Switch, trasporto esistente e componenti nativi;
nuovi sender separati perché la diagnostica Beta non può diventare la raccolta Stable.

Backend nella [PR draft #3](https://github.com/Emanuele-web04/synara-beta-diagnostics/pull/3),
commit `fd9b3ce` con correzione di compatibilità `7f14dd0`: endpoint `/v1/product-events`, tabella D1 separata, dashboard Product
privata, deduplica UUID e cleanup limitato dei dati oltre 30 giorni. Allineati account
e ID D1 ai binding della versione live `cb10fe76`; conservata la verifica del segreto
per l'IP inoltrato sulle route diagnostiche legacy. Il confronto remoto conferma che
era pendente soltanto `0005_product_events.sql`. **Deploy completato con autorizzazione il 5 ottobre 2026**:
migrazione applicata in Synara Orgs e Worker live alla versione
`bd556f7d-088e-4d4c-adbf-b0d02d4ad4e3` (4 ottobre, 23:48 UTC).
Verificati health 200, dashboard API senza sessione 401, JSON malformato 400,
content type errato 415; un evento sintetico accettato, retry duplicato accettato zero,
evento visibile nella dashboard autenticata con durata 42 ms. Rimosso esclusivamente
il campione di prova e verificato zero righe residue. Segreti e binding esistenti
conservati; cron giornaliero installato (esecuzione temporizzata non ancora osservata).
Versione precedente per rollback Worker: `cb10fe76-56c7-4e00-ae25-0fe5f36a3167`;
la tabella additiva può restare. Questo deploy riguarda analytics, non le migrazioni Inbox.

Verifiche di implementazione:

- Formato, lint e typecheck desktop/workspace passati; warning preesistenti di lint.
- Suite workspace: 16.020 passati, 251 saltati, un errore nel recupero concorrente
  di un lock credenziali. Corretta la race `ENOENT` nella rilettura sotto guardia;
  i 10 test mirati di lock/account passano. La suite completa non è stata ripetuta
  dopo questa correzione circoscritta. I salti includono 200 test API senza PostgreSQL.
- 8 test sender/IPC e 86 test web/trasporto passati; test browser dello switch e del
  fallimento di salvataggio passato. Screenshot: `apps/web/src/components/settings/__screenshots__/product-analytics-consent.png` (generato, ignorato da Git).
- Sender desktop reale → Worker Wrangler locale → D1: tutti gli 8 tipi accettati,
  duplicati accettati zero, default-off e opt-out dopo riavvio senza invii,
  campi privati estranei esclusi. Nessun dato utente usato nel test.
- Worker: 118 test, typecheck, build e dry-run del deploy passati; HTTP locale controllato con auth,
  input malformati, duplicati, token parziali e cleanup di 10.001 righe sintetiche.
- iPhone/iPad: 197 test SwiftPM per branch e build iOS complete senza firma passati.
  Simulatore non disponibile in questa sessione: nuova UI mobile non provata dal vivo.

Limiti intenzionali: le completion sono osservazioni desktop live, non un totale globale
multi-client; native non inventa completamenti dall'ack di invio. Token assenti restano
sconosciuti, nomi di modelli non vengono raccolti. Gli attuali build nativi sono etichettati
`stable`, non avendo un selettore di flavor dedicato. Servono nuovi build client per usare
lo switch: questo checkpoint non è un rilascio firmato né TestFlight.

## Integrazione di main e audit analytics — 5 ottobre 2026

Integrati i quattro nuovi commit di `origin/main`, fino a `f2069a6f316e61601be23281c9ebab86982b4252`, preservando la cronologia condivisa con un merge. Backup: `codex/remote-before-main-20261005`, a `db9aa8f0eae03b128dad0b28e7b2d1e5cf422d22`. Unico conflitto testuale in `BETA.md`: conservati sia i gate remote/account sia la nuova descrizione Auto-fix CI. Nessuna nuova migrazione o modifica al protocollo remoto; il nuovo bridge di diagnostica resta opzionale e Beta-only.

La base aggiornata comprende contesto diagnostico limitato e campioni memoria, correzioni del teardown browser/Devin, del toggle sidebar e dell'overflow dei pannelli. Revisione semantica del wrapper RPC: nessun nuovo bypass dei permessi o cambiamento dell'host di esecuzione individuato. Le breadcrumb sono contesto per errori/crash, non metriche complete di adozione o di completamento del turno.

Passati `bun run fmt:check`, `bun run lint` (896 warning, zero errori), `bun run typecheck` e 12 test browser su sidebar, overlay e transcript. La suite workspace ha eseguito **16.007 test passati, 251 saltati e 2 falliti**: timeout nella selezione PR di GitManager e mancata icona nella fixture Windows Store. Rieseguiti separatamente i due file, **64 test passati senza modifiche a codice o assertion**. Questo non trasforma la prima esecuzione completa in una run verde; resta una segnalazione di instabilità sotto suite. Il primo tentativo in sandbox era stato bloccato sulle porte locali e non è evidenza di regressione dell'app. Nessun nuovo test live tra Mac, build mobile o deploy in questo passaggio.

Tre subagent GPT-6 Luna High hanno confrontato il progetto upstream, la raccolta Synara e l'integrazione. Il confronto usa un checkout fresco del progetto upstream e del Worker Cloudflare. Risultato e piano implementativo in [PRODUCT-ANALYTICS-AUDIT.md](PRODUCT-ANALYTICS-AUDIT.md): scelta richiesta **Cloudflare, Beta e Stable, controllo nelle impostazioni**. Product analytics, consenso, dashboard dedicata ed eventi nativi **non sono ancora implementati**; nessun servizio PostHog aggiunto. Lo stato dei deploy account/Inbox non cambia.

## Integrazione desktop e mobile — 4 ottobre 2026

Base desktop integrata: `212dd3bc8f0b19ad62033b32f7ed9ae1a1dbf85e`, dopo 271 commit di main dal checkpoint `4f204aef`. È un merge che conserva i commit e le PR condivise, senza riscrivere la cronologia. Backup pre-integrazione: `codex/remote-before-main-20261004` (`b46c3f6`). Continuare sulle PR esistenti: [desktop/API #1412](https://github.com/Emanuele-web04/synara/pull/1412), [iPhone #1](https://github.com/Emanuele-web04/SynaraIOS/pull/1) e [iPad #2](https://github.com/Emanuele-web04/SynaraIOS/pull/2). La PR iPad rimane basata sul branch iPhone. Questo aggiornamento non è un merge delle PR né un rilascio.

Il controllo ha coperto il delta di main, i contratti RPC e gli incroci con connessioni/account/Inbox, oltre ai conflitti testuali:

| Area                    | Stato dopo l'integrazione                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database locale         | Main conserva 127–130; le quattro migrazioni account/remote diventano 131–134. La recovery riconosce anche la precedente lineage privata fino a 130, con backup e replay idempotente; conserva identità, cursori, trust, revoche e preferenze. Non modifica le home reali durante i test.                   |
| Gateway e Hub           | Integrata la coda durevole Hub di main. Un chiamante remoto non eredita l'identità o i privilegi di un coordinatore locale. Le nuove route restano vincolate al computer di esecuzione.                                                                                                                     |
| Sidebar e Activity      | Conservate liste unificate multi-computer, identità qualificate e selezione per task insieme a rail, snooze, draft e navigazione recenti di main. Le azioni locali non ricadono sul computer sbagliato.                                                                                                     |
| Creazione progetto      | Resta la scelta del computer e della cartella remota; il controllo cartella adotta la presentazione compatta e la nuova icona di main.                                                                                                                                                                      |
| Sync account            | Un'importazione tardiva di vecchie chat riapre il relativo intervallo di statistiche/recap già sincronizzato. Checkpoint durevole distinto per identità; retry e restart non perdono il recupero. Restano batch limitati, gate esistenti e tombstone dei recap eliminati.                                   |
| Mobile: dati e recovery | Snooze e provenienza delle chat importate, paginazione della cronologia importata, stato del lavoro in background, avanzamento della coda Hub e quote per provider instance. Gli invii con esito incerto verificano la ricevuta originale quando il server negozia la capability, senza duplicare il turno. |
| Mobile: viste           | Nuove icone desktop tramite il resolver condiviso; Connections conserva il globo Central. Tasks con stati/board adattiva, Send as Goal e Tasks del giorno in Inbox. Controlli ed azioni mantengono il computer proprietario.                                                                                |

Riutilizzati `SynaraIcon`, picker modello/account, trasporto, outbox e viste native esistenti. Le nuove strutture mobili per pagine importate e lifecycle delle attività rappresentano contratti senza un proprietario equivalente nel codice precedente. Nessun framework alternativo di sincronizzazione.

### Verifiche di questo checkpoint

Formato, lint (warning presenti, zero errori), typecheck, lineage di 91 release e controllo statico Windows passati. Corretto anche il gate CI di branding: record upstream rinominato, formulazioni neutrali e una sola attribuzione esatta consentita nel suo documento; 13 test del guard passati, inclusa la nuova regressione riprodotta prima del fix. Passati 26 test browser su cinque superfici: Activity, creazione progetto, Inbox, storico Inbox e task Inbox. I due nuovi test per importazioni tardive falliscono sul codice precedente e passano dopo il fix; passati 39 test mirati di reporter e policy. Avvio reale su loopback con home temporanea: health, startup, subscription e proiezioni sane; server arrestato e porta liberata. Corretti i due harness browser rimasti obsoleti: il mock SignIn conserva gli export correnti e il test della Space seleziona il campo Name esatto, distinto da Project name. Passati tutti gli 8 scenari browser interessati; nessuna assertion rimossa.

Suite workspace finale: **15,999 test passati, 251 saltati, 10 package riusciti**. I salti comprendono 200 test API PostgreSQL senza database di test configurato. Build Debug complete e avvio riusciti su simulatori iPhone 18 Pro e iPad Pro 11, iOS 27; 197 test SwiftPM e 79 fixture condivise contro il desktop passati. Le verifiche visive usano due computer in cache offline, non un nuovo test live. Per inventario mobile, screenshot e limiti vedere il [recap mobile](https://github.com/Emanuele-web04/SynaraIOS/blob/codex/ios-remote-connections/Docs/REMOTE-CONNECTIONS-HANDOFF.md).

### Limiti e ripartenza

- Le prove di questo giro non ripetono il pairing live Mac ↔ Mac o iPhone ↔ Mac, né un rilascio firmato Windows/Linux/TestFlight. Il controllo Windows è statico.
- I test API PostgreSQL sono esclusi dalla suite di questo giro perché non è configurato un database di test isolato. Non utilizzare Supabase di produzione per sostituirlo. Le precedenti prove PostgreSQL sotto sono storiche.
- **Saved Inbox richiede ancora il deploy autorizzato** delle migrazioni API `0016_private_inbox_recaps.sql` e `0017_inbox_automatic_sync.sql` e dell'API. Nessuna operazione di produzione eseguita qui. Persistenza: Supabase/PostgreSQL attraverso l'API Cloudflare; non Cloudflare Analytics. Il sync dei totali del profilo conserva `SYNARA_ACCOUNT_PROFILE_SYNC=1`.
- L'allineamento mobile non promette tutte le funzioni desktop: handoff provider nella stessa chat, gestione amministrativa Hub, interazioni avanzate Tasks e PR auto-fix UI restano esplicitamente elencati nel recap mobile. Menu Electron, shortcut e audio/window chrome sono specifici del desktop.

## Checkpoint storici

Le sezioni successive riportano le verifiche e gli stati delle date indicate. Numeri di migrazione, SHA, stato dei worktree e frasi come “nessuna PR” non descrivono il checkpoint corrente.

## Inbox privata e MVP mobile — 1 ottobre 2026

Aggiunto lo storico privato dei recap, distinto dal profilo pubblico. Desktop e mobile riutilizzano `StatsGetRecapResult`. Il server del computer con account collegato salva automaticamente il giorno corrente ogni minuto, senza aprire Inbox o usare il telefono; recupera anche lo storico locale, quattro giorni per ciclo, con cursore persistente distinto per account, computer e fuso. Include nomi dei progetti, metriche per modello, token e attività degli agenti. **Save privately / Save now** rimane un aggiornamento immediato facoltativo. Le quote live non vengono congelate nello storico. I dati già pubblicati sul profilo restano gestiti dal loro percorso esistente.

L’API `/api/v1/inbox/recaps` consente salvataggio idempotente, lettura paginata, dettaglio ed eliminazione. Il proprietario è l’utente nel workspace autenticato; la rimozione del computer non elimina i recap. Membership verificata, risposte private/no-store, payload limitato e RLS senza accesso diretto per `anon`/`authenticated`. Migrazioni PostgreSQL `0016_private_inbox_recaps.sql` e `0017_inbox_automatic_sync.sql`; nessuna modifica ai database di produzione durante lo sviluppo.

Il salvataggio avviene in **Supabase/PostgreSQL**, non in Cloudflare Analytics. Il servizio API gira su Cloudflare. `/api/v1/inbox/recaps/sync` accetta solo il proprietario del computer; il worker verifica anche l’identità dopo il rinnovo della sessione. Nessuna sincronizzazione su Stable o da sessioni disconnesse. Dopo un errore ritenta senza avanzare il cursore. Eliminare un recap cancella payload e nome del computer e conserva soltanto la chiave account/computer/giorno: la sincronizzazione non lo ricrea; un Save esplicito può ripristinarlo. I cambi di account/authority sono verificati prima di usare il token. Il sync dei totali del profilo rimane separato e conserva il gate `SYNARA_ACCOUNT_PROFILE_SYNC=1`.

Su iPhone/iPad: Inbox nativa con metriche e fasce orarie, cronologia account leggibile senza computer online, Hubs/Tasks aggiornati mentre visibili e Tasks → Start with Agent tramite il picker modelli esistente. Il primo turno passa dalla coda persistente soltanto dopo il collegamento condizionale della task. Corretto anche un crash mobile di reconnect: le copie in cache mantengono gli ID qualificati per computer quando il cursore viene invalidato.

Verifiche desktop del delta: formato, lint, tipi e lineage passati; suite completa **15.470 test passati, 38 saltati, 10 package riusciti**, inclusi 338 test API su PostgreSQL isolato. Tre test browser mirati passati per gate Stable, salvataggio esplicito e cambio account. Probe SQL isolato: `anon` e `authenticated` non leggono/modificano/eliminano record e non possono inserirli, anche con permessi tabella concessi.

Verifica successiva del sync automatico: formato/lint/tipi/lineage passati (lint con warning preesistenti). Suite workspace: **15.475 passati, 2 falliti, 38 saltati**; le due failure riguardano cleanup Antigravity, fuori da questo delta, e il rerun mirato del file è passato. Verifica finale: **165 test server passati** (reporter, account identity, recap e Antigravity), **30 test account client passati**, **339 test API passati** su PostgreSQL isolato e **1 test browser Inbox passato**. Inclusi retry HTTP 503/ack inattesa, ripartenza col cursore, rollover 04:00, timer senza UI, gate Stable, logout, account cambiato e cancellazioni non ricreate. Le precedenti failure CI della PR su branding e browser SignInDialog/ChatView non sono state corrette da questa modifica; non dichiarare la PR pronta al merge sulla sola verifica locale. Nessuna nuova build mobile per il solo cambiamento delle etichette: i test simulatori sopra restano quelli del passaggio precedente.

**Deploy ancora da eseguire:** applicare entrambe le migrazioni e pubblicare l’API prima di usare Saved Inbox sull’account reale. Pubblicare i client aggiornati dopo l’API. Il test con login sintetico e database isolato non equivale a una migrazione o a un rilascio di produzione. Vedere il recap mobile per compilazioni, prove nel simulatore e limiti.

## Integrazione di main — 1 ottobre 2026

Integrato `origin/main` a `4f204aef7d9a38e19baff915c58aec0a5498524f` nel branch desktop `codex/cloudflare-remote-mvp`. Il lavoro locale preesistente (119 percorsi) è stato prima salvato nel commit `ee36a79`, conservato anche dal branch `codex/remote-before-main-20261001`. La descrizione del delta non committato e i checkpoint del 30 settembre più sotto sono **storici**, non lo stato corrente. Nessuna modifica alla repo iOS o all'infrastruttura Cloudflare in questo passaggio.

Risolti 30 conflitti Git, oltre alle incompatibilità che un merge testuale non individua:

- **Database:** `main` occupa le migrazioni 109–126; quelle account/remote del branch diventano 127–130. La recovery riconosce esattamente la vecchia sequenza privata fino a 112, prepara il backup tramite il percorso esistente e conserva trust, certificati e connessioni desiderate. Sequenze sconosciute continuano a essere rifiutate. Non modificati database dell'utente.
- **Stato per computer:** le nuove tab aperte, i pin degli agenti Hub e lo stato di chiusura dei pannelli usano lo storage già isolato per ambiente. Stessi identificativi su due computer non condividono più questi valori.
- **Statistiche account:** riutilizzata la query canonica di `main` per i delta per provider e i risultati verificati di Claude. Conservata la dimensione reasoning per l'account e adattata l'attribuzione ai nuovi provider instance. Le istanze duplicate non generano chiavi React uguali nel riepilogo profilo.
- **Permessi Hub/MCP:** i nuovi coordinatori e worker gestiti non possono usare la delega remota per aggirare i vincoli di proprietà dell'Hub locale. I normali thread utente mantengono gli strumenti remoti; i chiamanti remoti non acquisiscono un'identità di coordinatore locale.
- **Integrazione UI/runtime:** Hub remoti nella superficie Hub esistente, Activity e ricerca con identità host, route rigenerate, risorse HTTP instradate sul computer corretto, provider instance conservata per la trascrizione. Packaging mantiene sia cloudflared sia il nuovo addon macOS di `main`; conservate le correzioni Windows di `main`.

Regressioni riprodotte prima dei fix per migrazioni, isolamento storage, conteggio token e autorizzazione dei worker. Dopo i fix: 224 test server mirati e 47 test web mirati passati. Avvio server reale con home temporanea e porta 51275: `/health` segnala startup, subscription e proiezioni sane; processo arrestato e porta liberata dopo la prova. I controlli della lineage hanno verificato 91 tag di release. Le prove su due Mac, iOS fisico, provider live e pacchetti firmati restano distinte da questa verifica d'integrazione.

Verifica complessiva: `bun run test` completato con 10 package riusciti, 15.247 test passati e 246 saltati secondo le condizioni delle suite. Dopo l’ultima precisazione del guard dei ruoli, rieseguiti i 134 test del gateway/MCP: chat ordinarie e membri semplici degli Hub possono delegare, coordinatori e worker no. In Chromium passati 40 test su sei superfici: Activity, ricerca, Hub, tab aperte, creazione progetto e icone. Passati anche formato, lint (warning presenti, zero errori), tipi e controllo dei confini Windows; quest’ultimo è statico e non certifica il pacchetto Windows.

Per riprendere: usare il branch desktop aggiornato e il recap iOS; non riapplicare il vecchio delta dei 119 percorsi. Prima di aggiornare runtime esistenti conservare le rispettive home e seguire il normale backup delle migrazioni. Rimangono valide le prove di qualificazione elencate in “Cosa manca davvero”; questo merge non costituisce un rilascio.

## Aggiornamento account/profile — 30 settembre 2026

Dopo il rename Connections (`fdfde17` desktop, `e9aa0b6` iOS), corretto il fallback dell'identità: finché manca un profilo Synara, la pagina Profile usa nome e foto del login, come il menu account. Un profilo salvato continua ad avere precedenza, anche quando la foto è stata esplicitamente rimossa. Gli edit prima dell'onboarding non vengono più salvati silenziosamente nell'identità locale. Il feature gate esistente rimane invariato.

iOS legge `/me` con la sessione autenticata e mostra la stessa precedenza nella sezione Account di Connections; aggiorna all'apertura, al ritorno in foreground e con pull-to-refresh. La presentazione rimane separata dallo stato di autorizzazione. Nessuna modifica ai dati salvati o deploy dell'API; serve una build client aggiornata. Una foto può apparire soltanto se il provider la fornisce o l'utente l'ha caricata.

Verifica desktop: regressione riprodotta prima del fix, poi 26 test pertinenti passati; `bun run fmt:check`, `bun run lint` e `bun run typecheck` riusciti. iOS: 180 test core, 8 test gateway isolati con Node 24 e build/avvio nel simulatore riusciti. Questo passaggio non ripete le prove live sui due Mac né certifica una release. I 119 percorsi desktop preesistenti restano fuori da questi commit. Le tabelle seguenti conservano i checkpoint storici del recap iniziale.

## Dove si trova il lavoro e cosa è pubblicato

| Superficie               | Repository / branch                                        | Stato verificato prima di questo recap                                                                                                                    |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, API e trasporto | `Emanuele-web04/synara`, `codex/cloudflare-remote-mvp`     | HEAD locale e branch remota entrambi a `b5f8837adb3a8c938d3f16e2d4882aa1b8a1c7ce`; nessuna PR trovata per questa head                                     |
| iPhone                   | `Emanuele-web04/SynaraIOS`, `codex/ios-remote-connections` | [PR #1](https://github.com/Emanuele-web04/SynaraIOS/pull/1), aperta, codice pubblicato fino a `4b855e68faadb99396452899d53af1f9d0ced3b3`; worktree pulita |

Questo recap viene pubblicato con un commit di sola documentazione dopo quei checkpoint. La sua pubblicazione **non include né certifica** le modifiche desktop non committate descritte sotto. La branch desktop pubblicata è consultabile [qui](https://github.com/Emanuele-web04/synara/tree/codex/cloudflare-remote-mvp).

Il worktree desktop è `.codex/worktrees/a816/synara`; quello iOS è `Developer/SynaraIOS-remote-connections` sul Mac Mini. Il [recap iOS](https://github.com/Emanuele-web04/SynaraIOS/blob/codex/ios-remote-connections/Docs/REMOTE-CONNECTIONS-HANDOFF.md) documenta il lato telefono. Non usare la repo beta-diagnostics per riprendere questa attività.

## Storico del 30 settembre: lavoro desktop allora locale

Alla lettura iniziale di questa sessione Git riportava **119 percorsi modificati**, tutti non staged: 36 D, 83 M. Diff complessivo: **1.941 righe aggiunte, 6.392 rimosse**. È un delta successivo al checkpoint pubblicato, non un riepilogo dell'intera feature.

Le aree coinvolte sono:

- API e identità: configurazione, issuer/grant, revoche e route di autorizzazione.
- Rimozione del runtime relay ritirato: `apps/relay`, `packages/relay-protocol`, dialer e harness precedenti; aggiornamenti dei manifest e del lockfile.
- Runtime remoto: supervisor/registry, session gateway, tunnel e risorse, strumenti MCP remoti.
- Web: sidebar unificata, Activity, ricerca, creazione progetto, menu/azioni dei thread e stato delle connessioni.
- Contratti, test e documentazione collegati.

Queste modifiche sono preservate nel worktree. Non sono state aggiunte automaticamente al commit di questo recap: non è stata ricostruita una prova di validazione del loro insieme esatto. I test storici della branch non dimostrano che questo delta passi oggi. Prima di pubblicarlo, rivedere il diff, verificare che appartenga tutto all'attività, eseguire i controlli pertinenti e creare commit coerenti. Non usare `reset --hard`, `clean` o uno stage indiscriminato per semplificare il lavoro.

Git emette inoltre avvisi `non-monotonic index` per file AppleDouble `._pack-*.idx` nel Git common directory sul volume esterno. Le letture di HEAD e la verifica remota sono riuscite. Nessuna riparazione o cancellazione degli oggetti Git è stata eseguita; se gli avvisi bloccano operazioni successive, trattarli come problema del repository, non dell'app.

## Logica scelta e invarianti

L'app mantiene più computer collegati nello stesso workspace. Progetti e chat conservano l'identità del computer proprietario; aprire una chat o filtrare una sidebar cambia la vista, non sposta l'esecuzione. La creazione di una chat/progetto cattura esplicitamente computer e progetto di destinazione. Identificativi uguali su due host non devono collidere.

Il percorso gestito usa Cloudflare Tunnel per raggiungere il computer, con autenticazione del dispositivo e identità del computer verificata dal protocollo remoto. Il codice di pairing serve a iniziare l'abbinamento; non sostituisce l'approvazione dell'identità. Trust, sessione e riconnessione sono per host. La disconnessione di uno non deve interrompere gli altri.

L'API account gestisce identità/directory/autorizzazione; non esegue i task al posto dei Mac. I provider e i file restano sul computer scelto. La configurazione concordata è API/profili su Cloudflare e PostgreSQL su Supabase. Per questo trial l'infrastruttura è già configurata: non occorre ricrearla per riprendere le prove. Segreti, token e chiavi restano fuori dalla repo.

Gli strumenti interni Synara MCP hanno instradamento remoto tramite un `environmentId` esplicito e la connessione già approvata. Il default locale e i controlli di autorizzazione rimangono distinti dai grant delle integrazioni MCP esterne. Cloudflare e SSH sono percorsi differenti: provare l'uno non certifica l'altro. Le regole server Beta/Stable rimangono autorevoli; non disattivarle per far riuscire un test.

## Cosa è stato effettivamente verificato

| Evidenza                 | Risultato e limite                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop MacBook ↔ Mini   | Collegamento in entrambe le direzioni sulle istanze isolate di test, con navigazione e letture remote. Non equivale a verificare le app distribuite su ogni sistema operativo.                                                                                                             |
| Recovery desktop         | Nella cronologia di [STATUS.md](STATUS.md) sono registrate correzioni e prove di ripresa dopo restart/crash del connector. I primi test usavano un override DNS limitato al processo; non generalizzare quelle prove alla risoluzione di rete ordinaria.                                   |
| MCP remoto               | Il checkpoint `ac27fd7` implementa il routing; `b5f8837` registra la validazione. Listing/lettura reali sul bridge MacBook → Mini; mutazioni coperte anche da fixture con provider deterministico. Una negoziazione 503 poi riuscita è registrata, non mascherata come reconnect perfetto. |
| iOS → entrambi i Mac     | Simulatore iPhone 18 Pro/iOS 27, pairing separato e approvato, entrambi i computer collegati attraverso le route Cloudflare gestite.                                                                                                                                                       |
| Chat reali da iOS        | Creazione e risposte di provider reali su entrambi: `REMOTE IOS OK` e `MACBOOK IOS OK`. Snapshot dei server hanno confermato che ogni chat era sul proprio host.                                                                                                                           |
| Isolamento e riavvio iOS | Disconnettendo un host, l'altro ha continuato a rispondere. Dopo terminazione/rilancio dell'app entrambi hanno recuperato trust, connessioni e cronologia senza nuovo OTP.                                                                                                                 |
| Sidebar iOS              | All e filtri per computer, ricerca, apertura del transcript corretto e destinazione dei nuovi task separata dai filtri. Screenshot e test sono nella PR iOS.                                                                                                                               |

Le risposte delle prove sono messaggi sintetici senza uso di tool o modifica dei file dell'utente. Non presentare le prove del simulatore come prove su un iPhone fisico. I record dettagliati e i limiti delle suite storiche sono in [STATUS.md](STATUS.md), [QUALIFICATION.md](QUALIFICATION.md) e nel recap iOS; nessuna suite desktop è stata rieseguita per questo commit di sola documentazione.

## Cosa manca davvero

Non è stato identificato un blocco fondamentale assente nel percorso normale pairing → connessione → chat. Restano qualificazione e possibili correzioni dei casi limite, oltre alla qualificazione del desktop aggiornato:

1. Due task realmente in streaming, uno su ciascun Mac; Stop, richiesta di approvazione e input devono restare sull'host corretto anche cambiando chat e durante reconnect.
2. Revoca durante una sessione reale e nuovo tentativo di accesso; i test di sicurezza isolati esistono, ma non sostituiscono questa prova finale.
3. Riavvio del server, sleep/wake, indisponibilità dell'API e rinnovo delle credenziali durante una prova prolungata con durata e misure dichiarate.
4. iPhone fisico: Wi-Fi/cellulare, lock/unlock, background/foreground e recupero. Non promettere socket continuamente attivi in background su iOS.
5. Allegati consumati da un provider reale e percorso microfono/trascrizione.
6. SSH nativo, Windows/Linux e pacchetti firmati/distribuiti non sono qualificati da queste prove Mac/Cloudflare. Nessuna prova di capacità con molti host autorizza a promettere connessioni illimitate.
7. Prima di un rollout commerciale: il trial usa enrollment esplicito, non una verifica completa dell'abbonamento.

## Sequenza per ripartire

1. Leggere questo file e il recap iOS, poi aggiornare HEAD, stato Git e stato remoto. Il delta storico di 119 percorsi è già conservato nel checkpoint `ee36a79` e incluso nell’integrazione del 1 ottobre.
2. Verificare eventuali nuovi delta desktop rispetto al commit d’integrazione. UI aggiuntiva in pausa; nessun altro ridisegno richiesto.
3. Seguire AGENTS: Node/Bun da `.mise.toml`; `bun run fmt:check`, `bun run lint`, `bun run typecheck`, test Vitest pertinenti tramite `bun run test`. Le modifiche attuali attraversano più package/lifecycle: serve anche la suite più ampia. Eseguire `bun run windows-runtime:check` se si toccano confini process/platform e `bun run migrations:check` se si cambiano migrazioni. Non usare database di produzione per i test.
4. Committare e pushare solo dopo aver registrato risultati e limiti del delta esatto. Al momento del controllo iniziale questa branch non aveva una PR: crearla quando il contenuto da revisionare è pronto, senza confonderla con la PR iOS #1.
5. Riallineare i due runtime isolati a commit noti, conservando le rispettive home e pairing. Verificare porte IPv4/IPv6 prima di avviarli; dry-run del dev runner prima del launch. Le ultime home di prova erano `/private/tmp/synara-remote-mini` (porta 4775) e `/private/tmp/synara-remote-macbook-20260929` (4776 sul MacBook); sono riferimenti storici, non una garanzia che i processi siano ancora in esecuzione.
6. Eseguire i casi 1–3 sopra dal simulatore, poi passare al telefono fisico. Registrare commit di ogni runtime/client, passaggi, esito, artefatti e durata. Nuova identità di dispositivo richiede la sua specifica approvazione; non copiare chiavi tra dispositivi.
7. Correggere difetti concreti emersi; niente riscritture preventive o nuovi strati di trasporto se non necessari. Aggiornare entrambi i recap dopo ciascuna prova significativa.

## Mappa del codice e riferimenti

- `apps/api/src`: configurazione account, identità e route di autorizzazione.
- `apps/server/src/hostConnections`: connessioni e lifecycle del controller.
- `apps/server/src/remoteSessions` e `remoteTransport`: sessioni, gateway, trasporto e risorse.
- `apps/server/src/agentGateway/remoteTools.ts`: strumenti agent/MCP verso altri computer.
- `apps/web/src/lib/hosts` e componenti Sidebar/Activity/Search/CreateProject: proiezione e navigazione multi-host.
- `packages/contracts`: contratti condivisi; non introdurre orchestrazione runtime qui.
- [Piano originale](PLAN.md), [configurazione trial](READINESS.md), [operazioni](../../cloudflare-remote.md), [ADR 0016](../../adr/0016-managed-cloudflare-remote.md).

Il checkpoint originale del 30 settembre era un recap con verifica del push. Per il merge successivo e lo stato corrente leggere l’aggiornamento del 1 ottobre in apertura.

## Verifica operativa iPhone — 6 ottobre 2026

La connessione Cloudflare deve funzionare anche su rete cellulare; la stessa LAN non è un requisito. Il controllo live ha trovato entrambi i tunnel del trial `down`, senza connector collegati, mentre l'API account rispondeva HTTP 200. Sul Mini girava soltanto l'istanza demo, senza configurazione account e senza cloudflared; la precedente home temporanea del Mini non era più presente. Le prove storiche non descrivono quindi lo stato dell'installazione attuale.

L'iPhone conservava profili legacy LAN/Tailscale, non un abbinamento Cloudflare verificato per l'istanza demo. Le correzioni della UI offline non ripristinano quell'autorizzazione e non costituiscono una prova di accesso remoto.

L'istanza demo è stata riavviata con API account e accesso remoto configurati, conservando la stessa home e una copia SQLite privata precedente al collegamento. Health locale HTTP 200 verificato. Il login Google integrato in Synara ha registrato l'istanza corrente e la creazione del codice di pairing ha inizializzato la sua identità TLS. Cloudflare segnala il nuovo tunnel `healthy`, con quattro connessioni; `/health` pubblico risponde HTTP 200 e `/api/v1/instance` pubblico HTTP 404, senza override DNS. Restano da completare il pairing della specifica chiave dell'iPhone e una lettura reale attraverso il tunnel. Non qualificare la connessione cellulare prima di questa prova e non conservare identità di una demo durevole in una home temporanea.

Il percorso CLI `auth --device-code` restituisce una verification URI `/link`, ma il deployment attuale vi serve soltanto il messaggio generico dell'API, senza form di approvazione. Il codice scaduto non ha collegato alcun host; per questa ripresa è stato usato il login integrato, non una modifica manuale delle credenziali. Il flusso headless browser non è quindi qualificato su questo deployment.

### October 6 — QR-first mobile pairing

- Connections now renders an offline-generated QR alongside the short manual code. The `synara://connect` fragment contains version 1, the configured HTTPS account origin, invitation code, pinned root fingerprint, and expiry. It contains no account token. Expiry/cancel hides the QR; owner approval remains mandatory.
- SynaraIOS accepts the remote invitation in its existing scanner, paste entry, and system-camera deep-link route. It retains the invitation through first sign-in, reuses an existing account session for that authority, selects a sole workspace automatically, and checks the returned computer fingerprint against the scanned one.
- The signed-out desktop Connections panel now opens the existing account sign-in dialog. The mobile entry starts with Scan QR Code; manual server/code entry is secondary.
- Verification: desktop formatting/lint/typecheck, four RemoteControls browser tests, and two UI typography tests pass. A desktop-generated invitation was parsed by the actual Swift parser; expired, duplicate-field, plaintext-authority, embedded-credential, and bad-fingerprint variants were rejected. Signed iPhone and simulator builds succeeded. Simulator deep-link delivery opened the new account screen with the invitation retained. Camera optics, physical-phone login, approval, and remote chat read/write are still unverified for this new flow.

- The final signed build was installed on the USB iPhone without deleting its data. Apple Vision decoded the actual desktop-rendered QR, and its validated link was delivered to the iPhone with `devicectl --payload-url`; launch succeeded. This proves QR readability and OS delivery, not completed phone authentication or host approval.
