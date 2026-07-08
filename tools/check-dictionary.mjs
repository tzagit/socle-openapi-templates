// Vérifie, AVANT la génération, que chaque champ de body annoté d'un x-dictionary-id est
// conforme au dictionnaire Estreem : type, pattern (ancres normalisées), minLength/maxLength,
// enum (Codeset), digits. Écart net → ERREUR (bloquant) ; cas ambigu → WARNING.
//
//   node tools/check-dictionary.mjs [projectDir]      (défaut : scan examples/)
//
// Résolution du dico : dico/<info.x-dictionary-version>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { loadDictionary } from './dictionary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const loadYaml = (f) => yaml.load(fs.readFileSync(f, 'utf8')) ?? {};
const globYaml = (d) => (!fs.existsSync(d) ? [] : fs.readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(d, f)));
const mergeFiles = (files) => files.reduce((acc, f) => ({ ...acc, ...loadYaml(f) }), {});

// type OpenAPI effectif (gère [type,"null"]).
export const effType = (t) => (Array.isArray(t) ? t.find((x) => x !== 'null') : t);
// normalise une regex : retire ancres ^ … $ pour comparer au dico (qui ne les met pas).
export const normPat = (p) => (p == null ? null : String(p).replace(/^\^/, '').replace(/\$$/, ''));
export const isScalarLeaf = (f) => isObj(f) && !isObj(f.properties) && ['string', 'integer', 'number', 'boolean'].includes(effType(f.type));

// Le dico met parfois un FORMAT OpenAPI dans sa colonne « type » (le champ est alors
// type: string + format: X). Table de correspondance format → type OpenAPI.
const FORMAT_TYPE = {
  uuid: 'string', date: 'string', 'date-time': 'string', time: 'string', duration: 'string',
  email: 'string', uri: 'string', url: 'string', hostname: 'string', ipv4: 'string', ipv6: 'string',
  byte: 'string', binary: 'string', password: 'string',
  int32: 'integer', int64: 'integer', float: 'number', double: 'number',
};

// Compare un champ à la définition attendue du dico → liste de { sev, msg }.
export function compareField(field, exp) {
  const out = [];
  const err = (m) => out.push({ sev: 'error', msg: m });
  const warn = (m) => out.push({ sev: 'warn', msg: m });

  if (exp.kind === 'unknown') { warn(`type dico « ${exp.typeName} » non résolu (absent du dictionnaire ?)`); return out; }

  // type structuré : le champ doit être un objet ; on compare ses sous-champs par nom.
  if (exp.kind === 'structured') {
    const et = effType(field.type);
    if (et && et !== 'object') err(`type « ${et} » ≠ dico « object » (${exp.typeName})`);
    if (isObj(field.properties) && isObj(exp.attributes)) {
      for (const [sub, subDef] of Object.entries(field.properties)) {
        const attr = exp.attributes[sub];
        if (!attr) { warn(`sous-champ « ${sub} » hors du type structuré ${exp.typeName}`); continue; }
        for (const { sev, msg } of compareField(subDef, { found: true, ...attr })) out.push({ sev, msg: `${sub}: ${msg}` });
      }
    }
    return out;
  }

  const hasEnum = Array.isArray(field.enum);
  const ft = effType(field.type);

  // type + format (le dico peut exprimer un format à la place du type)
  let expType = exp.type, expFormat = null;
  if (exp.type && FORMAT_TYPE[exp.type]) { expFormat = exp.type; expType = FORMAT_TYPE[exp.type]; }
  if (expType && ft && ft !== expType) err(`type « ${ft} » ≠ dico « ${expType} »`);
  if (expFormat) {
    if (field.format && field.format !== expFormat) err(`format « ${field.format} » ≠ dico « ${expFormat} »`);
    else if (!field.format) warn(`format manquant (dico : « ${expFormat} »)`);
  }

  // pattern (ancres normalisées) — non pertinent pour un champ à enum
  if (!hasEnum) {
    const fp = normPat(field.pattern), ep = normPat(exp.pattern);
    if (ep && fp && fp !== ep) err(`pattern « ${field.pattern} » ≠ dico « ${exp.pattern} »`);
    else if (ep && !fp) warn(`pattern manquant (dico : « ${exp.pattern} »)`);
  }

  // longueurs — l'enum contraint déjà, on n'exige pas min/max dans ce cas
  for (const k of ['minLength', 'maxLength']) {
    if (exp[k] != null && field[k] != null && Number(field[k]) !== Number(exp[k])) err(`${k} ${field[k]} ≠ dico ${exp[k]}`);
    else if (exp[k] != null && field[k] == null && !hasEnum) warn(`${k} manquant (dico : ${exp[k]})`);
  }

  // enum (Codeset)
  if (exp.enum && exp.enum.length) {
    if (!hasEnum) warn(`enum manquant (dico : ${exp.enum.length} valeur(s))`);
    else {
      const a = [...field.enum].map(String).sort(), b = [...exp.enum].map(String).sort();
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) err(`enum ≠ dico [${exp.enum.join(', ')}]`);
    }
  }

  // digits (mapping OpenAPI ambigu → warning si non représenté)
  if ((exp.fractionDigits != null || exp.totalDigits != null) && field.multipleOf == null && field.maximum == null) {
    warn(`digits dico (fraction=${exp.fractionDigits ?? '-'}, total=${exp.totalDigits ?? '-'}) non vérifiables sur ce champ`);
  }
  return out;
}

// Parcourt tout le doc : valide chaque nœud portant un x-dictionary-id (champ de body OU
// schéma de paramètre), et signale les feuilles scalaires de body sans id (oubli possible).
export function walk(node, p, ctx) {
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${p}[${i}]`, ctx)); return; }
  if (!isObj(node)) return;
  if (node['x-dictionary-id'] != null) ctx.onId(node, p);
  // paramètre métier (path/query) sans x-dictionary-id (ni sur lui-même ni sur son schema) → oubli ?
  // Les headers/cookies sont souvent techniques (canal, corrélation…) et sans équivalent dico : on ne les warne pas.
  if (typeof node.name === 'string' && ['path', 'query'].includes(node.in) &&
      node['x-dictionary-id'] == null && !(isObj(node.schema) && node.schema['x-dictionary-id'] != null)) {
    ctx.onParamNoId(`${p} (${node.name})`);
  }
  // Feuille scalaire de body sans id → oubli ? (sauf si l'objet parent est lui-même annoté :
  // ses sous-champs sont alors couverts par son type structuré.)
  if (isObj(node.properties) && node['x-dictionary-id'] == null) {
    for (const [name, field] of Object.entries(node.properties))
      if (isObj(field) && field['x-dictionary-id'] == null && isScalarLeaf(field)) ctx.onLeafNoId(`${p}.${name}`);
  }
  for (const [k, v] of Object.entries(node)) walk(v, k === 'properties' ? p : `${p}.${k}`, ctx);
}

export function checkProject(dir) {
  const api = loadYaml(path.join(dir, 'api.yaml'));
  const version = api.info?.['x-dictionary-version'];
  if (!version) return null; // pas de dictionnaire déclaré → rien à vérifier
  const name = path.basename(dir);
  // On parcourt les schémas (bodies) + les inline des paths (params compris).
  const doc = { schemas: mergeFiles(globYaml(path.join(dir, 'schemas'))), paths: mergeFiles(globYaml(path.join(dir, 'paths'))) };

  // Le dico est cherché dans dico/ à la racine du dépôt courant (process.cwd()), pas dans le
  // package : chaque projet fournit son propre dico/<version>.xlsx.
  const dicoFile = path.join(process.cwd(), 'dico', version);
  if (!fs.existsSync(dicoFile)) {
    let annotated = 0;
    walk(doc, name, { onId: () => annotated++, onLeafNoId: () => {}, onParamNoId: () => {} });
    if (annotated === 0) return { name, version, metadataOnly: true }; // x-dictionary-version = simple métadonnée
    throw new Error(`dictionnaire dico/${version} introuvable — ${annotated} champ(s) annoté(s) à valider`);
  }
  const dico = loadDictionary(dicoFile);

  const errors = [], warnings = [];
  let checked = 0, leafNoId = 0, paramNoId = 0, todo = 0;
  walk(doc, name, {
    onId(node, p) {
      const raw = node['x-dictionary-id'], id = String(raw).trim();
      if (id === '' || id === '?') { todo++; warnings.push({ p, msg: `x-dictionary-id à renseigner (« ${raw} »)` }); return; }
      checked++;
      const exp = dico.resolve(id);
      if (!exp.found) { errors.push({ p, msg: `x-dictionary-id « ${id} » introuvable dans le dictionnaire` }); return; }
      for (const { sev, msg } of compareField(node, exp)) (sev === 'error' ? errors : warnings).push({ p, msg });
    },
    onLeafNoId(p) { leafNoId++; warnings.push({ p, msg: 'champ scalaire sans x-dictionary-id — oubli ?' }); },
    onParamNoId(p) { paramNoId++; warnings.push({ p, msg: 'paramètre sans x-dictionary-id — oubli ?' }); },
  });
  return { name, version, checked, leafNoId, paramNoId, todo, errors, warnings };
}

function projectDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map((d) => path.join(root, d))
    .filter((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'api.yaml')));
}

export function runCheckDictionaryCli(argv = process.argv.slice(2)) {
  const arg = argv.find((a) => !a.startsWith('-'));
  const dirs = arg ? [path.resolve(arg)] : projectDirs(path.join(ROOT, 'examples'));
  let totalErr = 0, ran = 0;
  for (const dir of dirs) {
    let r;
    try { r = checkProject(dir); } catch (e) { console.error(`✗ ${path.basename(dir)} : ${e.message}`); totalErr++; ran++; continue; }
    if (!r) continue; // pas de x-dictionary-version
    ran++;
    if (r.metadataOnly) { console.log(`\n▸ ${r.name}  (dico ${r.version}) — aucune annotation x-dictionary-id, métadonnée seule`); continue; }
    console.log(`\n▸ ${r.name}  (dico ${r.version}) — ${r.checked} champ(s) annoté(s) vérifié(s)`);
    for (const e of r.errors) console.log(`  ✗ ${e.p} : ${e.msg}`);
    for (const w of r.warnings.slice(0, 40)) console.log(`  ⚠ ${w.p} : ${w.msg}`);
    if (r.warnings.length > 40) console.log(`  ⚠ … +${r.warnings.length - 40} autre(s) warning(s)`);
    console.log(`  → ${r.errors.length} erreur(s), ${r.warnings.length} warning(s) (${r.leafNoId} champ(s) + ${r.paramNoId} param(s) sans id, ${r.todo} à renseigner).`);
    totalErr += r.errors.length;
  }
  if (!ran && !totalErr) { console.log('Aucun projet avec info.x-dictionary-version.'); return; }
  console.log(`\n${totalErr === 0 ? '✓ Conforme au dictionnaire.' : `✗ ${totalErr} écart(s) bloquant(s) avec le dictionnaire.`}`);
  if (totalErr) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCheckDictionaryCli();
