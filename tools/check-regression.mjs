// Non-régression du socle : régénère les contrats des examples/ et les compare aux
// baselines figées dans golden/. Un changement CASSANT des templates fait échouer le job
// → il doit être assumé par une MAJOR du socle (et les golden régénérés).
//
//   node tools/check-regression.mjs      (nécessite oasdiff — cf. tools/diff.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjects } from './build.mjs';
import { diffContracts } from './diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'golden');

const { results } = buildProjects(); // examples/ → build/
let fail = false, checked = 0;

for (const r of results) {
  if (!r.ok) { console.error(`✗ build ${r.name} : ${r.error}`); fail = true; continue; }

  // un projet peut produire plusieurs contrats (events multi-events) → une baseline par fichier.
  for (const outFile of r.outFiles) {
    const base = path.basename(outFile);
    const label = base.replace(/\.openapi\.yaml$/, '');
    const golden = path.join(GOLDEN, base);
    if (!fs.existsSync(golden)) { console.log(`• ${label.padEnd(28)} pas de baseline (nouveau) — ignoré`); continue; }

    let res;
    try { res = diffContracts(golden, outFile); }
    catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

    checked++;
    console.log(`${res.level === 'major' ? '✗' : '✓'} ${label.padEnd(28)} ${res.level}`);
    if (res.level === 'major') {
      fail = true;
      for (const c of res.breaking.slice(0, 20)) {
        console.log(`    • ${[c.operation, c.path, c.text || c.id].filter(Boolean).join(' ')}`);
      }
    }
  }
}

console.log(`\n${checked} contrat(s) comparé(s) à golden/.`);
if (fail) {
  console.error('\n✗ Régression : changement CASSANT dans les templates du socle.');
  console.error('  → Assume une MAJOR du socle, puis régénère les baselines : npm run golden:update');
  process.exit(1);
}
console.log('✓ Aucune régression cassante.');
