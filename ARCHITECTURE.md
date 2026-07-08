# Architecture du code (`bin/` + `tools/`)

Doc de reprise pour un développeur. Décrit **comment le code fonctionne** (le README décrit
_comment l'utiliser_, SPEC.md décrit _les règles du socle_). Tout est du JavaScript ESM natif,
sans build ni transpilation ; seules dépendances runtime : `js-yaml` et `xlsx` (SheetJS).

## Vue d'ensemble

Le socle fait deux choses inverses :

```
                 build  (tools/build.mjs)
   projet         ─────────────────────────▶   contrat OpenAPI 3.1 bundlé
   (couche 3)     ◀─────────────────────────    (déjà rédigé, à migrer)
                 import (tools/import.mjs)
```

- **`build`** assemble `core ⊕ profil ⊕ projet`, injecte le commun (headers, erreurs,
  pagination, sécurité), expanse les macros, élague les composants inutilisés → un OpenAPI 3.1
  autonome et valide.
- **`import`** fait l'inverse : « dé-factorise » un OpenAPI existant en retirant tout ce que
  le socle réinjecte, et reconstruit les macros → un projet minimal (couche 3).

Autour, des outils de garde-fou : validation dictionnaire, non-régression, diff SemVer.

## Arborescence

| Dossier | Rôle |
|---|---|
| `templates/core/` | Couche 1 — commun à tous : `base.yaml`, `headers/`, `responses/`, `schemas/`, `parameters/` |
| `templates/profiles/` | Couche 2 — `exposed.yaml` / `called.yaml` / `events.yaml` (particularités par type) |
| `examples/` | Projets de démonstration (couche 3), un sous-dossier par API |
| `bin/openapi-socle.mjs` | CLI publique (`build` / `import` / `diff`) |
| `tools/` | Le moteur (voir ci-dessous) |
| `golden/` | Baselines figées `<projet>.openapi.yaml` pour la non-régression |
| `dico/` | Dictionnaires Estreem `.xlsx` (validation des champs annotés) |
| `test/` | Tests `node:test` (`npm test`) |

Un **projet** (couche 3) est un dossier contenant `api.yaml` (type + info + servers + tags) et,
selon le type, `paths/`, `schemas/`, `events/`.

## Les modules de `tools/`

### `build.mjs` — le moteur d'assemblage
Point d'entrée : `buildProjects({ root, outDir, filter })` → `buildProject(dir)` pour chacun.
Flux de `buildProject` (dans l'ordre) :
1. `loadProject(dir)` : lit `api.yaml` (extrait `type` et `nullableOptionals`, champs de
   contrôle retirés du contrat), merge `paths/` + `schemas/`, et pour les events génère les
   webhooks depuis `events/` (`loadEvents`).
2. `deepMerge(loadCore(), loadProfile(type))` puis merge du projet → couches empilées.
3. Stamp `info.x-socle-version` + `info.x-socle-type`.
4. Pour chaque opération : `injectRequestHeaders`, puis selon le type
   `injectIdempotency` + `expandPagination` (non-events) ou `normalizeEventAck` (events),
   `injectErrors` (catalogue contextuel), `attachResponseHeaders`.
5. `nullableOptionals` (optionnels → nullable : requêtes par défaut, réponses en opt-in ;
   jamais un schéma atteignable depuis une réponse — cf. `responseReachableSchemas`).
6. `stripDictAnnotations` (retire `x-dictionary-id` + `x-estreem-*`).
7. `pruneUnusedComponents` (tree-shaking : ne garde que les composants atteignables).
8. `validateRefs` (échoue si un `$ref` interne est cassé) puis écriture YAML.

Les **règles d'injection** sont des constantes en tête de fichier (`COMMON_REQUEST_HEADERS`,
`ERRORS_ALWAYS`, `IDEMPOTENCY_BY_METHOD`, `RESPONSE_HEADERS`…) — c'est là qu'on ajuste le commun.

### `import.mjs` — la dé-factorisation
Point d'entrée : `importDoc(doc, { type, name, factor, host })` → objet décrivant le projet ;
`writeProject` l'écrit sur disque. Étapes clés :
- `inlineNonSchemaRefs` : inline les composants non-schéma (le projet ne les fournit pas),
  garde les `$ref` de schémas.
- `filterParams` / nettoyage des réponses : retire headers communs, params de pagination,
  codes d'erreur — tout ce que le socle réinjecte ; conserve les headers custom.
- `detectPagination` → reconstruit la macro `x-paginated` ; events → un fichier par event
  (`buildEventFiles`, nom = ressource du path).
- `detectVersionPrefix` / `stripVersionPrefix` / `appendSegment` : remonte un `/v1` des paths
  vers le base path.
- `factorSchemas` : boucle en point fixe qui hisse les sous-schémas dupliqués en composants
  partagés (du plus profond au plus superficiel).

### `dictionary.mjs` — chargeur du dico Estreem
`loadDictionary(file)` lit le `.xlsx` (SheetJS) et expose `resolve(id)` qui suit la chaîne
`DICO_Complet.Reference → Type → TypesSimples (type simple) | Codeset (énumération)` et renvoie
la définition attendue (`type`, `pattern`, `minLength/maxLength`, `enum`, `fractionDigits`…).

### `check-dictionary.mjs` — validation des champs annotés
`checkProject(dir)` : parcourt (`walk`) les schémas de body **et** les schémas de paramètres,
et pour chaque nœud portant un `x-dictionary-id` compare (`compareField`) sa définition à celle
du dico. Sévérité : écart net → **erreur** (bloquante) ; ambigu (champ/param sans id, `?`,
type structuré) → **warning**. Dico absent = bloquant seulement s'il y a des champs à valider.

### `diff.mjs` — niveau SemVer via oasdiff
`diffContracts(base, rev)` lance `oasdiff` (binaire natif ou Docker) : ≥1 changement cassant →
`major` ; sinon ≥1 changement → `minor` ; sinon `patch`. Échoue fort si oasdiff est absent
(jamais un faux `patch` silencieux).

### `check-regression.mjs` — non-régression du socle
Régénère `examples/` et compare chaque contrat à sa baseline `golden/` via `diffContracts`.
Un changement **cassant** des templates fait échouer le job → il doit être assumé par une
MAJOR (et `npm run golden:update` régénère les baselines).

### `bin/openapi-socle.mjs` — la CLI
Dispatcher minimal : `build` → `buildProjects`, `import` → `runImportCli`, `diff` → `runDiffCli`.
Résout les **templates depuis le package** installé, mais lit le **projet et écrit la sortie
chez l'appelant** (CWD) — c'est ce qui permet de distribuer le socle en dépendance.

## Conventions de code
- ESM natif, fonctions courtes et pures autant que possible ; les mutations de document sont
  isolées dans des passes nommées (`injectErrors`, `pruneUnusedComponents`…).
- Chaque module exécutable a un garde `if (process.argv[1] && import.meta.url === …) main()`
  pour rester **importable sans effet de bord** (indispensable aux tests).
- Les fonctions pures testées sont **exportées** ; c'est le « cœur testable » de chaque module.

## Tester
```bash
npm test          # node:test — test/*.test.mjs
```
Les tests couvrent les fonctions déterministes (fusion, injections, dé-factorisation,
résolution dico, comparaison de champs) + un test d'intégration de `importDoc` et la résolution
sur le vrai dico. `dictionary.test.mjs` se met en `skip` si le `.xlsx` fixture est absent.

## Points d'extension (recettes)
- **Ajouter un header commun** : ajouter le composant dans `templates/core/headers/`, puis son
  nom dans la constante d'injection adéquate de `build.mjs`, et son nom (minuscules) dans les
  ensembles de retrait de `import.mjs`. Ajouter/adapter une règle Spectral.
- **Ajouter un code d'erreur commun** : `ERRORS_ALWAYS` (ou une des règles contextuelles) dans
  `build.mjs` + le composant `responses/Error<code>` + l'ensemble `ERROR_CODES` de `import.mjs`.
- **Nouveau type d'API** : `templates/profiles/<type>.yaml` + brancher les injections
  spécifiques dans `buildProject` + le mapping dans `import.mjs`.
- **Après tout changement de templates/build** : `npm test && npm run build && npm run lint &&
  npm run spectral && npm run check:regression`, puis `npm run golden:update` si le changement
  est assumé.
