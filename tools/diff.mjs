// Compare deux contrats OpenAPI et déduit le niveau SemVer requis (major/minor/patch).
// S'appuie sur `oasdiff` (règles OpenAPI éprouvées). Détection :
//   - au moins un changement CASSANT        → major
//   - sinon, au moins un changement          → minor
//   - aucun changement de contrat            → patch
// Utilisé par la CLI (`openapi-socle diff`) et le template GitLab CI.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

// Construit la commande oasdiff : binaire natif si présent, sinon via Docker (image tufin/oasdiff).
function oasdiff(sub, base, rev, extra = []) {
  if (has('oasdiff')) {
    return spawnSync('oasdiff', [sub, base, rev, ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  if (has('docker')) {
    const b = path.resolve(base), r = path.resolve(rev);
    const args = ['run', '--rm', '-v', `${path.dirname(b)}:/b`, '-v', `${path.dirname(r)}:/r`,
      'tufin/oasdiff', sub, `/b/${path.basename(b)}`, `/r/${path.basename(r)}`, ...extra];
    return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }
  throw new Error(
    'oasdiff introuvable. Installe-le (`curl -fsSL https://raw.githubusercontent.com/oasdiff/oasdiff/main/install.sh | sh`) '
    + 'ou fournis Docker (image tufin/oasdiff).');
}

function parseArray(out, label) {
  let v;
  try { v = JSON.parse(out || '[]'); }
  catch { throw new Error(`Sortie oasdiff (${label}) illisible :\n${(out || '').slice(0, 400)}`); }
  return Array.isArray(v) ? v : [];
}

// Lance oasdiff et échoue FORT si l'outil ne tourne pas (jamais un faux « patch » silencieux).
function run(sub, base, rev, extra) {
  const r = oasdiff(sub, base, rev, extra);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`oasdiff a échoué (${sub}, code ${r.status}) :\n${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  }
  return parseArray(r.stdout, sub);
}

// Renvoie { level, breaking:[], changes:number }.
export function diffContracts(base, rev) {
  for (const f of [base, rev]) if (!fs.existsSync(f)) throw new Error(`Fichier introuvable : ${f}`);

  const breaking = run('breaking', base, rev, ['-f', 'json']);
  if (breaking.length) return { level: 'major', breaking, changes: breaking.length };

  const changes = run('changelog', base, rev, ['-f', 'json']);
  return { level: changes.length ? 'minor' : 'patch', breaking: [], changes: changes.length };
}

// Changelog complet (cassant + non cassant) : liste de { id, text, level, operation, path, section }.
// level : 1=info, 2=warning (non cassants), 3=error (cassant).
export function changelog(base, rev) {
  for (const f of [base, rev]) if (!fs.existsSync(f)) throw new Error(`Fichier introuvable : ${f}`);
  return run('changelog', base, rev, ['-f', 'json']);
}

export function runDiffCli(argv = process.argv.slice(2)) {
  const allowBreaking = argv.includes('--allow-breaking');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const [base, rev] = pos;
  if (!base || !rev) {
    console.error('Usage : openapi-socle diff <baseline.yaml> <revision.yaml> [--allow-breaking]');
    process.exit(2);
  }

  let res;
  try { res = diffContracts(base, rev); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

  const label = { major: 'CASSANT (major)', minor: 'rétrocompatible (minor)', patch: 'aucun changement de contrat (patch)' };
  console.error(`Niveau requis : ${label[res.level]}`);
  if (res.breaking.length) {
    console.error(`\n${res.breaking.length} changement(s) cassant(s) :`);
    for (const c of res.breaking.slice(0, 30)) {
      console.error(`  • ${[c.operation, c.path, c.text || c.id].filter(Boolean).join(' ')}`);
    }
  }

  console.log(res.level); // stdout = niveau (major|minor|patch), consommable en CI

  if (res.level === 'major' && !allowBreaking) process.exit(1);
}
