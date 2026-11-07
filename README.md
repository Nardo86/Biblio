# Biblioteca

Libreria self-hosted per EPUB e PDF: indicizza le cartelle che le indichi, mostra le copertine e
ti lascia leggere i libri direttamente nel browser. Gira in un solo container Docker con database
SQLite interno: nessun servizio esterno, nessuna chiamata di rete a runtime.

## Cosa fa

- **Scansione** ricorsiva delle cartelle di libreria (`LIBRARY_PATHS`), avviata all'avvio e
  ripetibile dal pulsante *Scansiona*. È incrementale: i file già indicizzati con stessa dimensione
  e data di modifica vengono saltati, quelli spariti dal disco vengono segnati come mancanti.
- **Metadati** da EPUB (titolo, autore, anno, lingua, descrizione, editore) e da PDF (dizionario
  Info e XMP). Se mancano, il titolo viene ricavato dal nome del file.
- **Copertine**: immagine di copertina dell'EPUB se presente, altrimenti prima pagina del PDF o
  prima pagina di testo dell'EPUB resa come immagine. Chi non ha copertina riceve una card
  colorata deterministica con le iniziali. Tutto generato in locale.
- **Libreria**: vista griglia o elenco, ricerca su titolo e autore, filtri per autore e formato,
  ordinamento. Scheda libro con tutti i dati e modifica manuale di titolo/autore/anno/descrizione
  (le modifiche manuali non vengono mai sovrascritte dalle scansioni successive).
- **Lettore**: PDF con pdf.js incluso nell'app (navigazione pagina, zoom, scorrimento continuo);
  EPUB servito dall'app con capitoli in iframe isolato, controllo dimensione testo e zoom.
  La posizione di lettura (pagina PDF, capitolo+scroll EPUB) viene salvata e ripristinata alla
  riapertura; la home mostra "Continua a leggere".

## Avvio rapido con Docker

```bash
docker compose up --build
```

Poi apri <http://localhost:8080>. Al primo avvio l'app indicizza la libreria di esempio inclusa
(`sample-library/`), così vedi subito quattro libri con le copertine.

### Usare le tue cartelle

In `docker-compose.yml` cambia il lato sinistro del volume della libreria:

```yaml
volumes:
  - "/home/mario/Libri:/books:ro"
```

Per più cartelle, montale e separa i percorsi con i due punti:

```yaml
environment:
  LIBRARY_PATHS: "/books:/more-books"
volumes:
  - "/home/mario/Libri:/books:ro"
  - "/home/mario/AltriLibri:/more-books:ro"
```

Le cartelle sono montate **in sola lettura**: l'app non modifica mai i tuoi file.
La porta pubblicata si cambia con la variabile `BIBLIOTECA_PORT` (default `8080`).

### Avvio senza Docker

```bash
npm install
LIBRARY_PATHS="/percorso/libri:/altro/percorso" npm start
```

Apri <http://localhost:3000>. `DATA_DIR` (default `./data`) indica dove stanno database e copertine.

## Configurazione

| Variabile | Default | Significato |
|---|---|---|
| `LIBRARY_PATHS` | `./sample-library` | Cartelle da indicizzare, separate da `:` |
| `DATA_DIR` | `./data` (`/data` nel container) | Database SQLite e copertine generate |
| `PORT` | `3000` | Porta HTTP interna |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto |
| `RESCAN_ON_START` | `true` | Scansione automatica all'avvio |
| `BIBLIOTECA_CONFIG` | `$DATA_DIR/config.json` | Percorso di un file di configurazione JSON |

File di configurazione opzionale (`data/config.json`), utile se non vuoi usare vari d'ambiente:

```json
{ "libraryPaths": ["/books", "/more-books"], "port": 3000 }
```

Le variabili d'ambiente hanno la precedenza sul file.

## Dove stanno i dati

Tutto ciò che l'app produce sta nella cartella dati (`/data` nel container, volume Docker
`biblioteca-data`):

```
/data
├── biblioteca.db        # database SQLite: libri, metadati, posizioni di lettura
└── covers/              # copertine generate (JPEG)
```

Le cartelle dei libri **non** vengono toccate: nessuna scrittura, nessun file temporaneo.

### Backup

Con Docker:

```bash
# ferma il container per una copia coerente del database
docker compose stop
docker run --rm -v biblioteca_biblioteca-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/biblioteca-backup.tar.gz -C /data .
docker compose start
```

Senza Docker basta copiare la cartella `DATA_DIR` (database + copertine). Per ripristinare,
rimetti la cartella al suo posto e riavvia: la scansione successiva ritrova i file e conserva
le modifiche manuali e le posizioni di lettura.

## Sviluppo

```
server/            Express + SQLite
  index.js         API HTTP e server dei file statici
  config.js        variabili d'ambiente e file di configurazione
  db.js            schema e apertura del database
  scanner.js       scansione incrementale, copertine, gestione errori per file
  covers.js        copertine: normalizzazione, card di testo, segnaposto SVG
  metadata/epub.js OPF, spine, capitoli, risorse interne all'EPUB
  metadata/pdf.js  metadati e rendering della prima pagina con pdf.js
public/            frontend vanilla JS (nessun bundler)
  app.js           routing, libreria, scheda libro
  reader-pdf.js    lettore PDF (pdf.js)
  reader-epub.js   lettore EPUB (iframe isolato)
tools/             script di supporto (vendor pdf.js, libreria di esempio, smoke test)
sample-library/    due EPUB e due PDF di esempio
```

Comandi utili:

```bash
npm start                      # avvia l'app
node tools/make-samples.mjs    # rigenera la libreria di esempio
node tools/smoke-test.mjs      # verifica parsing metadati e rendering copertine
node tools/vendor.mjs          # ricopia pdf.js in public/vendor (eseguito da npm start)
```

## Limiti noti (fuori da questa prima versione)

Arricchimento online delle schede (Open Library / Google Books), collezioni e tag, account
multiutente, annotazioni e ricerca full-text nel testo non sono implementati.

Il lettore EPUB non esegue JavaScript contenuto nei libri (iframe con sandbox): i libri che
dipendono da script per impaginare potrebbero risultare meno fedeli, ma i contenuti testuali
e le immagini vengono mostrati correttamente.
