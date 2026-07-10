# @estreem/openapi-socle

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
12. [Démarrer depuis un contrat legacy (Excel et Python)](#12-démarrer-depuis-un-contrat-legacy-excel-et-python)
13. [Faire évoluer un contrat d'interface](#13-faire-évoluer-un-contrat-dinterface)
14. [Créer une API de zéro](#14-créer-une-api-de-zéro)
15. [Monter la version du dictionnaire](#15-monter-la-version-du-dictionnaire)
16. [Développer le socle (ce dépôt)](#16-développer-le-socle-ce-dépôt)

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
# .npmrc — mappe le scope @estreem sur l'Artifactory interne
echo "@estreem:registry=https://artifactory.example.com/artifactory/api/npm/npm-local/" >> .npmrc

npm install -D @estreem/openapi-socle
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
└── schemas/         # schémas métier (top-level = nom du schéma), découpés par domaine
    └── *.yaml
```

- **`api.yaml`** : `type` (obligatoire, retiré du contrat final) + la partie `info`/`servers`/`tags`.
- **`paths/*.yaml`** : tous les fichiers sont fusionnés. Chaque route ne déclare **que ses
  réponses `2xx`** ; le reste est injecté.
- **`schemas/*.yaml`** : tous fusionnés dans `components.schemas` (les `$ref` fonctionnent
  entre fichiers). **Découpe recommandée : un fichier par domaine**, en calquant `paths/`
  (ex. `card-agreements.yaml`, `cards.yaml`, `common.yaml` pour les types partagés) plutôt qu'un
  seul gros fichier. Référencer par `$ref: '#/components/schemas/…'`.
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
  - **Plusieurs events → un swagger par event** : si un projet `events` déclare **plusieurs**
    events, le build produit **un contrat webhook par event** — `build/<projet>-<event>.openapi.yaml`
    (ex. `orders-events-order-created.openapi.yaml`), chacun réduit à ses seuls composants. Un
    **seul** event → un contrat unique `build/<projet>.openapi.yaml`. Chaque fichier a sa propre
    baseline dans `golden/`.

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

**Base path & version** (hors events) :
- si tous les paths partagent un préfixe de version (`/v1/…`), il est **remonté dans le base
  path** (server) et retiré des paths ;
- s'il n'y a **aucun server**, un base path par défaut est créé, **déduit du nom du contrat** :
  `https://api.mon-si.fr/<nom>/<version>` (hôte configurable via `--host <url>`) ;
- pour un import **`--type events`**, ni base path ni `servers` (webhooks poussés).

**Import d'events** — avec `--type events`, le swagger source est un contrat **normal** (un
`path` par event, le **nom de la ressource du path = nom de l'event**). L'import extrait le
`requestBody` de chaque opération comme **payload** et génère un fichier `events/<event>.yaml`
(métadonnées `x-event-*` depuis `summary`/`description`/`operationId`/`tags` + le schéma) :

```bash
openapi-socle import ./webhooks.yaml --type events --out-dir ./apis
# /order-created (POST, requestBody) → events/order-created.yaml (x-event-type: order-created, payload)
```

Les **schémas** sont répartis **par event** : `schemas/<event>.yaml` contient les schémas propres
au payload de cet event, et `schemas/common.yaml` ceux **partagés** par plusieurs events (au lieu
d'un unique `schemas.yaml`). Le build re-fusionne tout `schemas/` — la sortie est identique.

---

## 10. Mettre à jour le socle

Le socle est une **dépendance versionnée** (SemVer). Pour intégrer une nouvelle version :

```bash
npm install -D @estreem/openapi-socle@^2.0.0   # ou bump dans package.json
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
contrat, stampée automatiquement dans `info.x-socle-version` (et le type dans `info.x-socle-type`,
qui permet les règles Spectral par type).

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
  - project: 'estreem/socle-openapi-templates'
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

## 12. Démarrer depuis un contrat legacy (Excel et Python)

Beaucoup d'APIs existantes ont été produites par l'**ancienne méthode** : un fichier **Excel**
(la spec + le dictionnaire de données) et un **script Python** qui génère le swagger JSON. Pour
faire entrer une telle API dans le socle **en conservant les références au dictionnaire**, on
réalise une **migration one-shot** :

1. **Partir de l'Excel du dernier contrat validé** — la version de référence (celle réellement
   validée / en production), pas un brouillon.
2. **Régénérer le JSON** avec le script Python en activant l'extension des identifiants de
   dictionnaire dans le `.env` :
   ```dotenv
   ENABLE_EXTEND_SCHEMA_ESTREEM_FIELD_ID=true
   ```
   → chaque champ du swagger porte alors son `x-dictionary-id` (et les annotations `x-estreem-*`).
3. **Déposer la version correspondante du dico** dans le répertoire `dico/` du projet, et vérifier
   que `info.x-dictionary-version` du swagger pointe bien ce fichier :
   ```
   dico/_DICO_ESTREEM_vXX.YY.xlsx
   ```
4. **Lancer l'import** — il dé-factorise le contrat **en préservant** les `x-dictionary-id` sur
   les champs (body **et** paramètres) et `info.x-dictionary-version` :
   ```bash
   openapi-socle import ./swagger-genere.json --name mon-api --out-dir .
   ```
5. **Construire et valider contre le dico** :
   ```bash
   openapi-socle build ./mon-api
   openapi-socle check-dictionary ./mon-api
   ```
   Tous les champs annotés sont vérifiés (type, format, pattern, longueurs, enum, **types
   structurés**). Le **build retire** les annotations internes (`x-dictionary-id`, `x-estreem-*`)
   du contrat final, mais **conserve** `info.x-dictionary-version` pour la traçabilité.

> **Projets code-first** — si le swagger est **généré à partir du code** (Spring, etc.), il faut
> voir avec l'**équipe Foundation** comment faire remonter le `x-dictionary-id` dans le swagger
> généré : sur les champs des **request/response bodies** **et** sur les **paramètres de path et
> de query**. Sans ces `x-dictionary-id`, le check dico n'a rien à valider.

Cette migration ne se fait **qu'une fois**. Ensuite, le projet est un projet du socle normal et
évolue par delta (section 13).

---

## 13. Faire évoluer un contrat d'interface

Une fois la migration one-shot terminée, le contrat évolue **par delta**, selon le **process
standard** (specs, tickets Jira, revue de MR) :

1. **Modifier les sources** du projet (`paths/`, `schemas/`, `events/`) conformément à la spec.
2. **Pour chaque champ ajouté ou modifié, renseigner le `x-dictionary-id`** correspondant à
   l'élément du dictionnaire (et, si besoin, monter la version du dico — section 15). Un champ
   métier sans id remonte en **warning** ; un id inexistant ou une définition divergente **bloque**.
3. **Committer** le contrat régénéré — le changement se relit comme un diff de code.

**Ce que la CI/CD vérifie** à chaque push (bloque ✗ ou avertit ⚠ selon le doute) :

| Check | Outil | Rôle | En cas de problème |
|-------|-------|------|--------------------|
| **Dictionnaire** | `check-dictionary` | chaque `x-dictionary-id` conforme au dico | ✗ **bloque** (écart net) / ⚠ (ambigu) |
| **Validité** | Redocly | OpenAPI 3.1 valide | ✗ bloque |
| **Conformité socle** | Spectral | headers, erreurs, casing, règles par type… | ✗ bloque (règles `error`) / ⚠ (`warn`) |
| **Rupture** | oasdiff | comparaison à la dernière baseline publiée | ✗ bloque si rupture non assumée par une majeure |

**Si tous les checks passent**, la CI **génère et stocke, aux côtés du contrat bundlé**, les
**artefacts de code** dérivés du contrat :
- **Java serveur** (interfaces / stubs),
- **Java client**,
- **client JavaScript**.

Ces artefacts sont versionnés avec le contrat : les consommateurs ne codent pas à la main contre
le swagger, ils prennent le client généré.

---

## 14. Créer une API de zéro

Pas de contrat legacy : on part d'un **exemple** et on ne garde que son métier. `orders-exposed`
est un bon point de départ (`partner-payments-called` ou `orders-events` pour les autres types) :

```bash
cp -r node_modules/@monsi/openapi-socle/examples/orders-exposed ./mon-api
```

1. **`api.yaml`** — adapter `info` (title, version), `servers` (base path avec la **majeure d'URL**,
   ex. `/v1`) et `tags`. Si l'API s'appuie sur le dictionnaire, le déclarer et déposer le fichier
   dans `dico/` :
   ```yaml
   info:
     x-dictionary-version: _DICO_ESTREEM_vXX.YY.xlsx
   ```
2. **`paths/`** — décrire **uniquement** les routes et leurs réponses **2xx** ; le socle injecte
   headers, codes d'erreur, pagination et sécurité.
3. **`schemas/`** — les schémas métier. **Sur chaque champ** (body, et paramètres path/query),
   ajouter le `x-dictionary-id` de l'élément de dictionnaire correspondant :
   ```yaml
   cardholderId:
     type: string
     pattern: ^[0-9a-zA-Z\-]{1,36}$
     x-dictionary-id: '250331121313'   # → doit exister dans le dico et matcher type/pattern/longueurs
   ```
4. **Construire et vérifier** :
   ```bash
   openapi-socle build ./mon-api && openapi-socle check-dictionary ./mon-api
   ```

Les mêmes checks CI/CD que la section 13 s'appliquent — c'est le même contrat, sans l'étape de
migration. Voir §4–§7 pour l'anatomie d'un projet et les macros.

---

## 15. Monter la version du dictionnaire

Cas fréquent : le **dictionnaire évolue** (nouvelle version `.xlsx`) alors que l'API **n'a pas
changé par ailleurs**. Il faut re-vérifier la conformité et reporter d'éventuels changements du
dico sur les champs utilisés.

1. **Déposer la nouvelle version** dans `dico/` et pointer dessus :
   ```yaml
   info:
     x-dictionary-version: _DICO_ESTREEM_vXX.ZZ.xlsx   # nouvelle version
   ```
2. **Relancer le check dico** : `openapi-socle check-dictionary ./mon-api`
   - **Tout passe** → rien à faire côté champs ; c'est une évolution de traçabilité.
   - **Des écarts remontent** (un `x-dictionary-id` a changé de type / longueur / pattern / enum
     dans le nouveau dico) → **reporter le changement** sur le champ concerné (ajuster `type`,
     `maxLength`, `enum`… pour recoller au dico), ou mettre à jour le `x-dictionary-id` si
     l'élément a été renommé/remplacé.

**Quelle version d'API en sortie ?** — c'est **oasdiff** qui tranche, en comparant le contrat
régénéré à la baseline :

| Effet du report sur le contrat | Niveau | Action |
|--------------------------------|--------|--------|
| aucun changement (seule `x-dictionary-version` bouge) | `patch` | bump patch |
| ajout rétrocompatible (champ nullable, enum élargi…) | `minor` | bump mineure |
| **rupture** (type incompatible, `maxLength` réduit, enum restreint, champ rendu requis…) | `major` | **nouvelle majeure** |

**En cas de breaking change** (oasdiff sort `major` et bloque) : on **n'écrase pas** la majeure
en cours. On publie une **nouvelle majeure d'URL** (`/v2`) et on fait **coexister** `/v1` et `/v2`
le temps de migrer les consommateurs. La CI ne débloque que si la rupture est **assumée** par
cette nouvelle majeure (baseline distincte). Pour un correctif purement cosmétique faussement vu
comme cassant, ajuster le contrat plutôt que forcer.

**Cohérence version d'API ↔ base path** — la **majeure** de `info.version` (SemVer) doit
**correspondre** à la majeure du base path (`/v1`, `/v2`). Ex. : `info.version: 2.3.0` ⇒ base path
`…/v2/…`. Une divergence (du `2.x` servi sous `/v1`) est le signe qu'une rupture a été introduite
sans monter la majeure d'URL. C'est vérifié par la règle Spectral
**`socle-version-major-matches-basepath`** — en **`warning`** (à arbitrer / passer en blocage avec
l'équipe Foundation si besoin).

---

## 16. Développer le socle (ce dépôt)

```bash
npm install
npm test                 # tests unitaires (node:test) — voir ARCHITECTURE.md pour reprendre le code
npm run check:dictionary # (avant génération) valide les champs annotés x-dictionary-id contre le
                         #   dictionnaire Estreem dico/<info.x-dictionary-version> : type, format, pattern,
                         #   longueurs, enum (Codeset), digits. Écart net → erreur ; cas ambigu → warning.
npm run build            # construit examples/ → build/ (retire x-dictionary-id + x-estreem-* du contrat)
npm run lint             # validité OpenAPI (Redocly)
npm run spectral         # conformité au socle (Spectral : pas d'API key, headers communs, Idempotency-Key
                         #   par méthode, X-Processing-Route-Id en réponse, identifiants au format uuid,
                         #   nommage camelCase, items d'array, codes d'erreur contextuels par méthode
                         #   (404/409/422 + catalogue), règles par type (events/called via
                         #   info.x-socle-type), cohérence version majeure ↔ base path,
                         #   x-socle-version, operationId, tags…)
npm run check:regression # compare examples/ aux baselines golden/ (échoue sur rupture) — nécessite oasdiff
npm run release:notes    # release note (cassants / non cassants) du build vs golden — AVANT golden:update
npm run golden:update    # régénère les baselines golden/ (après un changement assumé)
npm pack --dry-run       # aperçu du package publié
```

Le pipeline complet en local : `npm run check:dictionary && npm run build && npm run lint && npm run spectral && npm run check:regression`.

**Passer une nouvelle version en golden avec une release note** — `golden/` = la dernière version.
Générer la note **avant** d'écraser les baselines, puis promouvoir :
```bash
npm run release:notes -- --out release-notes/$(date +%F).md   # diff build (nouveau) vs golden (dernier)
#   → tableau de synthèse par contrat + détail : ⚠️ cassants / ✅ non cassants, niveau SemVer global
npm run golden:update                                         # promeut le nouveau build en baseline
```
La note s'appuie sur `oasdiff changelog` (`level 3` = cassant). Sans `--out`, elle sort sur stdout.
Options : `--title "..."`, `--date YYYY-MM-DD`.

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
