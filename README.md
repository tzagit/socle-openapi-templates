# @monsi/openapi-socle

Socle de templating YAML pour écrire des contrats **OpenAPI 3.1** en ne spécialisant que le
nécessaire. Le socle factorise tout le commun (headers, codes d'erreur, format d'erreur,
pagination/tri, sécurité) ; un projet ne décrit que **ce qui lui est propre** : `info`,
`servers`, `tags`, ses `paths` (réponses `2xx` uniquement) et ses `schemas` métier.

👉 Spécification de référence : [`SPEC.md`](./SPEC.md).

---

## Sommaire

1. [Concepts](#1-concepts)
2. [Installation dans un projet](#2-installation-dans-un-projet)
3. [Démarrage rapide](#3-démarrage-rapide)
4. [Anatomie d'un projet](#4-anatomie-dun-projet)
5. [Les trois types d'API](#5-les-trois-types-dapi)
6. [Ce que le socle injecte automatiquement](#6-ce-que-le-socle-injecte-automatiquement)
7. [Macros](#7-macros)
8. [La CLI](#8-la-cli)
9. [Importer un OpenAPI existant](#9-importer-un-openapi-existant)
10. [Mettre à jour le socle](#10-mettre-à-jour-le-socle)
11. [Versioning & non-régression (CI)](#11-versioning--non-régression-ci)
12. [Développer le socle (ce dépôt)](#12-développer-le-socle-ce-dépôt)

---

## 1. Concepts

Un contrat final est assemblé en **3 couches**, de la plus générale à la plus spécifique
(la plus spécifique gagne en cas de conflit) :

| Couche | Fournie par | Contenu |
|--------|-------------|---------|
| **1 — core** | le socle | squelette OpenAPI, headers communs, erreurs, pagination, tri |
| **2 — profil** | le socle (choisi par le projet) | particularités du type `exposed`/`called`/`events` |
| **3 — projet** | ton équipe | `info`, `servers`, `tags`, `paths` (2xx), `schemas` |

Le build produit un OpenAPI 3.1 **bundlé et valide**, consommable par Swagger UI, un codegen,
une gateway, etc.

---

## 2. Installation dans un projet

Le socle est publié en package npm sur Artifactory. Dans le dépôt de **ton** API :

```bash
# .npmrc — mappe le scope @monsi sur l'Artifactory interne
echo "@monsi:registry=https://artifactory.example.com/artifactory/api/npm/npm-local/" >> .npmrc

npm install -D @monsi/openapi-socle
```

Puis dans `package.json` :

```json
{
  "scripts": {
    "build": "openapi-socle build .",
    "lint": "redocly lint build/*.openapi.yaml"
  }
}
```

---

## 3. Démarrage rapide

Un projet minimal `exposed` de bout en bout :

```bash
mkdir mon-api && cd mon-api
```

**`api.yaml`** — le strict minimum (couche 3) :
```yaml
type: exposed
info:
  title: Mon API Commandes
  version: 1.0.0
  description: API de gestion des commandes.
servers:
  - url: https://api.mon-si.fr/commandes/v1
tags:
  - name: orders
```

**`paths/orders.yaml`** — ne déclarer que les réponses `2xx` :
```yaml
/orders:
  get:
    tags: [orders]
    operationId: listOrders
    summary: Liste des commandes
    x-paginated: '#/components/schemas/Order'   # → 200 Page<Order> + page/size/sort
    responses:
      '200': ~
  post:
    tags: [orders]
    operationId: createOrder
    summary: Crée une commande
    requestBody:
      required: true
      content:
        application/json:
          schema: { $ref: '#/components/schemas/OrderInput' }
    responses:
      '201':
        description: Commande créée.
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Order' }
```

**`schemas/order.yaml`** — map de schémas métier (fusionnée dans `components.schemas`) :
```yaml
Order:
  type: object
  required: [id, status, amount, createdAt]
  properties:
    id:        { type: string, format: uuid }
    status:    { type: string, enum: [PENDING, CONFIRMED, SHIPPED, CANCELLED] }
    amount:    { type: number, format: double }
    currency:  { type: string, default: EUR }
    createdAt: { type: string, format: date-time }
OrderInput:
  type: object
  required: [amount]
  properties:
    amount:   { type: number, format: double }
    currency: { type: string, default: EUR }
```

**Générer le contrat** :
```bash
npx openapi-socle build .        # → build/mon-api.openapi.yaml
npx redocly lint build/*.openapi.yaml
```

Le contrat produit contiendra automatiquement les headers communs, le catalogue d'erreurs
contextuel, l'enveloppe de pagination, les headers de réponse et la sécurité — que tu n'as
pas eu à écrire.

---

## 4. Anatomie d'un projet

```
mon-api/
├── api.yaml         # type + info + servers + tags
├── paths/           # 1 fichier par ressource ; chaque clé est une route
│   └── *.yaml
└── schemas/         # schémas métier (top-level = nom du schéma)
    └── *.yaml
```

- **`api.yaml`** : `type` (obligatoire, retiré du contrat final) + la partie `info`/`servers`/`tags`.
- **`paths/*.yaml`** : tous les fichiers sont fusionnés. Chaque route ne déclare **que ses
  réponses `2xx`** ; le reste est injecté.
- **`schemas/*.yaml`** : tous fusionnés dans `components.schemas`. Référencer par
  `$ref: '#/components/schemas/…'`.
- **`events/*.yaml`** *(type `events` uniquement)* : un fichier par event (JSON Schema du
  payload + métadonnées `x-event-*`) ; le build génère les webhooks (cf. §5).

---

## 5. Les trois types d'API

Le champ `type:` de `api.yaml` choisit le profil.

| `type` | Qui expose | Rôle |
|--------|-----------|------|
| `exposed` | mon SI | API que j'expose à un partenaire (baseline) |
| `called` | le partenaire | API que je définis mais que le partenaire expose (je suis client) |
| `events` | mon SI (push) | webhooks poussés vers mes partenaires |

- **`called`** ajoute le header `X-Processing-Route-Id`. La sécurité (bearer JWT) est commune à
  tous les types.
- **`events`** bascule les opérations sous **`webhooks:`**, ajoute les headers d'event, envoie
  le **payload brut** (pas d'enveloppe) et attend un **ack `204`** (+ catalogue d'erreurs commun).
  On déclare chaque event dans
  un fichier de **`events/`** (JSON Schema du payload + métadonnées `x-event-*`) ; le build en
  génère le webhook :
  ```yaml
  # events/order-created.yaml  (type: events)
  x-event-type: order.created                # clé du webhook + marqueur x-event
  x-event-version: "1.0.0"
  x-summary: Émis lorsqu'une commande est créée
  x-description: Notifie le partenaire de la création d'une commande.
  $ref: '#/components/schemas/Order'         # payload brut ($ref ou schéma inline)
  ```
  Métadonnées : `x-event-type` (obligatoire), `x-event-version`, `x-summary`, `x-description`,
  `x-operation-id`, `x-tags`, `x-deprecated`. Un `$ref` nu est réutilisé tel quel ; un schéma
  inline est enregistré comme composant `<EventType>Event`.

---

## 6. Ce que le socle injecte automatiquement

Tu n'as **pas** à écrire ceci — le build l'ajoute :

- **Headers de requête communs** sur chaque opération : `X-Request-Id`, `X-Correlation-Id`,
  `X-Institution-Id` (le seul requis), `X-User-Id`, `X-UserContext-Id`. `called`/`events`
  ajoutent `X-Processing-Route-Id` ; `events` ajoute les headers d'event.
- **`Idempotency-Key`** : requis sur `POST`/`PATCH`, optionnel sur `PUT`/`DELETE`.
- **Catalogue d'erreurs contextuel** (`StandardError`) :
  toujours `400 401 403 405 406 429 500 502 503 504` ; **`404`** si l'opération a un paramètre
  de path ; **`409`** si écriture (`POST/PUT/PATCH/DELETE`) ; **`422`** si `requestBody`.
- **Headers de réponse communs** sur chaque `2xx` (échos + `X-Processing-Route-Id`).
- **Pagination** (via `x-paginated`) : enveloppe `Page` = `content[]` + `pagination` (`page`,
  `size`, `totalElements`, `totalPages`, `hasNext`, `hasPrevious`) et params `page`/`size`/`sort`.
- **Sécurité** : **bearer JWT** généralisé à tous les types (`exposed`/`called`/`events`),
  défini au socle. **Aucune API key** (politique interne).
- **Champs optionnels → nullable** : à la génération, une propriété absente de `required` devient
  nullable (`type: [<type>, "null"]`, OpenAPI 3.1). **Par défaut en requête, pas en réponse**
  (nullable en réponse est un changement cassant). Configurable par projet via `nullableOptionals`
  dans `api.yaml` : `false` (rien) · `true` (défaut) · `{ requests: bool, responses: bool }`.

Surcharge par opération possible via `x-errors` / `x-no-errors` (§7).

---

## 7. Macros

| Macro | Effet |
|-------|-------|
| `x-paginated: '#/components/schemas/Item'` | `200` renvoyant `PageOf<Item>` + params `page/size/sort`. |
| `x-errors: [409, 412]` | Ajoute des codes d'erreur à l'opération. |
| `x-no-errors: [429]` | Retire un code d'erreur hérité. |
| `x-event: nom.event` | (events) marqueur documentaire du type d'event. |

Désactiver la pagination sur une route : ne pas mettre `x-paginated` (ou `x-paginated: false`).

---

## 8. La CLI

```bash
openapi-socle build [projet|conteneur] [--out <dir>] [--project <nom>]
openapi-socle import <in.yaml|json> [--name <n>] [--type exposed|called|events] \
                     [--out-dir <dir>] [--no-factor] [--force]
```

**`build`** — construit un projet ou un conteneur de projets :
```bash
openapi-socle build .                      # le dossier courant est un projet → build/<nom>.openapi.yaml
openapi-socle build . --out dist           # sortie personnalisée
openapi-socle build ./apis                 # ./apis est un conteneur : build tous ses projets
openapi-socle build ./apis --project orders  # un seul projet du conteneur
```

Un dossier qui contient un `api.yaml` est un **projet** ; sinon il est traité comme un
**conteneur** (un sous-dossier par API).

**`diff`** — compare deux contrats et déduit le niveau SemVer (via `oasdiff`) :
```bash
openapi-socle diff baseline.yaml build/mon-api.openapi.yaml
# stdout : major | minor | patch   ·   exit 1 si changement cassant
```
Nécessite `oasdiff` sur le `PATH` ou Docker (image `tufin/oasdiff` en repli). Voir §11.

---

## 9. Importer un OpenAPI existant

Transforme un contrat OpenAPI 3.0/3.1 déjà rédigé (fichier unique, bundlé) en projet du socle,
en retirant tout ce que le socle réinjecte et en reconstruisant les macros :

```bash
openapi-socle import ./legacy.yaml --name mon-api --out-dir ./apis
openapi-socle build ./apis/mon-api
```

L'import :
- retire les headers communs, erreurs, pagination, sécurité et schémas socle ;
- **remet en conformité** les headers et codes d'erreur non conformes ; **conserve** les
  headers custom ; **purge** les schémas orphelins ;
- **factorise** les schémas inline répétés dans `components.schemas` (`--no-factor` pour désactiver) ;
- convertit `nullable` 3.0 → 3.1 ; détecte le type (`events` si `webhooks`).

Si le contrat source est éclaté en plusieurs fichiers, bundle-le d'abord :
`npx redocly bundle in.yaml -o bundled.yaml`.

**Import d'events** — avec `--type events`, le swagger source est un contrat **normal** (un
`path` par event, le **nom de la ressource du path = nom de l'event**). L'import extrait le
`requestBody` de chaque opération comme **payload** et génère un fichier `events/<event>.yaml`
(métadonnées `x-event-*` depuis `summary`/`description`/`operationId`/`tags` + le schéma) :

```bash
openapi-socle import ./webhooks.yaml --type events --out-dir ./apis
# /order-created (POST, requestBody) → events/order-created.yaml (x-event-type: order-created, payload)
```

---

## 10. Mettre à jour le socle

Le socle est une **dépendance versionnée** (SemVer). Pour intégrer une nouvelle version :

```bash
npm install -D @monsi/openapi-socle@^2.0.0   # ou bump dans package.json
npm run build
git diff build/                               # relire le diff du contrat généré
```

Le contrat généré étant commité, la mise à jour se **revoit comme un diff**. Un changement
**cassant** du socle (ex. renommage d'un champ de pagination) sort en version **MAJOR** : ton
projet reste sur l'ancienne majeure jusqu'à ce que tu choisisses de migrer.

---

## 11. Versioning & non-régression (CI)

Trois versions à ne pas confondre : la **version d'API** (`info.version`, SemVer), la **majeure
d'URL** (`/v1`, `/v2` — la frontière de rupture), et la **version du socle** qui a généré le
contrat, stampée automatiquement dans `info.x-socle-version`.

**Détecter une rupture** : `openapi-socle diff <baseline> <revision>` classe les changements
(via `oasdiff`) et sort le niveau SemVer requis :

| Sortie | Signification | Exit |
|--------|---------------|------|
| `patch` | aucun changement de contrat | 0 |
| `minor` | changement rétrocompatible (ajout) | 0 |
| `major` | **changement cassant** | **1** |

**Template GitLab CI** prêt à l'emploi : `ci-templates/api-contract.yml`. Dans le `.gitlab-ci.yml`
de ton projet :

```yaml
include:
  - project: 'monsi/socle-openapi-templates'
    ref: v1.0.0
    file: '/ci-templates/api-contract.yml'
variables:
  API_NAME: mon-api
  ARTIFACTORY_OPENAPI_URL: "https://artifactory.example.com/artifactory/openapi-local/mon-api"
```

Il fournit trois jobs : **`openapi:lint`** (Redocly), **`openapi:breaking`** (échoue si une
rupture n'est pas assumée par une nouvelle majeure, en comparant à la dernière baseline publiée),
et **`openapi:release`** (sur tag `vX.Y.Z`, publie le contrat versionné sur Artifactory).

**Où est définie la baseline ?** — selon le contexte :

| Contexte | Baseline | Défini par |
|----------|----------|-----------|
| Projet en CI | le contrat publié sous `…/latest/openapi.yaml` | la variable `ARTIFACTORY_OPENAPI_URL` (le job `openapi:release`, sur tag, publie/actualise ce `latest/`) |
| Socle (ce dépôt) | le dossier `golden/` (committé) | `npm run golden:update` (chemin figé dans `tools/check-regression.mjs`) |
| Ad-hoc / local | le fichier de ton choix | le 1er argument de `openapi-socle diff <baseline> <revision>` |

## 12. Développer le socle (ce dépôt)

```bash
npm install
npm run build            # construit examples/ → build/
npm run lint             # validité OpenAPI (Redocly)
npm run spectral         # conformité au socle (Spectral : pas d'API key, headers communs, Idempotency-Key
                         #   par méthode, X-Processing-Route-Id en réponse, identifiants au format uuid,
                         #   x-socle-version, operationId, tags…)
npm run check:regression # compare examples/ aux baselines golden/ (échoue sur rupture) — nécessite oasdiff
npm run golden:update    # régénère les baselines golden/ (après un changement assumé)
npm pack --dry-run       # aperçu du package publié
```

Le pipeline complet en local : `npm run build && npm run lint && npm run spectral && npm run check:regression`.

**Installer `oasdiff`** (requis par `check:regression` et `openapi-socle diff`) :
```bash
curl -fsSL https://raw.githubusercontent.com/oasdiff/oasdiff/main/install.sh | sh
# à défaut, avoir Docker : le wrapper utilise l'image tufin/oasdiff en repli
```

**Non-régression du socle** — `golden/` contient les contrats de référence des `examples/`.
Le job CI `non-regression` (`.gitlab-ci.yml`) régénère les exemples et échoue si un changement
des templates est **cassant** (via `oasdiff`), forçant à l'assumer par une **MAJOR** du socle et
à régénérer les baselines (`npm run golden:update`).

Arborescence :
```
bin/openapi-socle.mjs    # CLI (build | import)
tools/build.mjs          # moteur d'assemblage (exporté + CLI)
tools/import.mjs         # importer OpenAPI → projet
templates/core/          # couche 1
templates/profiles/      # couche 2 — exposed | called | events
examples/<nom>/          # projets d'exemple (non publiés dans le package)
```

Exemples fournis : `examples/orders-exposed`, `examples/partner-payments-called`,
`examples/orders-events`, `examples/swagger-petstore` (importé depuis le Petstore officiel).
