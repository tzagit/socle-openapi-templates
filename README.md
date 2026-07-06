# @monsi/openapi-socle

Socle de templating YAML pour écrire des contrats OpenAPI 3.1 en ne spécialisant que le
nécessaire. Trois types d'API : **`exposed`** (exposée par mon SI), **`called`** (définie par
moi, exposée par le partenaire), **`events`** (webhooks poussés vers les partenaires).

Le socle factorise headers communs, codes d'erreur, `StandardErrorObject`, pagination/tri
(page-based, 0-based). Un projet ne fournit que `info`, `servers`, `tags`, ses `paths` et ses
réponses `2xx`, ses `schemas`.

👉 Spécification détaillée : [`SPEC.md`](./SPEC.md).

## Utilisation comme dépendance (dans un projet)

Le socle est publié en package npm sur Artifactory. Dans le dépôt de **ton** API :

```bash
# .npmrc : mappe le scope @monsi sur l'Artifactory
echo "@monsi:registry=https://artifactory.example.com/artifactory/api/npm/npm-local/" >> .npmrc
npm install -D @monsi/openapi-socle
```

`package.json` du projet :
```json
{
  "scripts": {
    "build": "openapi-socle build .",
    "lint": "redocly lint build/*.openapi.yaml"
  }
}
```

Le dépôt du projet ne contient que sa **couche 3** (`api.yaml`, `paths/`, `schemas/`) ;
`openapi-socle build .` produit `build/<projet>.openapi.yaml`. **Mettre à jour le socle** =
bump de la version de `@monsi/openapi-socle`, puis rebuild → le diff du contrat généré est la
surface de revue.

## CLI

```bash
openapi-socle build [projet|conteneur] [--out <dir>] [--project <nom>]
openapi-socle import <in.yaml|json> [--name <n>] [--type ...] [--out-dir <dir>] [--no-factor] [--force]
```

- **build** : un dossier avec `api.yaml` (projet unique) ou un conteneur de projets.
- **import** : transforme un OpenAPI 3.0/3.1 existant en projet du socle (dé-factorisation).

## Développement du socle (ce dépôt)

```bash
npm install
npm run build            # construit examples/ → build/
npm run lint             # valide les sorties (Redocly)
npm pack --dry-run       # aperçu du package publié
```

## Arborescence

```
bin/openapi-socle.mjs   # CLI (build | import)
tools/build.mjs         # moteur d'assemblage (exporté + CLI)
tools/import.mjs        # importer OpenAPI → projet
templates/core/         # couche 1 — commun à tous
templates/profiles/     # couche 2 — exposed | called | events
examples/<nom>/         # projets d'exemple (non publiés dans le package)
build/                  # sorties générées : <nom>.openapi.yaml
```

## Démarrer un nouveau projet

1. `api.yaml` :
   ```yaml
   type: exposed          # exposed | called | events
   info: { title: Mon API, version: 1.0.0 }
   servers: [ { url: https://api.mon-si.fr/mon-api/v1 } ]
   tags: [ { name: ma-ressource } ]
   ```
2. `paths/*.yaml` — ne déclarer que les réponses `2xx` (le reste est injecté) :
   ```yaml
   /ma-ressource:
     get:
       tags: [ma-ressource]
       operationId: listRessource
       x-paginated: '#/components/schemas/MaRessource'   # → 200 Page<MaRessource> + page/size/sort
       responses:
         '200': ~
   ```
3. `schemas/*.yaml` (map de schémas, fusionnée dans `components.schemas`).
4. `openapi-socle build .` → `build/<mon-api>.openapi.yaml`.

Voir les exemples : `examples/orders-exposed`, `examples/partner-payments-called`,
`examples/orders-events`, `examples/swagger-petstore`.

## Macros disponibles

| Macro | Effet |
|-------|-------|
| `x-paginated: '#/components/schemas/Item'` | `200` renvoyant `PageOf<Item>` + params `page/size/sort`. |
| `x-errors: [409]` | Ajoute des codes d'erreur à l'opération. |
| `x-no-errors: [429]` | Retire un code d'erreur hérité. |
| `x-event: nom.event` | (events) marqueur documentaire du type d'event. |
