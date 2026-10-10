# Hubs: implementazione dei punti 1–4

La prima fase integra ruoli, richieste originali, card/progress e coda persistente. Le PR automatiche restano fuori da questa fase. Riferimento: [comparazione e piano](./hubs-claude-projects-gap-analysis.md).

| Area          | Comportamento implementato                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ruoli         | Playbook, Watch e report aggregati solo al coordinatore. Worker e membri conservano istruzioni e memoria condivise. Playbook personalizzati preservati.                                                                                                          |
| Originali     | Il server risolve i messaggi umani persistiti, mantenendo testo, revisione e allegati separati dal brief. Risolve anche i messaggi nativi con `turnId:null` tramite il turno persistito. Ogni task riceve soltanto gli originali selezionati per quel task.      |
| Consegna      | Allegati clonati per thread/messaggio destinatario con ownership, hash e limiti verificati. Identità deterministiche e replay. I follow-up ordinari continuano a usare `queue`; la descrizione di `steer` rispecchia il comportamento dei provider.              |
| Durabilità    | Piano congelato per richiesta originale; retry e wake successivi restituiscono i task esistenti. Creazione e associazione worker usano la saga e la transazione esistenti. Le prenotazioni dei follow-up vengono riconciliate con le ricevute reali dei comandi. |
| Card          | Stato, checklist e risultato sotto il messaggio originale; apertura del worker quando esiste. Aggiornamenti revisionati, separati dal piano temporaneo del provider. Lo stato del runtime non dipende dalle spunte della checklist.                              |
| Attenzione    | Sidebar e header includono i worker posseduti dal Hub nei repository collegati e quelli che richiedono intervento dopo recovery. Le chat estranee del repository non illuminano il Hub.                                                                          |
| Coda          | FIFO persistente e ammissione atomica. Nuovi Hub: 3 worker simultanei; impostazione Parallel threads da 1 a 8. Limiti salvati preservati. Pause, archivio, cancellazione e repository scollegati impediscono nuovi avvii.                                        |
| Workspace     | Nuovi task su repository Git usano normalmente worktree; Hub e cartelle non-Git usano Local. Gli override per task restano validi; nessun ripiego automatico su Local se il worktree fallisce.                                                                   |
| Riepiloghi    | Un riepilogo per batch attende anche i task ancora in coda. Conserva risultati, link e il fallback quando un worker non deposita un risultato strutturato.                                                                                                       |
| Compatibilità | Migrazione 127 additiva, nomi API e storage esistenti mantenuti, funzionalità Hub inattive su Stable.                                                                                                                                                            |

Sono riutilizzati saga di creazione, ricevute orchestration, storage degli allegati, monitoraggio/recovery esistenti, refcount delle subscription WS, componenti disclosure e controlli Settings. La checklist visiva è condivisa tramite `TaskProgressSteps`; le card sono condivise fra transcript e pannello.

## Verifica

Le verifiche automatiche coprono SQLite e filesystem reali, confini della saga con dispatch/provider simulati, browser reale per le componenti UI e suite del repository. Non è stata avviata una sessione reale Claude/Codex/OpenCode per questa fase.

- Test specifici: replay fra turni, selezione degli originali, allegati leggibili dal destinatario, ownership, transazioni e compensazione, revoca durante preparazione, cap concorrente, crash delle prenotazioni, pause/cancel, progress revisionati, batch riepiloghi.
- Browser: card sotto la richiesta anche dopo aggiornamento, geometria, checklist, Settings, membership, attenzione recovery e polling condiviso.
- Gate repository: formato, lint, typecheck, test e lineage delle migrazioni. I risultati finali sono riportati sotto.

### Verifiche precedenti alla revisione

| Controllo                                                 | Risultato                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Suite server, runner ufficiale                            | 546 file, 7.270 test passati; 26 test saltati                |
| Altri workspace: web, desktop, contracts, shared, scripts | 7.311 test passati; 10 saltati                               |
| Regressioni mirate Hub/gateway/persistenza                | 54 file, 931 test passati (inclusi nella suite server)       |
| Browser focalizzato                                       | 6 specifiche, 30 casi passati                                |
| `bun run typecheck`                                       | 7 workspace passati                                          |
| `bun run fmt:check`                                       | Pass                                                         |
| `bun run lint`                                            | 0 errori; 808 warning complessivi del repository             |
| `bun run migrations:check`                                | Pass; migrazione 127 additiva, lineage dei 92 tag conservata |
| Link locali della documentazione e `git diff --check`     | Pass                                                         |

L'esecuzione diretta del pacchetto server con l'ambiente ereditato della sessione ha prodotto un
timeout nel test del refresh provider. Con il runner ufficiale `bun run test --filter=@synara/cli`,
che filtra quell'ambiente, sono passati sia i 110 casi ProviderHealth sia l'intera suite server.
Non sono state modificate le logiche ProviderHealth per aggirare il test.

## Revisione e correzioni automatiche

La revisione `check-code` ha riprodotto i difetti principali con test di regressione prima delle correzioni. I test mirati successivi sono passati: **946 casi server in 54 file e 38 casi Chromium in 6 specifiche**.

| Area                     | Difetto corretto                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identità delle richieste | Un `requestId` riutilizzato con originali diversi poteva creare un secondo batch. Un registro SQLite transazionale ora lega anche gli alias dei replay al piano iniziale.                                                           |
| Originali                | Riordinare le sorgenti non aggira più il blocco del piano. Ogni task conserva l'ordine esplicito dei messaggi selezionati.                                                                                                          |
| Slot e follow-up         | Steer nativo nello stesso turno, startup fallito e notifiche fallite dopo una scrittura potevano bloccare uno slot. La riconciliazione usa ricevute, messaggio persistito e stato causale del runtime.                              |
| Rollback                 | Una richiesta diversa non può annullare l'ammissione corrente; una ricevuta già accettata impedisce il rilascio dello slot.                                                                                                         |
| Cancellazione            | Un worker cancellato e riavviato manualmente conserva lo stato cancellato, ma occupa capacità mentre lavora.                                                                                                                        |
| Compensazione            | Un worker avviato ma non associato per errore transazionale mantiene lo slot finché il registro della creazione non conferma il completamento della pulizia. Un riavvio riprende la compensazione esistente senza creare sostituti. |
| Coda                     | Un errore di lettura in un Hub non interrompe più l'ammissione negli altri Hub.                                                                                                                                                     |
| Riepiloghi               | Il batch viene riepilogato anche con un solo worker creato e altri task falliti o cancellati prima dell'avvio.                                                                                                                      |
| Interfaccia              | Errori temporanei conservano membership e card; risposte RPC vecchie non sovrascrivono configurazioni più recenti. Il pannello usa la stessa fonte recovery di sidebar/header.                                                      |
| Limiti salvati           | Un limite storico superiore a 8 mostra il tetto effettivo di 8, conservando il dato salvato finché l'utente non lo modifica.                                                                                                        |

Refactor circoscritti: calcolo dello stato in `hubWorkLifecycle.ts`, ripristino condiviso delle ammissioni e scansione isolata per Hub. Sono stati riutilizzati repository, saga, stream e componenti esistenti; il registro delle identità completa la persistenza della nuova coda.

### Gate dopo le correzioni

| Controllo                  | Risultato                                                   |
| -------------------------- | ----------------------------------------------------------- |
| `bun run test`             | **14.597 passati, 36 saltati**, tutti i 6 workspace verdi   |
| Suite server               | 547 file passati, 7 saltati; 7.286 test passati, 26 saltati |
| Browser focalizzato        | 38 test passati in 6 specifiche                             |
| `bun run typecheck`        | 7 workspace passati                                         |
| `bun run fmt:check`        | Pass                                                        |
| `bun run lint`             | 0 errori, 808 warning complessivi                           |
| `bun run migrations:check` | Pass, lineage dei 92 tag conservata                         |
| Documentazione             | Link locali e `git diff --check` validi                     |

## Limiti pratici

- Gli originali testuali sono congelati, ma i blob allegati non vengono conservati indipendentemente dalla chat sorgente: eliminare o annullare il messaggio originale prima dell’ammissione può far fallire esplicitamente il task. La verifica di ownership resta attiva.
- Un upload allegato interrotto prima del completamento fallisce esplicitamente; non genera copie con nuove identità per aggirare il problema.
- Una creazione interrotta viene compensata conservativamente e resta fallita: non viene lanciato un worker sostitutivo senza una nuova richiesta.
- Un follow-up che deve riattivare un worker già esistente può essere respinto se tutti gli slot sono occupati. La coda FIFO riguarda la prima creazione dei task.
- Nei Hub chiusi, l'attenzione recovery si aggiorna al ritorno nella finestra e ogni 30 secondi mentre la finestra è visibile.
- La preferenza di proporre prima di avviare resta esprimibile nelle istruzioni del Hub; il ref Git resta un override del task. Questa fase non aggiunge pannelli dedicati per queste due preferenze.
- Le qualificazioni con provider reali e pacchetti desktop distribuiti restano distinte dai test locali.
