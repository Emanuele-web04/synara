# Configurazione e prova dei profili Synara

Configurazione scelta: pagine pubbliche su Cloudflare Workers, API su Cloudflare
Containers, database PostgreSQL su Supabase, login tramite WorkOS. Railway non è
coinvolto. API e profili sono online nel trial Cloudflare dal 29 settembre 2026.
Database, segreti e WorkOS Staging sono configurati. La prova tecnica
privato → pubblico → privato è passata. Login reale e creazione del profilo
privato dall’app sono verificati; restano pubblicazione, sincronizzazione e
logout/nuovo login. Riparti dal punto 5; i punti precedenti documentano la configurazione.

## 0. Prima prova tecnica

Le modifiche sono ancora locali. Quando vengono portate in una PR, il workflow
**Verify and deploy account API to Cloudflare** verifica i test API, costruisce
l'immagine Linux e avvia il container su PostgreSQL temporaneo. Deve passare
prima del deploy. Non usa i dati o le credenziali Supabase.

Il pulsante **Run workflow** richiede che il file del workflow sia presente sul
branch predefinito GitHub. Una PR consente già la verifica automatica; per il
deploy manuale da Actions il workflow deve prima arrivare su `main`. In
alternativa si può pubblicare il checkout con Wrangler da una macchina con
Docker e autenticazione Cloudflare. Docker è ora installato su questo Mac; la
build Linux nativa ha superato la prova di avvio. Wrangler è ora autenticato e il container amd64 è avviato su Cloudflare.
Il workflow GitHub non è stato eseguito; il deploy è avvenuto dal checkout.

## 1. Database Supabase esistente — configurato

Per scelta dell'operatore usiamo **Synara** (`ubdkfrnaqfbdymgipddq`), lo stesso
progetto degli sponsor. Il 28 settembre 2026 il bootstrap `synara_accounts_bootstrap`
è stato applicato tramite MCP: 16 migrazioni API, 15 tabelle finali, RLS attiva e
registro Drizzle aggiornato con gli hash originali. I profili nascono privati.
L'accesso Data API alle nuove tabelle è revocato per `anon`, `authenticated` e
`service_role`; l'API usa una connessione PostgreSQL proprietaria delle tabelle.

Le nove tabelle `ad_*`, i loro permessi e le policy sono rimasti invariati.
Mantieni la Data API del progetto per gli sponsor; non modificare globalmente i
permessi né reimpostare la password PostgreSQL condivisa per questa prova.
Non applicare di nuovo il bootstrap: i prossimi avvii usano il registro Drizzle.

Il collegamento è completato: il ruolo dedicato `synara_account_api` possiede
le tabelle account e il registro Drizzle, con i permessi necessari alle
migrazioni e nessun accesso alle nove tabelle sponsor. La password PostgreSQL
condivisa non è stata cambiata. `DATABASE_URL` è salvato come segreto Cloudflare.

Il pooler è `aws-0-eu-central-1.pooler.supabase.com:5432`, con
`sslmode=verify-full` e
`sslrootcert=/app/apps/api/cloudflare/certs/supabase-root-2021.crt`.
Connessione TLS autenticata, replay delle migrazioni e lettura dal servizio
Cloudflare sono verificati. Non serve configurare Supabase Auth: il login
rimane in WorkOS. Vedi le
[istruzioni database](../../../apps/api/README.md#supabase-postgresql-with-workos).

## 2. Login su WorkOS

Il progetto di prova è **Synara's Project → Staging**. Magic Auth è stato
abilitato e verificato nel dashboard il 28 settembre 2026. `WORKOS_API_KEY` e
`WORKOS_CLIENT_ID` sono salvati come segreti cifrati nel Worker API. Rimane da
provare logout e nuovo login; il primo accesso da Synara è riuscito.
Anche la callback desktop `http://127.0.0.1:*/callback` è stata registrata via
MCP. WorkOS richiede una callback predefinita senza wildcard: è impostata a
`http://127.0.0.1/callback`; Synara passa sempre la porta effettiva nella richiesta.

Nel [dashboard WorkOS](https://dashboard.workos.com), seleziona o crea
l'applicazione AuthKit destinata al trial:

1. Abilita **Magic Auth**, per ricevere il codice via email. Non servono SMTP o
   Resend per questo percorso.
2. Recupera **API key** e **Client ID** della stessa configurazione WorkOS.
3. Se vuoi provare anche i pulsanti social, abilita i rispettivi provider e
   registra `http://127.0.0.1:*/callback` tra i redirect consentiti. Per un nuovo
   ambiente, aggiungi prima `http://127.0.0.1/callback` come default: WorkOS
   rifiuta una wildcard come callback predefinita.

La callback social torna all'app sul Mac, non a un percorso `/callback` del
Worker. Non impostare `IDENTITY_PROVIDER=dev` sul servizio pubblicato.

## 3. Credenziali per eventuali deploy da GitHub

Il trial è già pubblicato tramite Wrangler. Tutti i segreti sono già salvati
nei Worker: non rigenerarli. I segreti GitHub sotto servono solo per attivare
la futura pubblicazione da Actions.

Cloudflare → **My Profile → API Tokens → Create Token**: prepara un token per
l'account **Synara Orgs**, con accesso di scrittura ai Workers e ai Containers e
lettura delle impostazioni account. Il modello per modificare Workers è un
punto di partenza; includi il permesso **Containers Edit/Write**. L’accesso MCP ora consente le modifiche concordate, ma non fornisce
automaticamente una credenziale al workflow GitHub o a Wrangler.

Nel repository GitHub apri **Settings → Secrets and variables → Actions →
New repository secret** e configura:

| Nome                          | Valore                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`        | Token di deploy Cloudflare dell'account Synara Orgs           |
| `SYNARA_API_DATABASE_URL`     | Connessione del progetto Supabase Synara esistente            |
| `SYNARA_API_WORKOS_API_KEY`   | API key WorkOS                                                |
| `SYNARA_API_WORKOS_CLIENT_ID` | Client ID WorkOS                                              |
| `SYNARA_API_SIGNING_KEY`      | Chiave casuale stabile, 32 byte in base64url                  |
| `SYNARA_PROFILE_PROXY_SECRET` | Altro segreto casuale indipendente, condiviso dai due Workers |

Sul Mac puoi generare una chiave direttamente negli appunti, senza stamparla:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' | pbcopy
```

Solo per una nuova installazione priva di chiavi, esegui il comando una volta
per la signing key e una seconda volta per il proxy secret. Per questo trial
riusa invece le chiavi esistenti conservate fuori dalla repo: non ruotarle. Conserva la signing key:
non rigenerarla a ogni deploy. Non incollare i valori in chat.

L'ID dell'account Cloudflare è già fissato nella configurazione: non occorre
creare un ulteriore secret `CLOUDFLARE_ACCOUNT_ID` per questi workflow.

## 4. Pubblicare prima l'API, poi i profili

Quando il workflow è disponibile in Actions:

1. Esegui **Verify and deploy account API to Cloudflare**, con `deploy` attivo,
   sulla revisione verificata. Il job di pubblicazione parte dopo i test e la
   prova del container. Attendi che Cloudflare completi il provisioning.
2. Verifica l'API:

   ```sh
   curl --fail --silent --show-error https://synara-account-api-trial.synara-orgs.workers.dev/api/v1/instance
   curl --fail --silent --show-error https://synara-account-api-trial.synara-orgs.workers.dev/api/v1/keys/jwks
   ```

   Devono rispondere con JSON valido. Questo prova che il processo è avviato;
   non prova ancora WorkOS o il ciclo completo dei profili.

3. Esegui **Deploy Profiles**, indicando come `account_api_url`:
   `https://synara-account-api-trial.synara-orgs.workers.dev`.
   Non aggiungere `/api/v1`. I workflow configurano lo stesso proxy secret.

L'indirizzo delle pagine pubblicate è:
`https://synara-profiles-trial.synara-orgs.workers.dev/@nome`.
Per ora non modificare DNS o routing di `trysynara.com`.

## 5. Avviare un'app di prova isolata

Dal checkout con queste modifiche, esegui prima il dry-run:

```sh
SYNARA_ACCOUNT_URL=https://synara-account-api-trial.synara-orgs.workers.dev \
SYNARA_ACCOUNT_PROFILE_SYNC=1 \
VITE_PROFILES_PUBLIC_ORIGIN=https://synara-profiles-trial.synara-orgs.workers.dev \
bun run dev --home-dir /private/tmp/synara-profiles-check --dry-run
```

Controlla home e porte stampate; il runner cerca porte disponibili. Poi ripeti
lo stesso comando togliendo `--dry-run` e apri la porta web indicata. È una home
di prova separata, senza la cronologia della tua installazione abituale.

`SYNARA_ACCOUNT_URL` seleziona l'API; `SYNARA_ACCOUNT_PROFILE_SYNC=1` abilita
profilo e sincronizzazione delle statistiche aggregate. Il flag va usato soltanto
in Beta/sviluppo: Stable continua a rifiutarlo. `VITE_PROFILES_PUBLIC_ORIGIN`
seleziona il dominio per aprire/copiare/condividere il profilo e va impostato
all'avvio del dev server o quando si costruisce l'app, non dopo la build.

Se usi un token di autenticazione locale, server e browser devono avere quello
della stessa istanza; non cambiare la configurazione dell'app abituale.

## 6. Test di accettazione

| Prova                                      | Risultato richiesto                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Login con codice email                     | Si completa, con account e workspace corretti                               |
| Creazione profilo con handle nuovo         | Il profilo nasce privato                                                    |
| Apertura del link in finestra privata      | Nessun nome, avatar o statistiche visibili                                  |
| Attivazione della pubblicazione            | La pagina mostra il profilo; CSS e immagini si caricano                     |
| Copia/apertura/condivisione dall'app       | Il link punta al Worker trial, non al vecchio dominio                       |
| Una sessione di prova nell'istanza isolata | Le statistiche aggregate si aggiornano dopo la sincronizzazione             |
| Disattivazione della pubblicazione         | Una nuova richiesta nasconde il profilo; anche l'immagine OG torna generica |
| Logout e nuovo login                       | L'account ritrova il profilo salvato nel database                           |
| Richiesta a un handle inesistente          | Pagina non trovata, senza rivelare informazioni private                     |

Per la revoca verifica sia `/@nome` sia `/@nome/opengraph-image` con una nuova
richiesta: una pagina già aperta o un social che ha copiato un'anteprima non viene
ritirato dal nostro server. Controlla anche l'API pubblica:

```sh
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://synara-account-api-trial.synara-orgs.workers.dev/api/v1/profiles/NOME
```

Deve dare `404` da privato/inesistente e `200` da pubblico. Un `503` indica
servizio non pronto o errore di avvio; controllare i log, non trattarlo come un
profilo inesistente. Per isolare una mancata consegna email controllare WorkOS;
per un errore database controllare URL, TLS e migrazioni del servizio API.

L'upload degli avatar è ora configurato sul bucket R2 dedicato
`synara-profile-avatars-trial`, con le cinque variabili `S3_*` cifrate nel Worker
API e una chiave limitata a quel bucket. Il container è stato riavviato e
riconosce la configurazione. Il primo upload tramite **Edit → Edit avatar**
è riuscito; immagine R2 e pagina pubblica sono verificate. Restano da provare
sostituzione e rimozione.

Le immagini sono pubbliche tramite URL diretto anche se il profilo viene
reso privato, come autorizzato dall'operatore. Il dominio r2.dev serve al trial;
per il rilascio definitivo configura il dominio immagini di produzione.

Fonti: [callback WorkOS](https://workos.com/docs/reference/authkit/authentication/get-authorization-url),
[workflow manuali GitHub](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[token Cloudflare](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
[immagini Containers](https://developers.cloudflare.com/containers/guides/image-management/).
