#!/usr/bin/env node
// Génère une release note listant les changements CASSANTS et NON CASSANTS du build courant
// (examples/ → build/) par rapport aux baselines figées dans golden/ (= la dernière version).
//
// À lancer AVANT `npm run golden:update` (qui écrase les baselines). Ensuite, promouvoir en golden.
//
//   node tools/release-notes.mjs [--out <fichier.md>] [--title "<titre>"] [--date <YYYY-MM-DD>]
//
// Nécessite oasdiff (cf. tools/diff.mjs). Sortie : Markdown (stdout, ou --out).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjects } from './build.mjs';
import { changelog } from './diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(ROOT, 'golden');
const RANK = { patch: 0, minor: 1, major: 2 };
const BUMP = { major: 'MAJEURE (rupture)', minor: 'mineure (rétrocompatible)', patch: 'patch (aucun changement de contrat)' };

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Classe un contrat : compare sa baseline golden au contrat fraîchement généré.
function analyse(label, golden, built) {
  if (!fs.existsSync(golden)) return { label, level: 'minor', isNew: true, breaking: [], nonBreaking: [] };
  const changes = changelog(golden, built);
  const breaking = changes.filter((c) => c.level >= 3);
  const nonBreaking = changes.filter((c) => c.level < 3);
  const level = breaking.length ? 'major' : (changes.length ? 'minor' : 'patch');
  return { label, level, isNew: false, breaking, nonBreaking };
}

function line(c) {
  const loc = [c.operation, c.path].filter(Boolean).join(' ');
  return `- ${loc ? `\`${loc}\` — ` : ''}${c.text}`;
}

function render(entries, overall, title, date) {
  const out = [];
  out.push(`# ${title}`, '', `_${date}_`, '');
  out.push(`**Niveau de version requis : ${BUMP[overall]}**`, '');

  // tableau de synthèse
  out.push('| Contrat | Niveau | Cassants | Non cassants |', '|---|---|---:|---:|');
  for (const e of entries) {
    if (e.removed) { out.push(`| ${e.label} | 🗑️ retiré | — | — |`); continue; }
    if (e.isNew) { out.push(`| ${e.label} | 🆕 nouveau | — | — |`); continue; }
    const badge = e.level === 'major' ? '🔴 major' : e.level === 'minor' ? '🟢 minor' : '⚪ patch';
    out.push(`| ${e.label} | ${badge} | ${e.breaking.length} | ${e.nonBreaking.length} |`);
  }
  out.push('');

  // détail par contrat (seulement ceux qui changent)
  for (const e of entries) {
    if (e.removed) { out.push(`## ${e.label} — 🗑️ contrat retiré`, '', '> Rupture pour les consommateurs : le contrat n’est plus généré.', ''); continue; }
    if (e.isNew) { out.push(`## ${e.label} — 🆕 nouveau contrat`, '', '> Première version (aucune baseline précédente).', ''); continue; }
    if (!e.breaking.length && !e.nonBreaking.length) continue; // patch : rien à détailler
    out.push(`## ${e.label} — ${e.level.toUpperCase()}`);
    if (e.breaking.length) { out.push('', `### ⚠️ Changements cassants (${e.breaking.length})`, ...e.breaking.map(line)); }
    if (e.nonBreaking.length) { out.push('', `### ✅ Changements non cassants (${e.nonBreaking.length})`, ...e.nonBreaking.map(line)); }
    out.push('');
  }
  return out.join('\n');
}

function main() {
  const title = arg('--title', 'Release notes — contrats d’interface');
  const date = arg('--date', new Date().toISOString().slice(0, 10));
  const outFile = arg('--out');

  const { results } = buildProjects(); // examples/ → build/
  const entries = [];
  let overall = 'patch';
  const bump = (lvl) => { if (RANK[lvl] > RANK[overall]) overall = lvl; };

  for (const r of results) {
    if (!r.ok) { console.error(`✗ build ${r.name} : ${r.error}`); process.exit(2); }
    for (const built of r.outFiles) {
      const base = path.basename(built);
      const e = analyse(base.replace(/\.openapi\.yaml$/, ''), path.join(GOLDEN, base), built);
      entries.push(e);
      bump(e.level);
    }
  }

  // baselines golden/ qui n’ont plus de contrat généré → contrat retiré (rupture)
  const built = new Set(results.flatMap((r) => (r.outFiles ?? []).map((f) => path.basename(f))));
  for (const g of fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.openapi.yaml'))) {
    if (!built.has(g)) { entries.push({ label: g.replace(/\.openapi\.yaml$/, ''), removed: true }); bump('major'); }
  }

  entries.sort((a, b) => a.label.localeCompare(b.label));
  const md = render(entries, overall, title, date);

  if (outFile) {
    fs.writeFileSync(outFile, md + '\n');
    console.error(`✓ Release note écrite : ${path.relative(process.cwd(), outFile)} (niveau ${overall})`);
  } else {
    process.stdout.write(md + '\n');
  }
}

main();
