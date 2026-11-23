# Piano per la delega tra provider in Synara

Synara usa l’Agent Gateway come ingresso per i tool MCP. Il coordinatore scopre un target,
chiede al gateway di creare un figlio e legge il risultato tramite il normale ciclo di vita
dei thread. I subagenti nativi di Antigravity o di un altro provider seguono invece il
protocollo e il ciclo di vita del provider.

| Sintomo                                           | Confine da verificare                                     | Prova di accettazione                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Antigravity non vede i tool                       | Configurazione ACP, handshake MCP, catalogo consegnato    | Avvio e riapertura ricevono `initialize` e `tools/list`, poi l’agente legge `synara_capabilities`                                     |
| Antigravity non parte come figlio                 | Ammissione del target e permessi                          | Un padre in Approval required riceve un errore prima della creazione. Un padre autorizzato può usare Full access                      |
| Un modello Claude non è selezionabile da OpenCode | Catalogo dell’account OpenCode scelto e root del progetto | Un modello presente solo sul secondo account compare con il suo ID e viene accettato con quello stesso ID                             |
| Il secondo giro di review non parte               | Identità e budget della richiesta di creazione            | Due richieste valide nello stesso turno creano due operazioni. Il retry di ciascuna restituisce gli stessi ID                         |
| Il padre è fermo dopo la fine dei figli           | Ricevute durabili e ammissione del turno successivo       | La continuazione opt-in parte una volta dopo l’ultimo risultato, con lo stesso padre e solo se il suo turno d’origine è ancora valido |

## 1. Catalogo e ammissione

1. Rendere interrogabile il catalogo di uno specifico `instanceId` e costruire l’esempio
   di selezione con lo stesso account. Conservare la risposta senza filtro per client e
   agenti esistenti. Il filtro tiene limitato il contesto per installazioni con molti account.
2. Esporre stato disponibile, autenticazione e modalità compatibili con il chiamante.
   Applicare le regole di Synara sul server sia durante la discovery sia prima di creare
   risorse. La delega ad Antigravity via Agent Gateway richiede Full access. Le sessioni
   interattive possono usare Approval required. L’autorità di un padre resta il tetto per i figli.
3. Usare il catalogo dell’account OpenCode indicato per i modelli serviti da quel runtime.
   Claude Code come provider di un figlio è un target separato da Claude come modello di
   OpenCode. Un server OpenCode esterno configurato via URL resta sul percorso senza
   credenziale MCP interna perché il registro del server può essere condiviso.

## 2. Consegna MCP e diagnosi

1. Continuare a negoziare il trasporto nell’adapter ACP. Antigravity 1.5.14 usa il bridge
   stdio perché al momento dell’handshake non dichiara HTTP.
2. Correlare nei log debug locali l’avvenuta configurazione del gateway, l’inizializzazione
   MCP autenticata e la richiesta del catalogo. I log contengono fase e ID del thread.
   I risultati dei tool, i prompt e i bearer restano fuori da questi messaggi.
3. Verificare la chiamata effettiva su un profilo di test autenticato dentro una sessione
   nuova e una riaperta. Ripetere su desktop Windows con l’eseguibile realmente installato.
   Se il bridge si configura ma l’endpoint non riceve l’handshake, isolare il processo
   stdio prima di valutare un altro trasporto. La fase di configurazione da sola prova
   che la richiesta ACP si è conclusa, mentre la chiamata prova che il tool è utilizzabile.

## 3. Delega in più fasi e continuazione

1. Conservare la chiave durabile di ogni operazione e aggiungere `requestId` alla sua
   unicità per turno. Lo stesso ID e impronta riproducono la ricevuta, lo stesso ID con
   argomenti diversi restituisce un conflitto. Tenere il budget complessivo a 20 task
   per turno e destinazione, compresi i task già riservati.
2. Per una continuazione esplicitamente chiesta, salvare il profilo, la modalità e il
   turno del padre al momento dell’ammissione. Usare il registro dei risultati esistente
   per riconoscere la fine di tutti i run iniziali della fase. Solo un turno avviato
   dalla persona può programmare la continuazione automatica.
3. Ammettere un turno del padre tramite il comando durevole con ID deterministico.
   Ricontrollare il turno d’origine e l’autorità nella coda dei comandi, inclusi i casi
   in cui nel frattempo arrivano un messaggio o uno Stop. Il messaggio di continuazione
   contiene i riferimenti ai thread figli. Il loro output resta materiale di riferimento.
   Il percorso dei risultati passivi resta disponibile anche quando il padre viene
   superato da un nuovo turno.
4. Preservare la semantica degli Hub e delle integrazioni esterne. La continuazione
   automatica di eventi ACP nativi già staccati dal turno è un caso distinto. Va riprodotta
   con un provider reale prima di cambiare il consumo di notifiche a turno concluso.

## Verifica e rilascio

- Eseguire i test del gateway, dei provider e del decider. Coprire due richieste concorrenti
  sull’ultimo slot, conflitti di retry, completamenti fuori ordine e un padre superato.
- Verificare upgrade e replay da uno schema precedente con ricevute concluse e worktree in
  compensazione. Controllare che le chiavi e i risultati esistenti siano preservati.
  La migrazione richiede una revisione indipendente di dati, replay e backup prima del rilascio.
- Integrare prima la [PR Antigravity #2263](https://github.com/Emanuele-web04/synara/pull/2263)
  con la migrazione `145`. La migrazione dell’orchestration è la `146`.
- Eseguire formatter, lint, typecheck, test del workspace e controllo della lineage. Mantenere
  separata la prova locale con fixture da quella con runtime pagati e desktop pacchettizzato.
