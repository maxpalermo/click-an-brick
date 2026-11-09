# Click an Brick

Fusione di **Brick Scanner** (rebrick-me: fotografa pezzi → inventario → set costruibili)
e **Brickyard** (editor 3D LDraw → My builds → photo-to-bricks) in un unico progetto.

## Architettura (opzione B: monorepo, due backend, dati collegati)

Un solo container con due processi:

- **FastAPI :8000** — front door: app Scanner su `/`, app Builder su `/builder/`,
  `/ldraw` static, proxy `/by-backend/*` → Node `:8787`. Gestisce auth, inventario,
  librerie (bins), manuali, catalogo Rebrickable, sync.
- **Node 22 :8787** — server Brickyard: catalogo/packer LDraw, photo-to-bricks,
  builds e share links. Stesso login della parte Python (cookie `bs_session`
  validato contro `admin.db`).

### Un unico database per utente

- `data/admin.db` — utenti, sessioni, sync token, impostazioni (come rebrick-me).
- `data/users/<nome>/lego.sqlite` — **tutto il mondo dell'utente in un file**:
  inventory, bins, manuals, saved_projects, peers, meta **più** `builds`,
  `shared_models`, `part_map`, `color_map`. La sync CRDT (stessa di rebrick-me,
  con `X-Sync-Token`) unisce anche builds e shared models: un dispositivo scansiona,
  l'altro costruisce, tutto converge.
- `data/catalog.sqlite` — dump Rebrickable condiviso (rigenerabile).
- `shared_models`: lettura pubblica per id (link di condivisione); la POST
  richiede login e scrive nel DB del proprietario.

## Avvio

```bash
cp .env.example .env   # opzionale: ADMIN_PASSWORD, DEVICE_NAME, REBRICKABLE_API_KEY,
                       # FAL_KEY/STABILITY_KEY/ANTHROPIC_API_KEY (photo reale)
docker compose up -d --build
```

- Scanner: `http://localhost:8070/` (login: `admin` + password da .env o da `docker logs`)
- Builder: `http://localhost:8070/builder/` — stessa sessione, nessun secondo login
- Primo boot: scarica LDraw (~140 MB → volume `ldraw`) e importa il catalogo Rebrickable.

## Note

- Le route pubbliche del proxy (`/by-backend/ldraw/*`, `api/catalog`, `api/colors`,
  `api/parts/*`, `api/models/{id}` GET) restano aperte così un link condiviso è
  visibile anche senza account; tutto il resto richiede il login.
- Photo-to-bricks funziona in mock (paperella di prova) senza chiavi.
- `part_map`/`color_map` sono le tabelle ponte LDraw↔Rebrickable, risolte lazy:
  base per la feature "questo modello ce l'ho nei pezzi?".

## Progetti di origine

- `rebrick-me/` — Brick Scanner (inalterato)
- `brickyard/` — Brickyard (inalterato; qui vive solo app+server, niente cloud)
