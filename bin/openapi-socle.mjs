#!/usr/bin/env node
// CLI du socle OpenAPI. Deux commandes :
//   openapi-socle build  [projet|conteneur] [--out <dir>] [--project <nom>]
//   openapi-socle import  <input.yaml|json> [--name <n>] [--type ...] [--out-dir <dir>] [--no-factor] [--force]
//
// Les templates du socle sont résolus depuis le package installé ; le projet et la
// sortie sont ceux du dépôt appelant (CWD par défaut).

import path from 'node:path';
import { buildProjects } from '../tools/build.mjs';
import { runImportCli } from '../tools/import.mjs';
import { runDiffCli } from '../tools/diff.mjs';

function usage() {
  console.log(`openapi-socle — socle de templating OpenAPI

  openapi-socle build  [projet|conteneur]   Construit un projet (dossier avec api.yaml)
                                             ou tous les projets d'un conteneur → OpenAPI 3.1 bundlé.
      --out <dir>       Dossier de sortie (défaut : ./build)
      --project <nom>   Ne construire que ce projet (mode conteneur)

  openapi-socle import <input.yaml|json>     Transforme un OpenAPI 3.0/3.1 existant en projet du socle.
      --name <n>        Nom du projet généré
      --type exposed|called|events
      --out-dir <dir>   Où écrire le projet (défaut : CWD)
      --no-factor       Ne pas factoriser les schémas répétés
      --force           Écraser si le dossier existe

  openapi-socle diff <baseline> <revision>   Compare deux contrats et déduit le niveau SemVer.
      --allow-breaking  Ne pas échouer sur un changement cassant (sort quand même 'major')
                        stdout = major|minor|patch ; exit 1 si cassant (sauf --allow-breaking).

  Défaut de sortie du build : ./build/<projet>.openapi.yaml`);
}

function buildCli(argv) {
  let root = null, outDir = null, filter = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outDir = argv[++i];
    else if (a === '--project') filter = argv[++i];
    else if (a === '-h' || a === '--help') { usage(); return; }
    else if (a.startsWith('--')) { console.error(`Option inconnue : ${a}`); process.exit(1); }
    else root = a;
  }
  root = path.resolve(root || '.');
  outDir = path.resolve(outDir || path.join(process.cwd(), 'build'));

  const { dirs, results } = buildProjects({ root, outDir, filter });
  if (!dirs.length) {
    console.error(filter ? `Projet "${filter}" introuvable dans ${root}.` : `Aucun projet (api.yaml) trouvé dans ${root}.`);
    process.exit(1);
  }
  let ok = 0;
  for (const r of results) {
    if (r.ok) { console.log(`✓ ${r.name.padEnd(28)} [${r.type}]  ${r.operations} route(s)  → ${path.relative(process.cwd(), r.outFile)}`); ok++; }
    else console.error(`✗ ${r.name} : ${r.error}`);
  }
  console.log(`\n${ok}/${dirs.length} projet(s) construit(s).`);
  if (ok !== dirs.length) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'build': buildCli(rest); break;
  case 'import': runImportCli(rest); break;
  case 'diff': runDiffCli(rest); break;
  case undefined: case '-h': case '--help': usage(); break;
  default: console.error(`Commande inconnue : ${cmd}`); usage(); process.exit(1);
}
