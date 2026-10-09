# Synara Remote MVP — Cloudflare Tunnel e abbinamento con codice

Piano di continuazione del 28 settembre 2026. Modello richiesto dall'utente: GPT-6 Astra, reasoning effort High.

## Obiettivo e decisioni dell'utente

Realizzare un MVP desktop funzionante MacBook ↔ Mac Mini: stesso account Synara, codice breve monouso, approvazione esplicita sul Mini, computer ricordato e connessione successiva con un clic. Le sessioni sul Mini continuano quando il controller si disconnette; il controller recupera lo stato senza duplicare comandi o perdere il lavoro.

La decisione è passare ORA a Cloudflare Tunnel, prima del lancio. È superato il precedente consiglio di mantenere il relay Bun su Railway per l'MVP. Prima si implementano trasporto e pairing, poi si collegano Cloudflare, WorkOS e il database di test e si qualificano i due Mac reali.

Synara iOS esiste già, secondo l'utente, in una repository privata derivata da Remodex. La sua integrazione account e il QR su iPhone sono una fase successiva: non richiedere di ricreare l'app, non modificare quella repository in questa task. Il protocollo di pairing deve poter essere usato successivamente anche da iOS senza progettare ora un secondo sistema.

La funzionalità finale sarà riservata agli utenti paganti. Il gate Beta/Canary presente oggi non è una verifica dell'abbonamento: questa differenza deve rimanere esplicita.

## Punto di partenza verificato

- Host: Macmini-di-Emanuele.local.
- Progetto Codex locale: synara, projectId 891716f8-5446-481c-9665-67608c7f6c2f.
- Repository salvata: /Volumes/Crucial X10/Developer/synara.
- Worktree della conversazione di origine: /Users/emanueledipietro-macmini/.codex/worktrees/6b82/synara.
- Branch di partenza: codex/remote-v2-completion.
- Commit di partenza: 42aa8fb4f093f78fe7a1f7be5525f67571086ebf, già pubblicato su origin.
- Titolo del commit: Complete local remote v2 qualification and settle interrupted turns.
- Alla preparazione di questo piano il worktree è pulito. Questa conversazione non ha implementato la migrazione Cloudflare: sono stati effettuati soltanto controlli in lettura.
- Avvisi Git noti su file AppleDouble .\_pack\*.idx nel repository sul disco esterno. Non cancellare pack né fare riparazioni distruttive; distinguere questi avvisi dall'exit status dei comandi.

La nuova task deve usare un worktree isolato del progetto sul Mini a partire dal branch indicato, non da main e non dalla vecchia PR. Verificare SHA, branch e stato prima di modificare file. Non creare un secondo worktree se la task ne possiede già uno adatto. Se il checkout è detached, creare un branch di lavoro secondo le convenzioni disponibili conservando il commit base.

Dossier precedente, da leggere in modo mirato:

- /Users/emanueledipietro-macmini/Documents/Codex/2026-09-28/synara-remote-continuation/synara-remote-audit-1065/implementation-plan/STATUS.md
- Nella stessa directory: QUALIFICATION.md e ACCEPTANCE-EVIDENCE.md.
- Evidenze: evidence/mini-final-2026-09-28/.

P0–P7 e P8 locale sono completati per il VECCHIO trasporto. Il dossier riporta 14.093 test passati e 37 skip, build 10/10, typecheck 13/13, lint senza errori con 792 warning preesistenti, prove browser/Electron/TLS e migrazioni storiche preservate. Non trasferire questi risultati alla nuova implementazione senza eseguire i controlli pertinenti. Non ripetere da zero l'intero audit della PR.

Le prove precedenti usavano PostgreSQL isolato, fake WorkOS, relay Bun reale e CLI provider deterministico. Non attestano Cloudflare live, WorkOS reale, provider autenticati, due Mac fisici, sleep/rete reali o distribuzione firmata. Il PostgreSQL temporaneo precedente è stato fermato. L'istanza personale sulla porta 7265 è stata preservata: controllare i listener attuali prima di avviare altre istanze.

## Come eseguire la task

È lavoro di implementazione, non una richiesta di sola consulenza. Leggere il piano, correggere soltanto le assunzioni smentite dal repository o dalla documentazione corrente, rendere persistente un piano operativo nel nuovo worktree e procedere con codice e verifiche locali senza chiedere una nuova autorizzazione per ogni fase.

Usare la guida ufficiale OpenAI, sezione Prompting best practices:
https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices

La guida è stata consultata per impostare autonomia, chiarezza del mandato, priorità delle istruzioni, comunicazione e proporzione dei test. Applicazione pratica: risolvere le scelte ordinarie, continuare il lavoro indipendente se manca un dato esterno, comunicare in italiano semplice, dichiarare cosa è verificato e chiedere soltanto informazioni realmente indispensabili. Rispettare le autorizzazioni esistenti e spiegare eventuali blocchi concreti. Non ampliare ripetutamente i test senza una modifica o un rischio nuovo. Non cambiare le policy globali del repository per applicare questa guida.

Leggere AGENTS.md e CONTRIBUTING.md, poi soltanto i riferimenti necessari. Conservare il modello ed effort richiesti. Non cambiare provider/modelli usati dall'app. Eventuali altri agenti sono soggetti alle regole della task; questo piano non richiede delegazione aggiuntiva.

Aggiornare uno stato persistente per fase con risultato, file modificati, comando di verifica, evidenza e lavoro residuo. Dopo compaction riprendere da quello stato. Le spiegazioni all'utente devono essere brevi; il piano tecnico e le evidenze possono essere dettagliati.

## Architettura di destinazione

Percorso dati:
MacBook/controller Synara → WebSocket HTTPS pubblico Cloudflare → tunnel gestito da cloudflared sul Mini → ingresso remoto dedicato → TLS interno già verificato → RPC e risorse del Mini.

Cloudflare sostituisce il trasporto del relay proprietario. Account, directory dei computer, grant, approvazione locale, revoca e identità dei dispositivi rimangono responsabilità di Synara.

Riutilizzare inizialmente l'API account esistente per coordinare i tunnel, a meno che un vincolo verificato richieda diversamente. Cloudflare Tunnel non obbliga a riscrivere l'API in Workers. Non mantenere un servizio Railway relay necessario nel percorso finale. L'eventuale hosting dell'API e del Postgres è una decisione distinta; non promettere che ogni uso di Railway scompaia.

Usare tunnel gestiti con hostname stabile per host. I Quick Tunnels possono servire a esperimenti espliciti, non costituiscono il risultato dell'MVP persistente. Verificare prima limiti account/tunnel, hostname/DNS, condizioni e costi applicabili al prodotto. Non presumere tunnel illimitati o costo zero.

Chiavi Cloudflare amministrative solo nel servizio account; sul Mini soltanto credenziali limitate al suo tunnel. Mai token cloud nel renderer, URL, log, notifiche o artefatti di test.

Preservare il TLS 1.3 interno, il root/SAN specifico del Mini e la verifica dell'identità già abbinata. Il TLS pubblico terminato da Cloudflare non sostituisce la protezione interna. Non instradare tutto il server locale dietro Cloudflare: pubblicare esclusivamente l'ingresso remoto necessario e un health check minimo.

## Fase 0 — Confermare gli innesti e fissare i criteri

Leggere in particolare:

- docs/remote-connections-v2.md.
- docs/adr/0008-relay-is-a-separate-service.md, 0005-presence-is-the-relay-socket.md, 0007-transport-selection.md e 0009-relay-carries-the-client-control-channel.md.
- apps/server/src/hostConnectivity.ts, hostConnections/dialer.ts, hostConnections/port.ts e hostConnections/registry.ts.
- apps/server/src/remoteTransport, remotePairing, remoteSessions, hostAuth.
- apps/server/src/accountAuth.ts e endpointReporter.ts.
- packages/contracts/src/account.ts, remotePairing.ts e hostAuth.ts.
- packages/shared/src/account.ts e transportRace.ts.
- apps/api/src/routes/v1.ts, identity/hostKeyRegistry.ts, identity/revocationLog.ts, db/schema.ts e config.ts.
- apps/web/src/components/settings/ConnectionsSettingsPanel.tsx e i suoi tab (`Connections*.tsx`).
- apps/desktop/src/remoteResourceBroker.ts e gli attuali owner del packaging/processo.
- apps/e2e/src/harness/workspace.ts e workspace.e2e.test.ts.

Fatti già osservati: gli endpoint pubblicati oggi sono lan/tailscale; il dialer aggiunge il relay da SYNARA_RELAY_URL; il processo host tiene il socket di controllo relay e riceve anche revoche; l'API WorkOS richiede ancora RELAY_SERVICE_TOKEN. La migrazione interessa tutte queste dipendenze, non soltanto un URL.

Produrre una mappa corta del ciclo login → registrazione host → tunnel → discovery → pairing → grant → sessione → revoca. Elencare gli invarianti conservati e le differenze di bootstrap introdotte dal codice breve.

Uscita: piano aggiornato con file reali e criteri di accettazione, senza riaprire la scelta Cloudflare già fatta dall'utente.

## Confronto obbligatorio con il riferimento upstream

Prima di scegliere gli innesti concreti, consultare l'implementazione corrente del [riferimento upstream](UPSTREAM-COMPATIBILITY.md) e registrare il commit esaminato. Leggere le quattro guide elencate nel record di provenienza, poi seguire soltanto i simboli necessari nel codice. Usare una consultazione in lettura o un checkout separato; non importare in blocco l'upstream nel branch Synara.

Produrre una tabella di compatibilità con queste colonne: funzione, come la realizza upstream, owner attuale in Synara, differenza rilevante, decisione di riuso/adattamento, test che la giustifica. Le righe minime sono provisioning tunnel/DNS, distribuzione e lifecycle cloudflared, auth/account/workspace, discovery/presenza, pairing/root trust, trasporto RPC/risorse, rinnovo/reconnect, revoca/unlink e cleanup.

È un riferimento utile soprattutto per tunnel, avvio connector, gestione degli hostname e recupero dagli errori. Verificare nei sorgenti se il loro servizio chiamato relay coordina il collegamento o trasporta realmente i dati: il nome non implica Railway né equivalenza con il relay Bun Synara.

Conservare i contratti e gli owner di Synara: WorkOS già integrato, controller locale distinto dall'execution host, TLS interno pinned, approvazione dell'esatta chiave dispositivo, revoche durabili e risorse remote. Non introdurre Clerk, PlanetScale, Workers o una riscrittura delle sessioni solo perché compaiono nell'esempio upstream.

Se un pezzo upstream è compatibile, riutilizzarne il pattern o il codice consentito dalla licenza con provenienza chiara. Se non è compatibile, descrivere il motivo concreto e implementare l'adattamento minimo nello stack attuale. Una differenza architetturale ordinaria non richiede di bloccare il lavoro o di riproporre la scelta del trasporto all'utente.

## Fase 1 — Tunnel e coordinamento nel servizio account

Implementare il minimo modello persistente necessario per collegare il tunnel al preciso host/environment/account e alla generazione della sua identità. Schema e migrazioni devono seguire i confini esistenti. Migrazioni additive: non riscrivere storia SQLite o Postgres.

Il servizio deve creare/ritrovare, configurare e dismettere il tunnel con operazioni idempotenti. Gestire richiesta duplicata, processo interrotto tra creazione e salvataggio, collisione hostname, errore DNS, quota esaurita e cleanup fallito. Non lasciare tunnel orfani senza traccia recuperabile. Evitare di tenere lock SQL durante chiamate lunghe a Cloudflare.

Autenticare la richiesta del Mini con le prove host esistenti; autorizzare proprietario, account/workspace e generazione. Il MacBook non deve poter ottenere il token connector del Mini. Pubblicare nella directory soltanto l'endpoint consentito e lo stato utile.

Gestire riavvio, unlink, disabilitazione remote, cambio account e identità sostituita. Una disconnessione momentanea non deve creare un nuovo tunnel a ogni tentativo. Un timeout di rete non equivale a cancellazione dell'account. Separare autorizzazione immediata e cleanup esterno ritentabile.

Uscita: API e contratti testati con Cloudflare simulato, inclusi errori intermedi e due richieste simultanee. Nessuna credenziale reale necessaria per questa fase.

## Fase 2 — Connector cloudflared sul Mini

Integrare cloudflared nel ciclo di vita dell'host riusando i confini platform/process esistenti. Non introdurre spawn, quoting Windows o teardown alternativi sparsi nel codice.

Definire una distribuzione riproducibile del binario: versione fissata, provenienza ufficiale, verifica integrità, piattaforme/architetture supportate e percorso nel pacchetto desktop. Per il target MVP provare macOS effettivo. Un cloudflared installato manualmente in PATH può aiutare lo sviluppo ma non dimostra l'esperienza utente finale.

Avviare soltanto dopo disponibilità dell'ingresso remoto e identità/account validi. Usare un listener loopback dedicato con percorso WebSocket consentito e negare le altre rotte. Se si riutilizza un ingresso esistente, dimostrare che header/proxy/loopback non concedano accesso amministrativo.

Gestire readiness reale, restart con backoff e jitter, cambio rete, sleep/wake, uscita app e cambio account. Non rendere la UI online soltanto perché il child process esiste. Gestire token rinnovati e invalidi senza loop serrati. Non lasciare processi figli dopo Stop o uscita.

Uscita: lifecycle testato, segreti redatti, connector avviabile sul runtime supportato e teardown verificato. Non avviare una seconda istanza sull'home o sulle porte personali.

## Fase 3 — Dialer Cloudflare e sessioni esistenti

Aggiungere il trasporto Cloudflare con un nome esplicito nei contratti, nella selezione del percorso e nelle superfici che mostrano lo stato. Preservare LAN/Tailscale/SSH dove già supportati senza richiedere all'utente una VPN.

Il controller deve raggiungere l'hostname del Mini, aprire il WebSocket esterno, verificare il TLS interno pinned e usare gli stessi grant, prove di possesso, sessioni e accessi a risorse. Non inviare credenziali controller come cookie o bearer al Mini e non inserirle nelle query string.

Conservare preferenze di percorso e timeout limitati. Uno switch di percorso richiede un nuovo trasporto verificato; non autorizza replay generico delle richieste. Coprire stream RPC, upload/download, Range, annullamento, backpressure e pool risorse.

Uscita: collegamento e trasferimento cifrato attraverso un proxy fixture che riproduce i confini Cloudflare; misrouting dell'hostname o root sbagliata rifiutati. La fixture non viene descritta come Cloudflare live.

## Fase 4 — Revoche e controllo senza relay proprietario

Sostituire esplicitamente la consegna di revoche prima di rimuovere il vecchio socket relay. Riutilizzare snapshot autorizzativi, tombstone persistenti e acknowledgement già esistenti.

Per l'MVP valutare un polling autenticato e limitato dell'API come soluzione minima; fissare frequenza, deadline, jitter, dimensione massima e comportamento durante outage. Scegliere un canale diverso solo se necessario ai requisiti. Non chiamare la revoca istantanea se è periodica.

Su revoca dispositivo chiudere RPC e risorse e rendere durevole il divieto. Su unlink/cambio proprietario disabilitare admission e tunnel della vecchia identità. Gestire il rifiuto della prova host dopo unlink: non continuare ad accettare sessioni per un errore interpretato come semplice disconnessione.

Rendere esplicito il ritardo massimo di revoca online e la politica offline; il rinnovo delle credenziali non deve prolungare indefinitamente l'accesso durante un guasto dell'API. Chiudere prima quanto è già certamente revocato e poi effettuare le chiamate di refresh.

Uscita: test di revoca online/offline, API 5xx, host cancellato, restart, acknowledgement perso e chiusura selettiva. Rimuovere il warning fuorviante che equipara assenza di SYNARA_RELAY_URL ad assenza di revoca.

## Fase 5 — Abbinamento breve e sicuro

Esperienza richiesta:

1. Stesso account Synara sui due Mac.
2. Sul Mini: Collega un dispositivo.
3. Codice leggibile a breve scadenza, ad esempio ABCD-1234 come formato illustrativo.
4. Sul MacBook: Aggiungi computer → inserisci codice.
5. Sul Mini: richiesta del MacBook → approva o rifiuta.
6. Il Mini resta in elenco e si collega in seguito senza ripetere il codice.

Oggi il bundle v2 contiene scope account, environment, host, root certificate/fingerprint, inviteId, segreto casuale da 256 bit e scadenza di dieci minuti. Il codice breve non deve essere il segreto esistente troncato né una password permanente.

Progettare un rendezvous autenticato, limitato allo stesso account/workspace, collegato all'invito del Mini e alla chiave del dispositivo richiedente. Generazione crittografica, formato senza caratteri ambigui, collisioni gestite, rate limit account/IP/tentativo, scadenza, consumo atomico, cancellazione e rinnovo espliciti. Due MacBook che riscattano insieme non devono ricevere entrambi approvazione.

Precisare il nuovo confine di fiducia del bootstrap: il bundle arrivato tramite cloud non è più un trasferimento fuori banda indipendente. Il successo di login o lookup del codice non deve produrre automaticamente fiducia nella root ricevuta. Conservare approvazione dell'esatta chiave e una verifica comprensibile dell'identità sui due schermi; usare primitive/protocolli consolidati se servono ulteriori garanzie. Non inventare crittografia né cifrare un segreto forte usando il solo codice corto come chiave.

Dopo abbinamento continuare con chiavi del dispositivo e trust durabile esistenti. Un utente diverso, codice scaduto/già consumato o root sostituita non entra. Distinguere questo flusso dall'enrollment account/headless già presente: un login account non equivale ad autorizzazione del Mini.

Conservare l'operatività headless della CLI senza mostrare segreti nei log. Un eventuale QR futuro deve utilizzare lo stesso invito/versione e nessun token permanente; non sviluppare ora l'integrazione iOS.

Uscita: test di scadenza, tentativi, replay, concorrenza, account errato, device revocato, cancellazione e identità cambiata. Primo pairing completato dai due controller fixture senza copiare JSON.

## Fase 6 — UI desktop e recupero della connessione

Riutilizzare pannelli, input, pulsanti e stati esistenti. Sostituire il JSON nel percorso ordinario con codice, copia, countdown e stato di attesa. Approvazione sul Mini deve identificare chiaramente quale dispositivo riceve accesso.

Mostrare condizioni concrete: da abbinare, in attesa di approvazione, disponibile, connessione in corso, riconnessione, offline, accesso revocato, riparazione necessaria. Errori devono offrire il prossimo passo corretto senza mostrare token o dettagli infrastrutturali inutili.

Aggiornamento UX 29 settembre: mantenere i progetti locali e remoti nella stessa sidebar e selezionare il computer per chat. Conservare ownership separata per ambiente, recovery editor, cancellazione di dial tardivi e fence su cambio account. Il cambio chat non ricarica la finestra. Il Mini esegue i task; il MacBook recupera eventi dopo cadute di rete senza rilanciarli.

Rispettare token text-ui, font scelto dall'utente, motion condiviso e accessibilità. Salvare evidenza visiva dei cambiamenti UI. Non introdurre nuovo scaffolding per iOS.

Uscita: prova browser del percorso codice → approvazione → Connect → chat locali/remoti insieme → reconnect → revoke, inclusa possibilità di tornare localmente con Mini offline.

## Fase 7 — Eliminare la dipendenza dal vecchio relay

Quando le fasi precedenti sono coperte, rimuovere dal percorso MVP supervisor/splice/ticket e deploy/config del servizio relay non più necessari. Verificare i consumer prima di rimuovere apps/relay o parti di packages/relay-protocol: conservare i contratti ancora usati da sessioni e crittografia.

Adeguare l'API, che attualmente richiede RELAY_SERVICE_TOKEN per WorkOS, e la propagazione di SYNARA_RELAY_URL in desktop/server. La configurazione Cloudflare deve fallire in modo esplicito se parziale; nessun fallback silenzioso al vecchio servizio.

Aggiornare ADR e guida operativa: la decisione del settembre 2026 supera il rifiuto di Cloudflare contenuto nell'ADR 0008. Conservare evidenza storica senza lasciare istruzioni contraddittorie per la nuova architettura.

Uscita: il percorso completo passa con il servizio relay spento e senza i suoi segreti. È documentato quali servizi servono davvero e quali sono stati eliminati.

## Fase 8 — Qualifica locale e pacchetto

Iterare con test mirati al comportamento. La matrice minima include:

- Tunnel provisioning idempotente, autorizzazione, timeout, errori parziali, cleanup e token isolation.
- Pairing con codice, un solo dispositivo approvato, root pinned e casi negativi.
- TLS/RPC/risorse attraverso tunnel fixture, Range e almeno 512 KiB verificati per hash.
- Stop/restart connector durante streaming e recupero senza reload né duplicazione del turno.
- Controller stop/restart con task che continua sul Mini.
- Rinnovo/scadenza, API outage e revoca che chiude sessioni e risorse.
- File, Git, terminale, approvazioni, Stop con stato persistito interrupted.
- Cambio account, disable remote, vecchia callback di connessione e teardown dei processi.
- Stable rifiuta remote; Beta/Canary rispettano i confini di dati e identità.

Aggiornare il workflow apps/e2e in modo che usi il percorso Cloudflare finale e non resti verde soltanto grazie al relay precedente. Fake WorkOS e provider deterministico rimangono appropriati nelle prove isolate.

Passaggio finale richiesto da AGENTS.md: bun run fmt:check, bun run lint, bun run typecheck e test Vitest interessati. Essendo un cambiamento fra pacchetti e di lifecycle, eseguire anche bun run test e la build/workflow costruito pertinenti. Eseguire bun run windows-runtime:check per i confini processo e bun run migrations:check per migrazioni. Usare bun run test, non bun test.

Verificare il connector nel runtime/pacchetto Electron sul Mini, incluso percorso binario e cleanup. Una build locale non è una release firmata. Registrare separatamente gli aspetti Windows/Linux non eseguiti.

Uscita: codice, documentazione e prove locali completati; elenco preciso di requisiti mancanti per il live test. Non fermare questa fase perché mancano credenziali cloud.

## Fase 9 — Collegare i servizi di test e provare due Mac

Solo dopo la qualifica locale preparare configurazione concreta e minimizzare le informazioni da richiedere all'utente:

- Account Cloudflare, zona/dominio dedicato, permessi API necessari e ambiente di test.
- WorkOS di test: client, redirect desktop/CLI, organizzazione/workspace e login sui due Mac.
- Un solo Postgres isolato per l'API. Decisione aggiornata: Supabase per il database e WorkOS per identità/login; seguire READINESS.md. PlanetScale resta una possibile migrazione futura, non una dipendenza richiesta. L'hosting dell'API è separato dal database.
- Hosting dell'API, issuer/JWKS, DNS e variabili realmente richieste.
- Modalità di distribuzione/installazione delle build test sui due Mac.
- Eventuale provider reale e limiti di spesa autorizzati.

Non chiedere segreti nel testo della chat né stamparli. Usare i canali di configurazione sicuri disponibili. Non creare risorse a pagamento o modificare ambienti personali/produzione come conseguenza implicita dei test locali. Se serve una decisione esterna, presentare prima setup e impatto concreti; continuare nel frattempo tutto il lavoro indipendente.

Test dal vivo: Mini su rete di casa, MacBook su rete diversa, nessuna VPN richiesta. Verificare login, abbinamento, conferma sul Mini, elenco persistente, task reale sul Mini, file/terminale/Git/risorse, stop, revoca e nuovo pairing.

Interrompere rete o connector e ripristinarli: task sul Mini deve proseguire dove possibile e controller deve riprendere gli eventi senza replay. Provare riavvio app e sleep/wake distinguendo impossibilità di lavorare durante lo stop del Mini da recupero successivo.

Misurare tempo di connessione, tempo di recupero, latenza di interazione, trasferimenti e uso risorse su entrambi i Mac. Registrare reti, build e condizioni; non attribuire a Cloudflare velocità superiore senza misura.

Per l'obiettivo 24/7 eseguire e registrare un soak di durata dichiarata, includendo almeno un rinnovo reale di credenziali. Le prove accelerate non sostituiscono il soak. Un Mini spento o addormentato resta indisponibile: il requisito è recupero affidabile, non uptime impossibile.

Uscita: rapporto con evidenze live, problemi riprodotti e correzioni. Senza accesso ai servizi/due Mac, segnare questa fase non eseguita e non dichiarare l'MVP qualificato dal vivo.

## Entitlement, rollout e limiti di scope

Prima di aprire la funzionalità ai clienti, individuare l'autorità di abbonamento già disponibile e applicare il gate sul server in provisioning, pairing e grant/rinnovi, oltre alla UI. WorkOS autentica l'utente; non è di per sé prova che abbia pagato. Non creare in questa task un nuovo sistema Stripe o un nuovo prodotto commerciale senza una richiesta.

Per la qualifica usare account di test autorizzati e gating esplicito. Se manca il contratto di entitlement reale, documentare il blocco al rollout commerciale senza nasconderlo dietro un flag UI.

Conservare la separazione Stable/Beta e i feature gate. Nessun merge in main, release, deploy di produzione, pubblicazione o modifica all'app iOS è incluso automaticamente. La precedente autorizzazione a salvare e pubblicare il lavoro sul branch di sviluppo non autorizza operazioni di produzione.

## Definizione di completamento

Distinguere tre risultati:

1. Implementazione completa: Cloudflare sostituisce il relay nel codice; pairing breve e revoca funzionano; documentazione e configurazione coerenti.
2. Qualifica locale completa: controlli richiesti ed end-to-end isolato passano sul nuovo percorso, con evidenza.
3. MVP qualificato dal vivo: Cloudflare e WorkOS reali, database di test, due Mac su reti diverse, recupero e revoca verificati.

Non confondere questi stati e non segnare completato ciò che è rimasto simulato. Il report finale deve contenere commit/branch effettivi, cosa è stato implementato, prove eseguite, errori residui, servizi predisposti e unico prossimo passo esterno necessario.

## Fonti operative

- Guida GPT-6 Astra: https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#prompting-best-practices
- Codex pairing documentato: https://learn.chatgpt.com/docs/developer-commands
- Codex remote prerequisites: https://learn.chatgpt.com/docs/remote-connections
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Creazione tramite API: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
- [Riferimento architetturale upstream e provenienza](UPSTREAM-COMPATIBILITY.md), da verificare sul commit corrente.

Codex è un riferimento di esperienza utente, non un backend da riutilizzare. Il progetto upstream è un riferimento architetturale, non prova automatica di compatibilità o costi per Synara. Durante l'implementazione ricontrollare documentazione ufficiale, versioni e licenze del codice eventualmente riusato.
