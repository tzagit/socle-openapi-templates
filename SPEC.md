# SPEC — Système de templating YAML pour OpenAPI

## 1. Objectif

Fournir un **socle de templating YAML** servant de base à l'écriture de contrats
OpenAPI, de sorte que n'importe quel projet puisse démarrer **en ne spécialisant
que ce dont il a besoin** :

- la partie `info` du swagger,
- ses `paths`,
- ses réponses de succès (`200`/`201`/`2xx`) et leurs schémas.

Tout le reste (headers communs, codes d'erreur, headers de réponse, pagination,
tri, format d'erreur) est **factorisé** et hérité automatiquement.

## 2. Les 3 types d'API

| Type | Qui expose | Qui appelle | Rôle du contrat |
|------|-----------|-------------|-----------------|
| **Exposed** | Mon SI | Un partenaire / consommateur | API que **j'expose**. C'est la **baseline** : elle définit le socle commun. |
| **Called** | Le SI partenaire | Mon SI | API **que je définis** mais **exposée par le partenaire**. J'écris le contrat que le partenaire doit respecter, et que je consomme. |
| **Events** | Mon SI (push) | Le partenaire reçoit | Swagger **webhook** : je définis des **events** poussés vers mes partenaires. Reste techniquement un `webhooks:` (OpenAPI 3.1) ; le **type** s'appelle `events`. |

**Règle de factorisation :**
> Les headers et les codes retour communs sont définis **au niveau `exposed`**
> (la baseline). `called` et `events` **héritent** de ce socle et **ajoutent**
> leurs particularités. Idem pour les headers de réponse, communs pour la plupart.

## 3. Principes de conception

1. **Spécialisation minimale** — un projet ne redéfinit jamais ce qui est commun.
2. **Composition en couches** — chaque contrat final = `socle` ⊕ `profil` ⊕ `projet`.
3. **Convention over configuration** — pagination page-based, tri, format d'erreur
   `StandardError` appliqués **par défaut**, désactivables/surchargeables au cas par cas.
4. **Une seule source de vérité** — les composants communs vivent à un seul endroit
   et sont référencés par `$ref` ; jamais copiés-collés.
5. **Sortie standard** — le build produit un OpenAPI **bundlé et valide**,
   consommable par n'importe quel outil (Swagger UI, codegen, gateway…).

## 4. Modèle en couches

Chaque contrat est construit par assemblage de 3 couches, de la plus générale à la
plus spécifique. En cas de conflit, **la couche la plus spécifique gagne** (deep merge).

```
┌─────────────────────────────────────────────┐
│  Couche 3 — PROJET                           │  info, servers, tags,
│  (fourni par chaque équipe)                  │  paths + réponses 2xx,
│                                              │  schémas métier
├─────────────────────────────────────────────┤
│  Couche 2 — PROFIL (exposed|called|events)   │  particularités du type
│  (fourni par le socle, choisi par le projet) │  (headers/réponses en +)
├─────────────────────────────────────────────┤
│  Couche 1 — SOCLE COMMUN (core)              │  squelette OpenAPI,
│  (fourni par le socle)                       │  headers, erreurs,
│                                              │  pagination, tri
└─────────────────────────────────────────────┘

contrat_final = deepMerge(core, profil[type], projet)  →  resolve($ref)  →  expand(macros)
```

- **`exposed`** ≈ profil identité : il n'ajoute (quasi) rien au socle, il **est** la baseline.
- **`called`** = socle + headers d'appel sortant (`X-Processing-Route-Id`, auth partenaire…).
- **`events`** = socle + `X-Processing-Route-Id` + headers de signature, et bascule
  `paths` → `webhooks`.

## 5. Arborescence proposée

Le socle est **publié en package npm** (`@monsi/openapi-socle`) : `bin/`, `tools/` et
`templates/` sont livrés dans le package ; un projet consommateur ne contient que sa couche 3
et appelle `openapi-socle build .`. Les `examples/` ne sont pas publiés.

```
openapi-socle/  (le package — ce dépôt)
├── SPEC.md
├── package.json                 # name @monsi/openapi-socle, bin, files
├── bin/openapi-socle.mjs        # CLI : build | import
├── templates/
│   ├── core/                    # COUCHE 1 — commun à tous
│   │   ├── base.yaml            # squelette OpenAPI
│   │   ├── headers/{request,response}.yaml
│   │   ├── responses/errors.yaml
│   │   ├── schemas/{error,page}.yaml   # StandardError ; Page + Pagination
│   │   └── parameters/{pagination,sorting}.yaml
│   ├── profiles/                # COUCHE 2 — exposed | called | events
│   └── README.md
├── examples/                    # projets de démonstration (NON publiés)
│   └── <api>/{api.yaml, paths/, schemas/}
├── build/                       # sortie générée (bundled OpenAPI par projet)
└── tools/
    ├── build.mjs                # merge des couches + expansion des macros (exporté + CLI)
    └── import.mjs               # importer OpenAPI existant → projet

dépôt-projet/  (chez le consommateur)  # COUCHE 3 uniquement
├── package.json                 # devDep @monsi/openapi-socle ; script "openapi-socle build ."
├── api.yaml                     # type + info + servers + tags (le minimum)
├── paths/                       # 1 fichier par ressource (paths + réponses 2xx)
├── schemas/                     # schémas métier du projet
└── build/                       # <projet>.openapi.yaml généré
```

## 6. Le socle commun (couche 1)

### 6.1 Headers de requête communs (tous types)

| Header | Type | Requis | Rôle |
|--------|------|--------|------|
| `X-Request-Id` | string `uuid` | non | Identifiant unique de la requête (traçabilité). |
| `X-Correlation-Id` | string `uuid` | non | Corrélation d'un flux multi-appels de bout en bout. |
| `X-Institution-Id` | string | oui (**toujours**) | Institution / entité à l'origine de la requête. |
| `X-User-Id` | string | non | Utilisateur à l'origine de la requête. |
| `X-UserContext-Id` | string | non | Contexte utilisateur (session / rôle / habilitation). |

> Headers typés **`uuid`** (`format: uuid`) : `X-Request-Id`, `X-Correlation-Id`,
> `Idempotency-Key` (§6.2).

**Spécifique `called` + `events`** (en plus des communs) :

| Header | Type | Requis | Rôle |
|--------|------|--------|------|
| `X-Processing-Route-Id` | string | non | Route de traitement (dispatch/orchestration interne). |

### 6.2 Idempotence (`Idempotency-Key`)

Header typé **`uuid`** (`format: uuid`), injecté automatiquement selon la
**méthode HTTP** de l'opération :

| Méthode | `Idempotency-Key` |
|---------|-------------------|
| `POST` | **obligatoire** |
| `PATCH` | **obligatoire** |
| `PUT` | optionnel |
| `DELETE` | optionnel |
| `GET` / `HEAD` | non applicable |

### 6.3 Headers de réponse communs (tous types)

Les headers de réponse sont l'**écho des headers de requête**, mais **tous optionnels**,
plus `X-Processing-Route-Id` **toujours présent** en réponse :

| Header | Requis | Rôle |
|--------|--------|------|
| `X-Request-Id` | non | Écho de l'identifiant de requête. |
| `X-Correlation-Id` | non | Écho de la corrélation. |
| `X-Institution-Id` | non | Écho de l'institution. |
| `X-User-Id` | non | Écho de l'utilisateur. |
| `X-UserContext-Id` | non | Écho du contexte utilisateur. |
| `X-Processing-Route-Id` | oui | Route de traitement ayant produit la réponse (présent pour **tous** les types). |

### 6.4 Codes retour communs (tous types)

Réponses d'erreur factorisées, réutilisées par `$ref` sur les opérations :

`400` `401` `403` `404` `405` `406` `409` `422` `429`
`500` `502` `503` `504`

**Injection contextuelle** — toutes les erreurs sont injectées **sauf quand elles
ne sont pas pertinentes** pour l'opération. Règles appliquées par le build :

| Erreur | Injectée seulement si… |
|--------|------------------------|
| `404` | l'opération a **au moins un paramètre de path** (ex. `/orders/{id}`). Pas d'id → pas de `404`. |
| `409` | méthode d'écriture (`POST`/`PUT`/`PATCH`/`DELETE`). |
| `422` | l'opération a un `requestBody` (validation métier). |
| autres | injectées sur toutes les opérations. |

Surcharge possible par opération via `x-errors` / `x-no-errors` (§9.2).

> Les **réponses de succès (`2xx`) restent à la charge du projet** — c'est le seul
> code retour que chaque path doit déclarer explicitement.

### 6.5 Format d'erreur — `StandardError`

Toutes les réponses d'erreur du socle utilisent le schéma commun `StandardError`.
Tous les champs sont **optionnels** :

```yaml
StandardError:
  type: object
  properties:
    code:          { type: string, minLength: 1, maxLength: 20,  description: "Code d'erreur applicatif stable." }
    text:          { type: string, minLength: 1, maxLength: 40,  description: "Message d'erreur destiné au consommateur." }
    developerText: { type: string, minLength: 1, maxLength: 70,  description: "Détail technique à destination des développeurs." }
    moreInfo:      { type: string, maxLength: 256,               description: "Complément d'information / lien de documentation." }
```

## 7. Spécificités par type (couche 2)

### 7.1 `exposed` — la baseline
N'ajoute rien de plus que le socle. Éventuellement :
headers de rate-limit en réponse (`X-RateLimit-Limit`, `-Remaining`, `-Reset`).
La sécurité (**bearer JWT**) est généralisée au socle et vaut pour tous les types.

### 7.2 `called` — j'appelle le partenaire
Ajoute côté **requête** le header commun aux appels internes :

| Header | Requis | Rôle |
|--------|--------|------|
| `X-Processing-Route-Id` | non | Route de traitement (dispatch/orchestration interne). |

- `security` : **bearer JWT** (généralisée au socle, comme tous les types ; API key exclue).
- Attentes de SLA/timeout documentées (extension `x-sla`).
- (`Idempotency-Key` reste géré au socle, par méthode — cf. §6.2.)

### 7.3 `events` — je pousse des events
- Bascule des opérations sous **`webhooks:`** (OpenAPI 3.1), pas `paths`.
- Ajoute `X-Processing-Route-Id` en requête (comme `called`).
- Ajoute des headers **optionnels** de traçabilité vers la requête d'origine
  (la requête métier qui a déclenché l'event) :

| Header | Requis | Rôle |
|--------|--------|------|
| `X-Original-Request-Id` | non | `X-Request-Id` de la requête à l'origine de l'event. |
| `X-Original-Correlation-Id` | non | `X-Correlation-Id` de la requête à l'origine de l'event. |
| `Original-Idempotency-Key` | non | `Idempotency-Key` de la requête à l'origine de l'event. |
- **Pas d'enveloppe** : le **payload de l'event est envoyé brut** dans le `requestBody`
  (le schéma métier du projet, tel quel). **Toutes les métadonnées passent en
  headers dédiés** — le corps ne contient que la donnée fonctionnelle.

- Headers d'**event** obligatoires (injectés automatiquement sur chaque opération) :

| Header | Type | Requis | Rôle |
|--------|------|--------|------|
| `X-Event-Id` | string `uuid` | oui | Identifiant unique de l'event. |
| `X-Event-Type` | string | oui | Type d'event (routing / dispatch côté partenaire). |
| `X-Event-Version` | string | oui | Version du contrat de l'event (évolution du payload). |

- Headers de **livraison** (injectés automatiquement) :
Non inclus pour le moment.
| Header | Requis | Rôle |
|--------|--------|------|
| `X-Event-Time` | non | Horodatage de production de l'event (RFC 3339). |
| `X-Event-Source` | non | Système émetteur. |
| `X-Webhook-Id` | non | Identifiant de la souscription/endpoint destinataire. |
| `X-Delivery-Id` | non | Identifiant unique de la tentative de livraison. |

> **Signature : non incluse pour le moment.** Prévoir l'ajout ultérieur de
> `X-Webhook-Signature` (+ `X-Webhook-Timestamp`) — cf. §12.

- **Pas de pagination** (events poussés unitairement).
- Réponses **attendues du partenaire** : `2xx` = ack ; sinon rejeu selon politique
  de retry (extension `x-retry`), puis dead-letter.

Exemple d'un webhook côté projet — le projet ne fournit que le schéma brut du payload :

```yaml
# projects/mon-api/paths/order-created.yaml  (type: events)
order.created:
  post:
    summary: Émis lorsqu'une commande est créée
    x-event: order.created            # injecte les headers d'event/signature
    requestBody:
      required: true
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Order' }   # payload BRUT, sans enveloppe
    responses:
      '2xx': ~   # ack attendu du partenaire (géré par le socle)
```

## 8. Pagination & tri — norme commune (page-based)

Appliquée **par défaut** sur toute réponse de collection. Désactivable par path
(`x-paginated: false`).

### 8.1 Paramètres de requête (factorisés)

| Param | Défaut | Contrainte | Rôle |
|-------|--------|-----------|------|
| `page` | `0` | `>= 0` | Index de page (page-based). |
| `size` | `20` | `1..100` | Taille de page. |
| `sort` | — | `champ,asc|desc` (répétable) | Tri multi-critères. |

### 8.2 Enveloppe de réponse paginée

```yaml
Page:
  type: object
  properties:
    content: { type: array }      # remplacé par le type d'item (macro, voir 9.2)
    pagination:
      type: object
      properties:
        page:          { type: integer }   # index 0-based
        size:          { type: integer }
        totalElements: { type: integer }
        totalPages:    { type: integer }
        hasNext:       { type: boolean }
        hasPrevious:   { type: boolean }
```

En complément (optionnel) : headers `Link` (RFC 8288) `first/prev/next/last`.

> **Choix par défaut proposé** : `page` **0-based** (style Spring). À valider (cf. §12).

## 9. Ce qu'un projet doit fournir (couche 3)

### 9.1 Le strict minimum

```yaml
# projects/mon-api/api.yaml
type: exposed            # exposed | called | events
info:
  title: Mon API Commandes
  version: 1.0.0
  description: …
servers:
  - url: https://api.mon-si.fr/commandes/v1
tags:
  - name: orders
paths: !include paths/*.yaml
schemas: !include schemas/*.yaml
```

Un path type — le projet ne déclare **que** son `2xx` ; erreurs, headers et
pagination sont injectés automatiquement :

```yaml
# projects/mon-api/paths/orders.yaml
/orders:
  get:
    tags: [orders]
    summary: Liste des commandes
    x-paginated: '#/components/schemas/Order'   # macro pagination (§9.2)
    responses:
      '200': ~   # généré par la macro à partir du type d'item
  post:
    tags: [orders]
    summary: Crée une commande
    requestBody:
      $ref: '#/components/requestBodies/CreateOrder'
    responses:
      '201':
        description: Commande créée
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Order' }
```

### 9.2 Macros de templating (résolues au build)

OpenAPI n'a pas de génériques : on comble avec des **macros** (extensions `x-*`
expansées par le build).

| Macro | Effet |
|-------|-------|
| `x-paginated: '#/…/Order'` | Génère un `200` renvoyant `Page<Order>` + injecte params `page/size/sort`. |
| `x-errors: [404, 409]` | Ajoute des erreurs supplémentaires ciblées à l'opération. |
| `x-no-errors: [429]` | Retire une erreur commune héritée. |
| `x-event: order.created` | (webhook) Injecte les headers d'event/signature. Le payload reste **brut** dans le `requestBody`, aucune enveloppe. |

## 10. Mécanisme de build

Étapes réalisées par `tools/build.mjs` pour chaque projet :

1. **Résolution du profil** — charge `core` + `profiles/<type>`.
2. **Deep merge** des 3 couches (`core` ⊕ `profil` ⊕ `projet`), le projet gagne.
3. **Injection auto** — headers communs, réponses d'erreur, params de pagination/tri
   sur toutes les opérations concernées.
4. **Expansion des macros** (`x-paginated`, `x-event`, `x-errors`…).
5. **Champs optionnels → nullable** — toute propriété absente de `required` devient
   `type: [<type>, "null"]` (OpenAPI 3.1) : un champ optionnel peut être absent **ou** `null`.
6. **Résolution/bundling des `$ref`** en un seul fichier.
7. **Validation** (lint OpenAPI) — échoue si contrat non conforme.
8. **Sortie** → `build/<mon-api>.openapi.yaml`.

## 11. Choix techniques proposés

| Sujet | Proposition | Alternative |
|-------|-------------|-------------|
| Version OpenAPI | **3.1** (support natif `webhooks`, alignement JSON Schema) | 3.0.x |
| Bundling / lint | **Redocly CLI** (`@redocly/cli`) | `swagger-cli`, `openapi-merge` |
| Merge des couches + macros | **Script Node/ESM maison** (`build.mjs`) ✅ décidé | Overlays OpenAPI (Overlay Spec 1.0) |
| Format d'erreur | **`StandardError`** (maison) ✅ décidé | RFC 7807 Problem Details |
| Events webhook | **Payload brut + métadonnées en headers** ✅ décidé | Enveloppe CloudEvents / maison |
| Pagination | **Page-based, 0-based** + enveloppe `Page` ✅ décidé | Cursor-based, Link headers |

## 12. Décisions & points restants

**Décidé :**
- ✅ Assemblage : **script de merge maison** (`build.mjs`).
- ✅ Pagination : **page-based, 0-based**, `size` défaut 20 / max 100.
- ✅ Webhook : **pas d'enveloppe**, payload brut dans le `requestBody`, métadonnées en headers.
- ✅ Auth : **bearer JWT généralisé à tous les types** (`exposed`/`called`/`events`),
  défini au socle (`core/base.yaml`). **API key exclue partout** (politique interne).

**Restant à trancher :**
- Enveloppe de collection `Page` **ou** headers `Link` (RFC 8288) — l'un, l'autre, les deux ?
- OpenAPI **3.1** confirmé (nécessaire pour `webhooks`) ?
- Schémas d'auth — **tranché** : bearer JWT généralisé à tous les types (§7), API key
  exclue. mTLS/OAuth2 restent envisageables par projet en surcharge si besoin.
- Liste exacte des codes d'erreur communs à retenir dans le socle.
- **Signature des webhooks (reportée)** : ajouter `X-Webhook-Signature` + `X-Webhook-Timestamp`
  quand décidé. Reco : **HMAC-SHA256** sur `timestamp + "." + body`, clé secrète par
  souscription, header `X-Webhook-Signature: t=<ts>,v1=<hex>` (schéma type Stripe).
- Versionnement des templates du socle (comment un projet fige/upgrade sa version de socle).
