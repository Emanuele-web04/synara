# Hub Synara e Claude Code Projects

Comparazione e piano di evoluzione · 2 ottobre 2026 · Analisi, non implementazione.

**Raccomandazione: evolvere gli Hub esistenti.** La base è già ampia; il miglioramento prioritario è rendere coerente il passaggio fra richiesta, delega, avanzamento e risultato. Prima correggere le istruzioni contraddittorie dei ruoli, poi rendere le richieste rintracciabili e introdurre coda, progress e reazioni alle PR. Riscrivere Hub, gateway o runner aumenterebbe il rischio senza risolvere meglio questi problemi.

La sensazione che Claude lavori meglio è plausibile per la continuità dell’esperienza, ma **non è una superiorità misurata**: non abbiamo eseguito gli stessi incarichi sui due prodotti. Qui distinguiamo capacità documentate, comportamento confermato dal codice e ipotesi da verificare dal vivo.

## 1. Perimetro ed evidenza

Snapshot Synara: `09461820111d083c028a843d35face33fd5a52dd`, branch `synara/compare-project-logic`. Working tree inizialmente pulito. Tre verifiche indipendenti con subagent GPT-6.1 Sol: runtime, prodotto/UI e fonti Claude; sintesi e controlli incrociati dell’agente principale.

- **Synara:** lettura di contratti, servizi, persistenza, gateway, reactor, componenti e documentazione. Non è una prova runtime/provider/browser dell’app.
- **Claude:** documentazione pubblica ufficiale verificata il 2 ottobre 2026. Nessun accesso al backend o a una sessione autenticata Claude Projects.
- **Blueprint allegato:** letto integralmente. È una descrizione adattata e una proposta per Synara; i prompt interni, i nomi MCP e il wake XML non sono contratti pubblici verificati.
- **Consegna:** questo piano e una vista HTML. Nessuna modifica applicativa, migrazione, pubblicazione o modifica dei modelli. Nessuna suite applicativa eseguita per questa analisi.

Il prodotto da confrontare è **Claude Code Projects**, con coordinatore e sessioni delegate. I Projects classici di Claude.ai con knowledge base/RAG sono un’altra esperienza: RAG non è un requisito dimostrato del nuovo coordinatore. [Projects classici](https://support.claude.com/en/articles/9517075-what-are-projects), [RAG](https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects).

Le descrizioni Claude nella matrice sono intenzionalmente sintetiche. Fonti primarie: [annuncio Projects](https://claude.com/blog/projects-redesigned), [guida Projects](https://code.claude.com/docs/en/claude-projects), [sessioni cloud e auto-fix](https://code.claude.com/docs/en/claude-code-on-the-web).

## 2. Cosa abbiamo, cosa manca

| Capacità                         | Claude documentato                                                                                                                          | Synara nel checkout                                                                                      | Valutazione / intervento                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Coordinatore e routing           | Nuovo lavoro, follow-up, risposta diretta. [Guida](https://code.claude.com/docs/en/claude-projects#send-work-and-read-results)              | Già previsti dal playbook. [S1]                                                                          | Presente; manca un contratto verificabile dell’instradamento. W1.                       |
| Più repository e lavoro non-code | Entrambi. [Annuncio](https://claude.com/blog/projects-redesigned)                                                                           | Hub senza repo, repository collegati, workspace per worker. [S2]                                         | Presente. Conservare questa versatilità; il blueprint mono-repo la ridurrebbe.          |
| Provider e modelli               | Claude; modelli/effort separati. [Guida](https://code.claude.com/docs/en/claude-projects#choose-models-and-let-claude-manage-context)       | Gateway multi-provider, routing e picker già disponibili. [S3]                                           | Punto di forza Synara; parità delle capacità da verificare per provider.                |
| Isolamento del codice            | Branch e copia per thread cloud. [Annuncio](https://claude.com/blog/projects-redesigned)                                                    | Worktree disponibili; nuovo Hub usa Local di default. [S4]                                               | Parziale: impostazioni per repo e policy esplicita dei nuovi task. W3.                  |
| Contesto comune                  | Istruzioni, memoria, file. [Annuncio](https://claude.com/blog/projects-redesigned)                                                          | Packet per turno, indice memoria, revisioni e Library. [S5]                                              | Presente. Correggere ruoli e distinguere istruzioni da dati. W0/W6.                     |
| Fedeltà del brief                | Dettaglio interno non pubblico.                                                                                                             | Prompt del coordinatore, senza messaggi originali/allegati copiati per ID. [S6]                          | Gap rispetto al blueprint, non inferiorità Claude dimostrata. W1.                       |
| Card sotto la richiesta          | Card collegate al messaggio. [Guida](https://code.claude.com/docs/en/claude-projects#send-work-and-read-results)                            | Righe Overview e link; manca la card Hub legata all’origine. [S7]                                        | Gap UX concreto. W1/W2.                                                                 |
| Progress e risultati             | Risultati nel thread. [Guida](https://code.claude.com/docs/en/claude-projects#send-work-and-read-results)                                   | Messaggi normali, monitor e riepiloghi nel coordinatore; nessuna checklist Hub revisionata. [S1][S7]     | Separare progress silenzioso, risultato e attenzione. W2.                               |
| Decisioni strutturate            | Protocollo del blueprint non verificato.                                                                                                    | Domande asincrone persistenti esistono, limitate a Codex top-level. [S8]                                 | Parziale; riutilizzare UI con contratto Hub distinto. W4.                               |
| Limite parallelo                 | Preferenza in chat, non hard cap. [Guida](https://code.claude.com/docs/en/claude-projects#tune-how-claude-runs-a-project)                   | Limite server, default massimo 8; oltre il limite errore, senza coda spawn. Settings non lo espone. [S9] | Garanzia già utile, esperienza incompleta. W3.                                          |
| Recovery e wake                  | Coordinamento continuativo. [Annuncio](https://claude.com/blog/projects-redesigned)                                                         | Inbox durable, cursor, coalescing, health ladder e proprietà dei turni. [S10]                            | Fondamenta già presenti. Estenderle, non sostituirle.                                   |
| Overview / PR                    | Review, Waiting, Working, Landing, Idle, Resolved. [Guida](https://code.claude.com/docs/en/claude-projects#see-what-needs-you-in-overview)  | Cinque bucket derivati; Landing è solo un’etichetta inutilizzata. [S11]                                  | Aggiungere stato PR fondato su evidenze. W5.                                            |
| Reazione a CI/review             | Auto-fix per PR. [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests)                                     | Lettura PR, commenti e polling UI; manca watcher Hub server che risvegli il worker. [S12]                | Gap funzionale importante. W5.                                                          |
| Routine                          | Programmazione ricorrente. [Guida](https://code.claude.com/docs/en/claude-projects)                                                         | Automazioni heartbeat, standalone, dedicated e schedule già esistenti. [S13]                             | Presente; collegare i nuovi eventi senza un secondo scheduler.                          |
| Memoria modificabile             | File editabili nelle impostazioni. [Guida](https://code.claude.com/docs/en/claude-projects#give-a-project-standing-context)                 | Note/index/dedup e revisioni; Settings View/Add, forget via agente. [S14]                                | Completare edit/delete e provenienza. W6.                                               |
| Library                          | Input e output condivisi. [Annuncio](https://claude.com/blog/projects-redesigned)                                                           | Upload, preview, filtri, history/restore Git, remote opzionale. [S15]                                    | Già ricca. Search cerca solo nomi nei folder caricati. W6.                              |
| Contesto nel tempo               | Recenti + memoria, non intera history. [Guida](https://code.claude.com/docs/en/claude-projects#choose-models-and-let-claude-manage-context) | Packet limitato a 32.000 caratteri; conversazione provider persistente. [S5][S9]                         | Valutare riciclo solo dopo misure e prova di continuità. W7.                            |
| Esecuzione a computer spento     | Cloud continua. [Cloud](https://code.claude.com/docs/en/claude-code-on-the-web)                                                             | Runtime sui propri host; questo audit non qualifica la disponibilità remota end-to-end.                  | Differenza infrastrutturale. Richiede host acceso; cloud gestito fuori da questo piano. |
| Voce esclusivamente via tool     | Non verificata pubblicamente.                                                                                                               | Transcript provider e tool normali; automazioni hanno già notify/silent. [S13]                           | Scelta di design opzionale, non prerequisito della versatilità.                         |

## 3. Problemi concreti prima delle nuove funzioni

### A. Worker istruito come coordinatore — confermato nel codice

`isCoordinatorLike` include i worker. Il packet inserisce il playbook che ordina di dirigere il lavoro senza scrivere codice, insieme alle regole Watch/redelegate. Lo stesso packet dice poi al worker di non essere il coordinatore. Il server, correttamente, gli impedisce di creare altri worker. [S5][S1][S16]

**Effetto possibile:** rifiuti inutili dei tool, ruolo ambiguo, risposta al posto dell’esecuzione. La contraddizione è provata; frequenza e impatto sui modelli non sono misurati. Prima modifica raccomandata: contesto distinto per coordinator, worker e member manuale.

### B. Due policy sulla prosecuzione — confermato nel codice

La policy generale impone attesa dei risultati e vieta thread sostitutivi senza nuova richiesta; il playbook Hub demanda al monitor e invita a sostituire worker falliti. [S13][S1] Serve una policy per ruolo che mantenga i vincoli generali di autorizzazione e lasci al server il recupero entro i limiti già previsti.

### C. Origine della richiesta non preservata nel prompt — limite confermato

Creazione e follow-up usano testo scritto dall’agente come messaggio `role: user`, con `dispatchOrigin: agent` interno e lista allegati vuota. Il modello non riceve un blocco separato con le parole originali copiate dal server. [S6] L’idempotenza della creazione protegge l’operazione nello stesso turno; non rappresenta da sola la continuità di una richiesta umana attraverso più wake. [S17]

**Conseguenza:** la fedeltà dipende dalla parafrasi del coordinatore; il collegamento richiesta → worker resta insufficiente per deduplica e card. Non è evidenza di un bypass delle autorizzazioni.

### D. Steering diverso da quanto descritto — confermato nel codice

Il tool descrive il fallback di `steer` come semplice accodamento. Il reactor, senza steering nativo e con turno live, accoda in testa e interrompe il turno in corso. [S18] Il default `queue` già attende: conservarlo per normali follow-up e milestone. Esplicitare e qualificare separatamente l’eventuale interruzione.

### E. Segnale di attenzione per repository collegati — inferenza statica forte

La sidebar passa al selector Hub ID e coordinator ID, senza `memberThreadIds`; il selector riconosce i membri in altri repository solo con quell’insieme. Il pannello usa invece task/index dei membri. Anche il segnale recovery `needsYou` non è allineato fra i due percorsi. [S19] Rischio: pannello che mostra un worker bloccato e sidebar senza indicatore. Da riprodurre in browser prima della correzione.

### F. Ricerca Library incompleta — limite esplicito

Il filtro confronta il percorso del file; l’albero include soltanto directory già caricate. Un file può non comparire nella ricerca finché il folder non è stato aperto. [S15] Risolvere prima la ricerca per nome sull’intero albero; full text e ricerca semantica sono fasi eventuali.

## 4. Cosa prendere dal blueprint, cosa correggere

| Proposta                                         | Decisione raccomandata               | Motivo                                                                                                      |
| ------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Originali utente separati dal brief              | Adottare                             | Riferimenti verificati dal server, revisioni e allegati preservano intenti e provenienza.                   |
| Wake con tipo e origine                          | Adottare nel modello esistente       | Tipi in contracts, delivery nell’orchestrazione e inbox attuali. XML è solo una possibile rappresentazione. |
| Progress silenzioso, risultato nel thread        | Adottare gradualmente                | Card e report chiari; coordinatore mantiene un riepilogo utile con link e alert azionabili.                 |
| Ogni frase del brief è un requisito              | Rifiutare                            | Contraddice la stessa distinzione principal/relay del blueprint. Un agente non genera autorizzazione umana. |
| Nuovo schema project/message/thread e nuovo MCP  | Evitare                              | Duplicherebbe entità, saga, session registry, gateway e migrazioni già disponibili.                         |
| Nuovi runner CLI generici                        | Evitare                              | Synara ha adapter e lifecycle specifici. Non sostituire SDK/app-server con ricette CLI del documento.       |
| Worktree = sandbox                               | Correggere                           | Il worktree separa file Git, non processi, rete o credenziali.                                              |
| Shared file: rileggi e poi scrivi                | Conservare le garanzie Synara        | Rileggere non evita lost update. Mantenere expectedRevision/CAS e Library versionata.                       |
| Stateless ogni wake = costo piatto, zero perdita | Sperimentare, non promettere         | Snapshot cresce, riciclo può perdere dettagli e cache. Prima misure e memoria sufficiente.                  |
| Nascondere sempre il testo normale               | Rinviare                             | Un provider può terminare senza i nuovi tool: serve fallback visibile per risultato, errore e domande.      |
| Continuare sul recommended mentre si aspetta     | Limitare al lavoro indipendente      | Una decisione necessaria o un’approvazione ancora aperta non è consenso.                                    |
| Ogni evento sveglia il coordinatore              | Sostituire con milestone deduplicate | Evitare loop progress → wake → progress, costi e rumore.                                                    |
| Ready significa CI green                         | Separare Review da merge-ready       | Le docs Claude indicano PR aperta in attesa di review. CI verde da sola non basta per il merge in Synara.   |

Altre ambiguità interne dell’allegato da non trasferire: una sola azione visibile contro multi-spawn; `failed` sia stato autonomo sia Waiting; `priority=now` senza contratto di cancellazione; replay con solo `delivered_at`; citazioni dichiarate top-level ma annidate. Sono problemi della proposta, non difetti dimostrati del backend Claude.

## 5. Architettura proposta

**Un’unica catena di responsabilità:** richiesta persistita → decisione di routing → ammissione/coda → worker → progress/risultato → proiezioni UI. Riutilizzare persistenza, receipts e riconciliazione delle wake. L’inbox attuale risveglia il coordinatore: per gli eventi PR diretti ai worker servono destinatario, payload e stato di consegna espliciti, prima dell’inoltro alla coda dei turni. [S20]

Le tre cose da tenere distinte sono:

1. **Richiesta:** cosa ha chiesto l’utente e quale revisione è stata inoltrata. Un messaggio può contenere più task; un follow-up può riguardare un task già esistente.
2. **Esecuzione:** tentativo, sessione e stato operativo. Un turno finito non significa task concluso; un retry non significa nuova richiesta.
3. **Consegna:** risultato, file, domanda e PR. Una PR aperta non significa pronta al merge; una PR chiusa senza merge non equivale a successo.

Estendere ProjectTask/managed-worker/eventi esistenti dopo una verifica del loro ownership, evitando un secondo task engine. Conservare API e chiavi persistite `groups`, route compatibili e gate Beta server/web. Migrazioni additive; nessun comportamento Hub attivo su Stable.

## 6. Piano eseguibile

Dimensione relativa: **S** modifica circoscritta; **M** un sottosistema e integrazioni; **L** stato persistente e più confini. Non sono stime temporali. Ogni unità deve poter essere revisionata e ripristinata separatamente.

### W0 — Ruoli coerenti e semantica dei follow-up · P0 · M

**Risultato:** un worker riceve il suo incarico, istruzioni/memoria del Hub e strumenti pertinenti; il coordinatore riceve routing, monitoraggio e vista aggregata.

- Separare il rendering del packet per ruolo. Etichettare istruzioni user-owned, stato server e report di altri agenti con provenienza distinta; nessun report diventa autorizzazione.
- Preservare i playbook personalizzati; aggiornare automaticamente solo quelli riconosciuti come system-authored. La separazione deve impedire che il playbook coordinatore, anche personalizzato, finisca nel packet worker.
- Specializzare la policy Hub senza allentare quella delle conversazioni normali. La health ladder resta responsabile dei retry automatici già consentiti; sostituzioni fuori policy restano decisioni esplicite.
- Conservare `queue` per follow-up ordinari. Correggere la descrizione `steer`; se il prodotto richiede comportamento uniforme, introdurre una policy esplicita di interrupt senza modificare silenziosamente i provider.
- Moduli: `projectAgent/Layers/ProjectAgentService.ts`, `projectBotPlaybook.ts`, `agentGateway/harnessPolicy.ts`, catalogo `AgentGateway.ts`; reactor solo se cambia il comportamento.
- **Accettazione:** worker mai invitato a coordinare; coordinator/member ancora corretti; normali follow-up non interrompono; steering nativo e fallback corrispondono alla policy dichiarata; permessi ruolo invariati.
- **Consegna:** due cambi focalizzati, packet/policy e descrizione/semantica steering. Nessuna migrazione necessaria per la prima parte. Rischio basso-medio, rollback del renderer/policy.

### W1 — Richieste originali e routing persistente · P1 · L

**Risultato:** «usa anche questo allegato» raggiunge il worker corretto con testo e allegato originali; retry e riavvio non moltiplicano il lavoro.

- Estendere create/send con riferimenti a messaggi persistiti e brief separato. Il server controlla accesso, Hub, autore e revisione; copia testo e riferimenti agli allegati secondo l’accesso del worker, senza fidarsi di `trust` fornito dall’agente.
- Memorizzare decisione di routing, motivazione breve, destinatari e stato di consegna. Riutilizzare sourceThread/sourceTurn e operation ID già esistenti.
- Chiave logica proposta: Hub + messaggio/revisione + taskKey fissato dal server alla prima decisione persistita, mai rigenerato liberamente dal modello al retry. Consente più task dallo stesso messaggio. Un follow-up aggiunge una consegna al task; riaprire o cambiare scope è un’azione distinta, non una collisione della deduplica. Aggregare le richieste/task decisi nello stesso turno nel piano congelato della saga; il ledger delle richieste raccorda i replay fra turni diversi.
- Inserire il record prima del dispatch; riconciliare crash fra prenotazione, creazione e ack attraverso la saga esistente. Verificare replay prima di respingere per nuova saturazione del limite.
- Moduli: `packages/contracts/src/agentGateway.ts`, `projectAgent.ts`, repository ProjectAgent, `AgentGatewayOperationRepository`, `creationCoordinator`, `AgentGateway`, proiezioni orchestration.
- **Accettazione:** due riavvii e retry danno un solo worker per taskKey; una richiesta composta crea il numero previsto; citazioni modificate/falsificate non acquistano autorità; allegati ancora leggibili con ownership corretta; vecchi thread senza origine restano navigabili.
- **Consegna:** schema/persistenza additivi e integrazione gateway in PR dipendenti. Rischio alto: compatibilità e retention degli allegati. Rollback disabilita il nuovo routing senza cancellare record.

### W2 — Card di lavoro, progress e attenzione · P1 · M/L

**Risultato:** sotto la richiesta compaiono i task relativi, con avanzamento e output; la chat del coordinatore resta leggibile.

- Collegare card a W1. Checklist/status revisionati e aggiornabili dal worker proprietario; distinguere stato riferito dall’agente e stato derivato dal runtime.
- Riutilizzare GroupOverview/righe, primitive disclosure e presentazione di `ActiveTaskListCard`, `ComposerActiveTaskListCard` e `PlanSidebar`, estraendo il renderer comune se necessario. Il piano provider viene azzerato a turno concluso: il dato Hub deve restare durabile e distinto, senza una seconda implementazione visuale della checklist. [S21]
- Riutilizzare notice e azioni Retry/Stop/Open. Un solo riepilogo per batch con risultati/link; errori e domande restano visibili. Non imporre tool-only voice: mantenere fallback per finali testuali e crash.
- Uniformare membership e `needsYou` di sidebar e pannello, includendo repository collegati. Questa correzione può uscire prima di W1 dopo riproduzione.
- Moduli: `projectAgent.ts`, `projectAgentTools.ts`, `GroupOverview.tsx`, `MessagesTimeline.tsx`, `WorkerMonitorNoticePill.tsx`, `SidebarGroupsSurface.tsx` e relative proiezioni.
- **Accettazione:** progress non produce notifiche né auto-follow; reconnect non duplica card; un worker linked bloccato accende entrambi gli indicatori; un batch con successo/fallimento/attesa comunica ogni esito; final testuale sempre recuperabile.
- **Consegna:** fix membership indipendente; progress backend e card dipendenti da W1. Rischio medio, rollback alla vista Overview senza perdita dei progress persistiti.

### W3 — Coda, limiti e workspace · P1 · L

**Risultato:** una richiesta di cinque task con limite tre avvia tre worker e mostra gli altri due in coda.

- Coda spawn persistente, distinta dalla coda di messaggi. Prenotazione atomica degli slot per evitare race fra batch; queued non crea processi/worktree prima dell’ammissione.
- Promuovere su rilascio slot, resume e recovery. Cancellazione, pausa, archive e repository scollegato impediscono nuovi avvii; backlog e motivazione restano visibili.
- La saga provider-session attuale richiede un turno chiamante ancora attivo. Il dispatch differito deve avere un ingresso server-owned fondato sulla richiesta autorizzata persistita W1, con accesso, lifecycle e cap rivalidati alla promozione. Non riutilizzare token/authority del turno ormai concluso e non disabilitarne i controlli. [S20]
- Definire slot per lavoro automatico ammesso: avvio, turno live e attesa nativa che ne conserva la proprietà; PR watcher e thread idle non occupano uno slot. Un task sospeso riacquisisce lo slot prima del nuovo turno. Non interrompere turni manuali per fare spazio.
- Esporre limiti, coda e preferenza propose-before-start nelle Settings. Proposta di default: tre worker automatici per nuovi Hub; preservare le impostazioni esistenti. È una scelta proposta, non un default già applicato.
- Preferire worktree per nuovi task di modifica codice, Local per non-code. Base branch e ambiente per repository/override del task, non un unico branch globale. Nessun fallback silenzioso da worktree fallito a directory condivisa.
- Moduli: config/contracts, ProjectAgent repository/service/reactor, saga `creationCoordinator`, GroupGeneral/Environment. Riutilizzare ProjectTask dove possibile.
- **Accettazione:** cap rispettato durante avvii concorrenti e dopo crash; pause zero nuovi dispatch; cancel queued zero processo/worktree; retry già eseguito riconosciuto anche a cap pieno; Local non-code resta supportato.
- **Consegna:** admission/coda prima della UX; dipende da W1 per richieste stabili. Rischio alto di starvation e slot persi: riconciliazione runtime + lease solo se necessaria. Rollback congela i queued e mantiene visibili i task.

### W4 — Decisioni Hub indipendenti dal provider · P2 · M

**Risultato:** un worker Claude, Codex o altro provider espone una domanda durevole con opzioni, conseguenze e raccomandazione.

- Contratto Hub aggiuntivo con question ID, worker, required/optional, opzioni, raccomandazione, stato e risposta revisionata. Riutilizzare `AsyncUserInputCard` e `UserInputQuestionForm` rendendo la presentazione generica.
- Non rimuovere la guardia del percorso Codex nativo: integrare un’origine Hub distinta. Riutilizzare messaggi/queue per la risposta, con idempotenza e accesso controllato.
- Una domanda opzionale non rende automaticamente il task bloccato; una decisione richiesta impedisce solo il lavoro dipendente. Un’opzione preselezionata non è una risposta, né un’approvazione di merge/publish.
- Le decisioni required alimentano summary e Waiting on you anche quando il worker è idle: una domanda asincrona non è una pending request nativa. Risposta, scadenza o revoca aggiornano lo stesso stato condiviso di sidebar e pannello.
- **Accettazione:** domanda sopravvive a restart/turno concluso; required + idle resta Waiting su entrambe le superfici; doppio click genera una risposta; provider diversi mostrano gli stessi campi; risposta/scadenza/revoca rimuove l’attesa senza riavviare lavoro non autorizzato; autorizzazioni native restano separate.
- **Consegna:** dopo W1, può procedere con W2. Rischio medio; fallback al thread con domanda visibile. Documentare in `docs/hubs.md` e `docs/providers.md`.

### W5 — PR watcher e stato verificabile · P1/P2 · L

**Risultato:** una CI rossa o una nuova review torna al worker proprietario anche con pannello chiuso; la UI distingue review, problemi e landing.

- Servizio server che riusa `PullRequestService.detail`, letture commenti e coda/cache GitHub. Watch persistente con repository, PR, worker proprietario e policy esplicitamente autorizzata: osservazione e auto-fix sono livelli diversi.
- Fingerprint per head SHA, checks e commenti/review; cambi della base verificati tramite polling. I contratti/mapping review attuali non preservano commitId/originalCommitId: estenderli per qualificare l’origine del finding. Non attribuire al commento l’head corrente al momento del poll; se non correlabile, evidenza non qualificata e nessun auto-fix. [S22]
- Estendere l’envelope durable con destinatario worker e payload PR, riusando receipts/cursor/reconcile ma senza travestire una review da evento di worker concluso. Deduplica e backoff evitano wake a ogni poll; stop su pausa/archive/disattivazione e finalizzazione coerente su merge/close.
- Conservare “Ready for review” come PR aperta da esaminare, accompagnata da badges CI/review/freschezza. “Pronta al merge” richiede prove aggiornate; Landing descrive approvazione/coda di merge effettiva, senza conferire al modello autorizzazione a unire.
- Policy bot esplicita: non trattare qualsiasi commentatore come istruzione. Per il workflow dell’operatore, Cursor Bugbot è il bot esterno di riferimento; rendere la policy configurabile anziché universale.
- **Accettazione:** cambio head invalida evidenza vecchia; stesso evento non genera fix doppi; commento ostile resta dato; rate limit/gh offline visibili; nessun merge/deploy/commento esterno fuori autorizzazione; riapertura PR gestita deliberatamente.
- **Consegna:** watcher read-only, poi dispatch/autofix autorizzato, poi UI. Dipende dalla provenance W1; usa W3 per l’ammissione automatica. Rischio alto, kill switch watcher e backlog preservato.

### W6 — Memoria e Library più utilizzabili · P2 · M

**Risultato:** correggere una preferenza e ritrovare un file non richiede una nuova conversazione con l’agente.

- Edit/delete delle note dalle Settings riutilizzando documenti revisionati, ma aggiungendo operazioni user-owned dedicate: oggi `writeDocument` non consente all’utente le note automatiche `memory/<date>-<slug>.md` e `forget` rifiuta il principal user. Non basta collegare un pulsante. Aggiornare atomicamente nota/indice in DB e riconciliare mirror/stream, conservando i confini di thread memory e indice generato. [S23]
- Provenienza minima: chi/cosa ha prodotto la nota, messaggio/task di origine, revisione; istruzioni umane distinte da conclusioni dell’agente. Moduli: contratti/RPC ProjectAgent, permessi memory in shared, repository/service e GroupMemorySection.
- Ricerca server per nome su tutto l’albero Library, con limiti/paginazione e vincoli sul root. Collegare output al task e riusare preview/history/restore.
- Non precaricare l’intera Library nel prompt. Indice leggero e lettura selettiva; full text solo dopo casi d’uso e misure, RAG semantico opzionale.
- **Accettazione:** due edit concorrenti non si sovrascrivono; edit/delete aggiornano indice, mirror e UI anche dopo restart; thread memory mantiene la propria ownership; file in directory mai aperta viene trovato; rename/delete non lasciano link falsi; provenienza non aumenta l’autorità dei contenuti.
- **Consegna:** memory UI e ricerca Library indipendenti; provenance estesa dopo W1. Rischio medio, nessun nuovo archivio parallelo.

### W7 — Coordinatore a contesto controllato · P2, dopo misure · M/L

**Risultato desiderato:** il coordinatore rimane preciso dopo molti task e restart senza reiniettare una cronologia crescente.

- Misurare token input, latenza, wake, informazioni omesse e cache per provider sul flusso corrente. Il limite di 32.000 caratteri del packet non limita tutta la history nativa.
- Prima migliorare selezione: istruzioni, indice memoria, richieste aperte, decisioni pendenti, delta di stato e report pertinenti. Esporre eventuali troncamenti e strumenti per recuperare il resto.
- Solo se le misure lo giustificano, checkpoint/versione del contesto e riciclo ai confini di turno. Preservare provider session semantics, questioni aperte e replay; niente restart durante tool/approval live.
- **Accettazione:** stessa informazione disponibile dopo riciclo per branch scelto, preferenza, task aperto e decisione; risultati non peggiori della baseline; costo/latency riportati separatamente, senza promessa “costo costante”.
- **Consegna:** misure/strumentazione locale, poi esperimento Beta reversibile. Nessuna raccolta diagnostica di contenuti. Rischio medio-alto; mantenere percorso sessione persistente come fallback.

## 7. Ordine e primo incremento raccomandato

| Fase       | Unità                              | Dipendenze                             | Cosa può uscire indipendentemente                       |
| ---------- | ---------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Coerenza   | W0; riproduzione/fix attenzione W2 | Nessuna nuova entità                   | Ruoli, descrizione steering, indicatore linked worker   |
| Continuità | W1 → W2                            | Origine persistita prima delle card    | Progress backend dopo contratto; UI con fallback legacy |
| Esecuzione | W1 → W3                            | Identità richiesta e saga              | Settings dopo admission; nessuna coda puramente visuale |
| Autonomia  | W1/W3 → W5; W1 → W4                | Ownership, eventi, capacità            | Watcher osservativo; decision card separata             |
| Contesto   | W6; W7                             | W6 base indipendente; W7 dopo baseline | Ricerca completa per nome e editing note                |

**Primo incremento:** W0 e riproduzione del segnale di attenzione. È piccolo, corregge contraddizioni effettive e rende più attendibile qualunque confronto successivo. **Primo incremento percepibile come esperienza Projects:** W1 + card/progress essenziali W2 + coda W3. PR watcher viene dopo questa catena affidabile.

Non serve una singola PR enorme. Usare PR indipendenti per i fix; stack soltanto dove lo schema/persistenza è una dipendenza reale, per esempio `main ← origine richieste ← integrazione gateway ← card`. Dopo il merge della base, riallineare le dipendenti. Nessuna PR aperta in questa fase.

## 8. Verifica della versatilità

Questi sono scenari di accettazione proposti, **non test già superati**. Per il confronto prodotto eseguirli anche su Claude con incarichi equivalenti; per le garanzie Synara usare inoltre test deterministici di persistenza e lifecycle. Registrare provider/modello/effort senza cambiarli silenziosamente.

| Scenario                                   | Esito richiesto in Synara                                    | Evidenza da raccogliere                                            |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Domanda rapida poi grazie                  | Risposta/reazione appropriata senza worker inutile           | Numero worker e messaggi visibili                                  |
| Tre richieste indipendenti in un messaggio | Tre task collegati allo stesso originale                     | Mapping e input ricevuti dai worker                                |
| Follow-up con file mentre il worker lavora | Stesso task, allegato corretto, queue ordinaria              | Trace dispatch, integrità allegato, nessuna interruzione implicita |
| Cinque task, cap tre                       | Tre ammessi, due queued; nessun oversubscription             | Reservation/avvii e ordine promozione                              |
| Restart dopo creazione prima dell’ack      | Un solo worker per task                                      | Replay durabile e stato dopo restart                               |
| Worker linked chiede approvazione          | Dot sidebar e pannello concordi; nessuna risposta automatica | Browser + stato server                                             |
| Progress durante lettura vecchi messaggi   | Nessun salto al fondo o notifica per checklist               | Test transcript e prova browser                                    |
| PR cambia head; arriva un finding vecchio  | Nessuna readiness/fix basata su prova stale                  | SHA/fingerprint e decisione watcher                                |
| Nota memoria modificata e nuovo worker     | Nuova revisione ricevuta, origine conservata                 | Packet effettivo e CAS                                             |
| Report in folder Library mai aperto        | Ricerca lo trova e apre il file corretto                     | Risposta server e browser                                          |
| Pausa, archive, Stable                     | Nessun nuovo dispatch Hub; stato conservato                  | Lifecycle, migrazioni e gate server/web                            |
| Riciclo coordinatore                       | Decisioni e richieste aperte ancora disponibili              | Confronto prima/dopo e consumo reale                               |

Misure utili: task duplicati; follow-up assegnati correttamente; richieste da ripetere; messaggi visibili per risultato; decisioni perse dopo restart; richieste automatiche di tool non consentiti al ruolo; wake/token per task. Stabilire baseline e risultati osservati prima di proporre percentuali di miglioramento.

Per ogni implementazione: test Vitest mirati tramite `bun run test`, poi `bun run fmt:check`, `bun run lint`, `bun run typecheck`. Suite più ampia per W1/W3/W5 e lifecycle; `bun run migrations:check` per migrazioni; `bun run windows-runtime:check` se si toccano confini process/platform. Qualificazione reale per Claude, Codex e OpenCode inizialmente, poi altri provider supportati. Nessun test mock dimostra avvio/cancellazione live o comportamento Windows confezionato.

## 9. Rischi, vincoli e scelte ancora aperte

| Rischio                                  | Valutazione      | Contromisura                                                                                  |
| ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| Report scambiato per istruzione/consenso | Alto impatto     | Provenienza server, ruoli, citazioni separate; enforcement degli strumenti resta autoritativo |
| Doppio spawn dopo crash                  | Alto impatto     | Identità richiesta + saga + riconciliazione, test su confini reali                            |
| Coda bloccata da slot persi              | Alto impatto     | Stato ammissione persistente, release idempotente, recovery senza interrompere l’utente       |
| Rumore o loop PR/progress/wake           | Medio-alto       | Fingerprint, milestone, backoff, policy di notifica                                           |
| Nascondere risultati per protocol miss   | Alto impatto     | Fallback transcript e errori sempre visibili                                                  |
| Memoria persa o auto-prompt crescente    | Medio-alto       | CAS, selezione, budget, checkpoint e confronto misurato                                       |
| Feature attiva in Stable                 | Alto impatto     | Gate `groups` su ogni nuovo tool/service/evento, migrazioni additive/inerti                   |
| Sovrapposizione di codice fra worker     | Dipende dai task | Worktree + ownership file/task; conflitti di merge restano possibili                          |

Scelte prodotto da valutare sul piano concreto: default tre o altro limite per nuovi Hub; quanto dettaglio lasciare nel coordinatore; opt-in di auto-fix PR; worktree come default per task di codice; eventuale modalità solo strumenti dopo averne dimostrato l’affidabilità. Nessuna scelta richiede fermare i fix W0.

Fuori da questo piano: cloud Synara gestito, sostituzione dei provider runner, nuovo database chat, RAG/vector database preventivo, redesign totale, nuove animazioni/virtualizzazione, cambio automatico di modello, merge/publish. Gli host remoti e i connector richiedono una qualificazione distinta se entrano nell’obiettivo.

## 10. Riferimenti al codice

I link sono relativi al repository; numero di riga riferito allo snapshot dichiarato. La guida corrente [Hubs](../hubs.md) è il riferimento prodotto da aggiornare in ogni fase; [Beta](../../BETA.md), [providers](../providers.md) e [contribution](../../CONTRIBUTING.md) definiscono i vincoli da preservare.

- **[S1] Routing e voce:** [projectBotPlaybook.ts:9](../../apps/server/src/projectAgent/projectBotPlaybook.ts#L9), routing 15–39, monitor/redelegate 75–84.
- **[S2] Multi-repo e non-code:** [core-concepts.md:240](../core-concepts.md#L240), [GroupEnvironmentSection.tsx:80](../../apps/web/src/components/chat/group/GroupEnvironmentSection.tsx#L80).
- **[S3] Modelli e gateway:** [projectAgent.ts:52](../../packages/contracts/src/projectAgent.ts#L52), [GroupGeneralSection.tsx:128](../../apps/web/src/components/chat/group/GroupGeneralSection.tsx#L128), [mcpInjection.ts:4](../../apps/server/src/agentGateway/mcpInjection.ts#L4).
- **[S4] Ambiente:** [groupSettingsDialog.logic.ts:113](../../apps/web/src/components/chat/group/groupSettingsDialog.logic.ts#L113), [creationCoordinator.ts:1118](../../apps/server/src/agentGateway/creationCoordinator.ts#L1118).
- **[S5] Contesto e ruoli:** [ProjectAgentService.ts:4625](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L4625), inclusione worker 4628, playbook 4750, Watch 4800, etichetta authoritative 4827.
- **[S6] Testo delegato:** [agentGateway.ts:67](../../packages/contracts/src/agentGateway.ts#L67), [creationCoordinator.ts:1170](../../apps/server/src/agentGateway/creationCoordinator.ts#L1170), [AgentGateway.ts:555](../../apps/server/src/agentGateway/Layers/AgentGateway.ts#L555).
- **[S7] Stato e rendering:** [ProjectTask:138](../../packages/contracts/src/projectAgent.ts#L138), [GroupOverview.tsx:210](../../apps/web/src/components/chat/project/GroupOverview.tsx#L210), [MessagesTimeline.tsx:1496](../../apps/web/src/components/chat/MessagesTimeline.tsx#L1496), [projectAgentTools.ts:404](../../apps/server/src/agentGateway/projectAgentTools.ts#L404).
- **[S8] Domande:** [asyncUserInput.ts:4](../../packages/contracts/src/asyncUserInput.ts#L4), [decider.ts:1787](../../apps/server/src/orchestration/decider.ts#L1787), [AsyncUserInputCard.tsx:16](../../apps/web/src/components/chat/AsyncUserInputCard.tsx#L16), [UserInputQuestionForm.tsx](../../apps/web/src/components/chat/UserInputQuestionForm.tsx).
- **[S9] Limiti:** [projectAgent.ts:24](../../packages/contracts/src/projectAgent.ts#L24), [authorizeManagedGoalCreation:4840](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L4840), [Settings baseline:121](../../apps/web/src/components/chat/group/groupSettingsDialog.logic.ts#L121).
- **[S10] Wake e recovery:** [ProjectAgentReactor.ts:14](../../apps/server/src/projectAgent/Layers/ProjectAgentReactor.ts#L14), [processPendingWakes:5497](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L5497), [workerHealth.ts:3](../../apps/server/src/projectAgent/workerHealth.ts#L3), [migrazione inbox:232](../../apps/server/src/persistence/Migrations/109_ProjectAgent.ts#L232).
- **[S11] Bucket:** [groupThreadState.ts:20](../../packages/shared/src/groupThreadState.ts#L20), derivazione 242–283.
- **[S12] PR:** [PullRequestService.ts:15](../../apps/server/src/pullRequests/Services/PullRequestService.ts#L15), [pullRequestOperations.ts:43](../../apps/server/src/pullRequests/pullRequestOperations.ts#L43), [useThreadPullRequests.ts:32](../../apps/web/src/hooks/useThreadPullRequests.ts#L32), [GitHubInboxService.ts:27](../../apps/server/src/githubInbox/Services/GitHubInboxService.ts#L27).
- **[S13] Harness e automazioni:** [harnessPolicy.ts:37](../../apps/server/src/agentGateway/harnessPolicy.ts#L37), report notify/silent 49–51, [automationTools.ts:314](../../apps/server/src/agentGateway/automationTools.ts#L314).
- **[S14] Memoria:** [GroupMemorySection.tsx:83](../../apps/web/src/components/chat/group/GroupMemorySection.tsx#L83), [remember:2888](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L2888), [writeDocument:4280](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L4280).
- **[S15] Library:** [LibraryPanel.tsx:110](../../apps/web/src/components/chat/group/LibraryPanel.tsx#L110), [libraryPanel.logic.ts:90](../../apps/web/src/components/chat/group/libraryPanel.logic.ts#L90), directory caricate 172–174, [libraryGit.ts](../../apps/server/src/projectAgent/libraryGit.ts).
- **[S16] Ruoli/enforcement:** [principal.ts:13](../../apps/server/src/projectAgent/principal.ts#L13), [ProjectAgentService.ts:6124](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L6124), [groupsBetaGate.ts:44](../../apps/server/src/projectAgent/groupsBetaGate.ts#L44).
- **[S17] Idempotenza:** [AgentGatewayOperationRepository.ts:64](../../apps/server/src/agentGateway/Layers/AgentGatewayOperationRepository.ts#L64), chiave/replay 98–110; [creationCoordinator.ts:356](../../apps/server/src/agentGateway/creationCoordinator.ts#L356).
- **[S18] Steering:** [AgentGateway.ts:526](../../apps/server/src/agentGateway/Layers/AgentGateway.ts#L526), [ProviderCommandReactor.ts:4194](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L4194), interrupt fallback 4214–4226.
- **[S19] Attention:** [SidebarGroupsSurface.tsx:127](../../apps/web/src/components/SidebarGroupsSurface.tsx#L127), [groupOverview.logic.ts:283](../../apps/web/src/components/chat/project/groupOverview.logic.ts#L283), [ProjectPanel.tsx:141](../../apps/web/src/components/chat/project/ProjectPanel.tsx#L141), recovery 240–246.
- **[S20] Authority e destinatari:** [creationCoordinator.ts:324](../../apps/server/src/agentGateway/creationCoordinator.ts#L324), [ProjectInboxEvent:332](../../packages/contracts/src/projectAgent.ts#L332), [wake coordinatore:5691](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L5691).
- **[S21] Progress riutilizzabile:** [ActiveTaskListCard.tsx:40](../../apps/web/src/components/chat/ActiveTaskListCard.tsx#L40), [ComposerActiveTaskListCard.tsx:21](../../apps/web/src/components/chat/ComposerActiveTaskListCard.tsx#L21), [PlanSidebar.tsx:114](../../apps/web/src/components/PlanSidebar.tsx#L114), [ChatView.tsx:1571](../../apps/web/src/components/ChatView.tsx#L1571).
- **[S22] Provenienza review:** [pullRequests.ts:70](../../packages/contracts/src/pullRequests.ts#L70), [git.ts:123](../../packages/contracts/src/git.ts#L123), [GitHubCli.ts:821](../../apps/server/src/git/Layers/GitHubCli.ts#L821).
- **[S23] Permessi memoria:** [canWriteMemoryDocument:93](../../packages/shared/src/projectAgent.ts#L93), [forget:2988](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L2988), [aggiornamento indice:4454](../../apps/server/src/projectAgent/Layers/ProjectAgentService.ts#L4454).
