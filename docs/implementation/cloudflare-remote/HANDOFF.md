# Remote connections — punto di ripartenza

Aggiornato il 1 ottobre 2026. Questo è il riepilogo corrente tra desktop e iOS; i documenti precedenti contengono anche stati storici ormai superati. Il ridisegno della UI e dei chip è in pausa. Successivamente l'utente ha richiesto soltanto nome “Connections” e globo Central Icons su desktop e iOS: applicati alle voci di accesso e ai titoli, senza cambiare il comportamento delle connessioni.

## Inbox privata e MVP mobile — 1 ottobre 2026

Aggiunto lo storico privato dei recap, distinto dal profilo pubblico. Desktop e mobile riutilizzano `StatsGetRecapResult`; un’azione esplicita **Save privately / Save recap** salva la fotografia del giorno nell’account. Include nomi dei progetti, metriche per modello, token e attività degli agenti; nessun caricamento retroattivo automatico. Le quote live non vengono congelate nello storico. I dati già pubblicati sul profilo restano gestiti dal loro percorso esistente.

L’API `/api/v1/inbox/recaps` consente salvataggio idempotente, lettura paginata, dettaglio ed eliminazione. Il proprietario è l’utente nel workspace autenticato; la rimozione del computer non elimina i recap. Membership verificata, risposte private/no-store, payload limitato e RLS senza accesso diretto per `anon`/`authenticated`. Migrazione PostgreSQL additiva `0016_private_inbox_recaps.sql`; nessuna modifica ai database di produzione durante lo sviluppo.

Su iPhone/iPad: Inbox nativa con metriche e fasce orarie, cronologia account leggibile senza computer online, Hubs/Tasks aggiornati mentre visibili e Tasks → Start with Agent tramite il picker modelli esistente. Il primo turno passa dalla coda persistente soltanto dopo il collegamento condizionale della task. Corretto anche un crash mobile di reconnect: le copie in cache mantengono gli ID qualificati per computer quando il cursore viene invalidato.

Verifiche desktop del delta: formato, lint, tipi e lineage passati; suite completa **15.470 test passati, 38 saltati, 10 package riusciti**, inclusi 338 test API su PostgreSQL isolato. Tre test browser mirati passati per gate Stable, salvataggio esplicito e cambio account. Probe SQL isolato: `anon` e `authenticated` non leggono/modificano/eliminano record e non possono inserirli, anche con permessi tabella concessi.

**Deploy ancora da eseguire:** applicare la migrazione e pubblicare l’API prima di usare Saved Inbox sull’account reale. Pubblicare i client aggiornati dopo l’API. Il test con login sintetico e database isolato non equivale a una migrazione o a un rilascio di produzione. Vedere il recap mobile per compilazioni, prove nel simulatore e limiti.

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
