#!/usr/bin/env node
// Importer : transforme un OpenAPI 3.0/3.1 déjà rédigé en un projet du socle.
// C'est l'inverse de build.mjs : on « dé-factorise » le contrat en retirant tout ce
// que le socle réinjecte (headers communs, erreurs, pagination, sécurité, schémas
// Page/StandardErrorObject…) et on reconstruit les macros (x-paginated, x-event).
//
// Usage :
//   node tools/import.mjs <input.yaml|json> [--name <projet>] [--type exposed|called|events] [--no-factor] [--force]
//
// L'entrée doit être un fichier UNIQUE (bundlé). Si votre contrat est éclaté en
// plusieurs fichiers, bundlez-le d'abord :  npx redocly bundle in.yaml -o bundled.yaml
//
// Voir SPEC.md pour les règles du socle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = path.join(ROOT, 'projects');

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

// ------------------------------------------------------------------ ce que le socle fournit
// Headers de requête communs (retirés à l'import — réinjectés au build). Cf. §6.1/§6.2/§7.
const COMMON_REQUEST_HEADERS = new Set([
  'x-request-id', 'x-correlation-id', 'x-institution-id', 'x-user-id', 'x-usercontext-id',
  'idempotency-key', 'x-processing-route-id',
  'x-event-id', 'x-event-type', 'x-event-version',
  'x-event-time', 'x-event-source', 'x-webhook-id', 'x-delivery-id',
  'x-original-request-id', 'x-original-correlation-id', 'original-idempotency-key',
]);
// Paramètres de requête de pagination/tri communs (§8.1).
const COMMON_QUERY = new Set(['page', 'size', 'sort']);
// Headers de réponse communs (§6.3) — retirés des réponses 2xx conservées.
const COMMON_RESPONSE_HEADERS = new Set([
  'x-request-id', 'x-correlation-id', 'x-institution-id', 'x-user-id', 'x-usercontext-id',
  'x-processing-route-id',
]);
// Codes d'erreur factorisés (§6.4) — retirés des opérations (le socle les réinjecte).
const ERROR_CODES = new Set([
  '400', '401', '403', '404', '405', '406', '409', '415', '422', '429',
  '500', '502', '503', '504',
]);
// Schémas fournis par le socle (§6.5/§8.2) — jamais réémis par le projet.
const SOCLE_SCHEMAS = new Set(['StandardErrorObject', 'Page', 'PageMeta']);

// ------------------------------------------------------------------ helpers
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const lower = (s) => String(s).toLowerCase();
const is2xx = (code) => /^2/.test(String(code)); // 2xx, 200, 201, 2XX… ; exclut default/4xx/5xx
const nameFromRef = (ref) => String(ref).split('/').pop();

function loadDoc(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = yaml.load(raw); // YAML est un sur-ensemble de JSON : gère .yaml et .json
  if (!isObj(doc)) throw new Error(`Contenu invalide dans ${file}`);
  return doc;
}

function resolveRef(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined; // externe : hors périmètre
  let cur = doc;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

const sanitize = (s) => lower(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api';

// ------------------------------------------------------------------ inlining des $ref non-schéma
// On garde les $ref vers #/components/schemas/* (le projet réémet ces schémas) mais on inline
// les autres composants (requestBodies, responses, parameters, headers, examples…) pour que
// le projet soit autonome — le socle ne fournit pas ces composants.
const NON_SCHEMA_COMPONENT = /^#\/components\/(requestBodies|responses|parameters|headers|examples|links|callbacks)\//;

function inlineNonSchemaRefs(node, doc, warnings, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => inlineNonSchemaRefs(n, doc, warnings, seen));
  if (!isObj(node)) return node;

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (ref.startsWith('#/components/schemas/')) return { ...node }; // laissé tel quel
    if (NON_SCHEMA_COMPONENT.test(ref)) {
      if (seen.has(ref)) return {}; // garde-fou anti-cycle
      const target = resolveRef(doc, ref);
      if (target === undefined) { warnings.add(`$ref introuvable, laissé tel quel : ${ref}`); return { ...node }; }
      return inlineNonSchemaRefs(clone(target), doc, warnings, new Set(seen).add(ref));
    }
    if (!ref.startsWith('#/')) warnings.add(`$ref externe conservé tel quel : ${ref}`);
    return { ...node };
  }

  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = inlineNonSchemaRefs(v, doc, warnings, seen);
  return out;
}

// ------------------------------------------------------------------ conversion 3.0 -> 3.1 (nullable)
// OpenAPI 3.0 : `{ type: X, nullable: true }`. En 3.1 : `{ type: [X, 'null'] }`.
function convertNullable(node, stats) {
  if (Array.isArray(node)) return node.map((n) => convertNullable(n, stats));
  if (!isObj(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = convertNullable(v, stats);
  if (out.nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null'];
    else stats.unhandledNullable++;
    delete out.nullable;
    stats.nullable++;
  } else if (out.nullable === false) {
    delete out.nullable;
  }
  return out;
}

// ------------------------------------------------------------------ filtrage des paramètres
function paramMeta(p) {
  // p est déjà inliné (plus de $ref de paramètre) : on lit name/in directement.
  return { name: p && p.name ? lower(p.name) : '', in: p && p.in };
}
// Retire les paramètres fournis par le socle (headers communs, pagination/tri) et
// CONSERVE tout header custom. Compte les normalisations dans stats.
function filterParams(params, stats) {
  const kept = [];
  for (const p of params) {
    const { name, in: loc } = paramMeta(p);
    if (loc === 'header' && COMMON_REQUEST_HEADERS.has(name)) { stats.reqHeaders++; continue; } // remis en conformité
    if (loc === 'query' && COMMON_QUERY.has(name)) { stats.query++; continue; }
    if (loc === 'header') stats.customHeadersKept++; // header custom → conservé tel quel
    kept.push(p);
  }
  return kept;
}

// ------------------------------------------------------------------ détection de pagination
// Reconstruit x-paginated à partir d'une enveloppe de type Page<Item> sur le 200.
function pageItemRef(schemaNode, doc) {
  if (!isObj(schemaNode)) return null;
  const hasContentItems = (n) => isObj(n) && isObj(n.properties?.content?.items) && typeof n.properties.content.items.$ref === 'string';
  const metaKeys = ['pagination', 'page', 'pageable', 'totalElements', 'totalPages', 'number'];

  if (Array.isArray(schemaNode.allOf)) {
    for (const member of schemaNode.allOf) {
      const m = isObj(member) && member.$ref ? resolveRef(doc, member.$ref) : member;
      if (hasContentItems(m)) return m.properties.content.items.$ref;
    }
  }
  if (hasContentItems(schemaNode) && metaKeys.some((k) => k in (schemaNode.properties || {}))) {
    return schemaNode.properties.content.items.$ref;
  }
  return null;
}

function detectPagination(op, doc, droppedWrappers) {
  const existing200 = op.responses?.['200'];
  const media = existing200?.content?.['application/json'];
  if (!isObj(media) || !isObj(media.schema)) return false;
  let node = media.schema;
  let wrapperName = null;
  if (typeof node.$ref === 'string') {
    wrapperName = nameFromRef(node.$ref);
    node = resolveRef(doc, node.$ref);
  }
  const itemRef = pageItemRef(node, doc);
  if (!itemRef) return false;
  op['x-paginated'] = itemRef;
  // On régénère le 200 au build ; on préserve toutefois d'éventuels headers custom
  // survivants (les headers communs ayant déjà été retirés en amont).
  const customHeaders = isObj(existing200?.headers) && Object.keys(existing200.headers).length ? existing200.headers : null;
  op.responses = { '200': customHeaders ? { headers: customHeaders } : null };
  if (wrapperName) droppedWrappers.add(wrapperName);
  return true;
}

// ------------------------------------------------------------------ traitement d'une opération
function processOperation(rawOp, { isEvents, route, method, doc, warnings, droppedWrappers, stats }) {
  let op = inlineNonSchemaRefs(clone(rawOp), doc, warnings);
  delete op.security; // la sécurité est portée par le profil

  if (Array.isArray(op.parameters)) {
    op.parameters = filterParams(op.parameters, stats);
    if (!op.parameters.length) delete op.parameters;
  }

  // Remise en conformité des réponses : on ne conserve que les 2xx métier (le socle
  // réinjecte le catalogue d'erreurs standard). Tout code non-2xx, `default`, ou code
  // hors norme est donc retiré. Sur les 2xx conservés, on retire les headers de réponse
  // communs (réinjectés au build) et on garde les headers custom.
  if (isObj(op.responses)) {
    for (const code of Object.keys(op.responses)) {
      if (!is2xx(code) || code === 'default') { delete op.responses[code]; stats.errorCodes++; }
    }
    for (const resp of Object.values(op.responses)) {
      if (isObj(resp) && isObj(resp.headers)) {
        for (const h of Object.keys(resp.headers)) if (COMMON_RESPONSE_HEADERS.has(lower(h))) { delete resp.headers[h]; stats.respHeaders++; }
        if (!Object.keys(resp.headers).length) delete resp.headers;
      }
    }
  }

  if (isEvents) {
    op['x-event'] = route;              // marqueur documentaire (le type pilote l'injection)
    op.responses = { '2xx': null };     // ack attendu du partenaire (géré par le socle)
  } else if (method === 'get') {
    detectPagination(op, doc, droppedWrappers);
  }

  if (!isObj(op.responses) || !Object.keys(op.responses).length) {
    warnings.add(`${method.toUpperCase()} ${route} : aucune réponse 2xx après nettoyage.`);
  }
  return op;
}

// ------------------------------------------------------------------ atteignabilité des schémas
// Racines : schémas référencés par les opérations conservées (via $ref ou via x-paginated).
function collectSchemaRoots(node, acc) {
  if (Array.isArray(node)) node.forEach((n) => collectSchemaRoots(n, acc));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) acc.add(nameFromRef(v));
      else if (k === 'x-paginated' && typeof v === 'string') acc.add(nameFromRef(v));
      else collectSchemaRoots(v, acc);
    }
  }
  return acc;
}
// Références de schéma internes à une définition de schéma.
function schemaRefsIn(def, acc) {
  if (Array.isArray(def)) def.forEach((n) => schemaRefsIn(n, acc));
  else if (isObj(def)) {
    for (const [k, v] of Object.entries(def)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) acc.add(nameFromRef(v));
      else schemaRefsIn(v, acc);
    }
  }
  return acc;
}

// ------------------------------------------------------------------ factorisation des schémas répétés
// Forme canonique (clés triées) pour comparer deux schémas indépendamment de l'ordre.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}`;
  return JSON.stringify(v);
}
// Un schéma « vaut la peine » d'être factorisé : objet à propriétés, composition, ou enum.
function isFactorable(n) {
  if (!isObj(n) || n.$ref) return false;
  if (isObj(n.properties) && Object.keys(n.properties).length >= 1) return true;
  if (Array.isArray(n.allOf) || Array.isArray(n.anyOf) || Array.isArray(n.oneOf)) return true;
  if (Array.isArray(n.enum) && n.enum.length >= 2) return true;
  return false;
}
// Énumère chaque nœud-schéma (racine + sous-positions) avec un setter pour le remplacer.
function walkSchema(node, set, depth, ctxKey, rootName, slots) {
  if (!isObj(node)) return;
  slots.push({ node, set, depth, ctxKey, rootName });
  if (node.$ref) return;
  if (isObj(node.items)) walkSchema(node.items, (v) => { node.items = v; }, depth + 1, ctxKey, null, slots);
  if (isObj(node.not)) walkSchema(node.not, (v) => { node.not = v; }, depth + 1, ctxKey, null, slots);
  if (isObj(node.additionalProperties)) walkSchema(node.additionalProperties, (v) => { node.additionalProperties = v; }, depth + 1, ctxKey, null, slots);
  for (const kw of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(node[kw])) node[kw].forEach((m, i) => { if (isObj(m)) walkSchema(m, (v) => { node[kw][i] = v; }, depth + 1, ctxKey, null, slots); });
  }
  if (isObj(node.properties)) for (const pk of Object.keys(node.properties)) {
    if (isObj(node.properties[pk])) walkSchema(node.properties[pk], (v) => { node.properties[pk] = v; }, depth + 1, pk, null, slots);
  }
}
// Trouve tous les nœuds-schémas du projet : racines de la map schemas + tout `schema:` des paths.
function collectSchemaSlots(files, schemasMap) {
  const slots = [];
  for (const name of Object.keys(schemasMap)) {
    walkSchema(schemasMap[name], (v) => { schemasMap[name] = v; }, 0, null, name, slots);
  }
  const findInPaths = (obj) => {
    if (Array.isArray(obj)) obj.forEach(findInPaths);
    else if (isObj(obj)) for (const [k, v] of Object.entries(obj)) {
      if (k === 'schema' && isObj(v)) walkSchema(v, (nv) => { obj[k] = nv; }, 1, null, null, slots);
      else findInPaths(v);
    }
  };
  findInPaths(files);
  return slots;
}
const pascal = (s) => String(s).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Shared';
function mostCommon(arr) {
  const c = {}; let best = arr[0], n = 0;
  for (const x of arr) { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; best = x; } }
  return best;
}
function genName(slots, used) {
  let base = slots[0].node.title ? pascal(slots[0].node.title) : null;
  if (!base) { const keys = slots.map((s) => s.ctxKey).filter(Boolean); if (keys.length) base = pascal(mostCommon(keys)); }
  if (!base) base = 'Shared';
  let name = base, i = 2;
  while (used.has(name) || SOCLE_SCHEMAS.has(name) || /^PageOf/.test(name)) name = base + i++;
  return name;
}
// Boucle en point fixe, du plus profond au plus superficiel : hisse un groupe de doublons par tour.
function factorSchemas(files, schemasMap) {
  const factored = [];
  const used = new Set(Object.keys(schemasMap));
  for (let guard = 0; guard < 1000; guard++) {
    const slots = collectSchemaSlots(files, schemasMap);
    const groups = new Map();
    for (const s of slots) {
      if (!isFactorable(s.node)) continue;
      const key = canon(s.node);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    let pick = null, pickDepth = -1;
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      const d = Math.max(...arr.map((s) => s.depth));
      if (d > pickDepth) { pickDepth = d; pick = arr; }
    }
    if (!pick) break;

    const named = pick.find((s) => s.rootName);
    let name;
    if (named) name = named.rootName;
    else { name = genName(pick, used); used.add(name); schemasMap[name] = clone(pick[0].node); }
    for (const s of pick) {
      if (s.rootName === name) continue; // on garde la définition canonique
      s.set({ $ref: `#/components/schemas/${name}` });
    }
    factored.push({ name, count: pick.length });
  }
  return factored;
}

// ------------------------------------------------------------------ regroupement des routes en fichiers
function groupKey(route, isEvents) {
  if (isEvents) return 'events';
  const seg = String(route).split('/').filter(Boolean)[0];
  return seg ? sanitize(seg.replace(/\{.*$/, '') || seg) : 'root';
}

// ------------------------------------------------------------------ écriture
const HEADER = '# Généré par tools/import.mjs — dé-factorisé depuis un OpenAPI existant.\n';
function dump(obj) {
  return HEADER + yaml.dump(obj, { lineWidth: 120, noRefs: true, sortKeys: false });
}

// ------------------------------------------------------------------ assemblage du projet
function importDoc(doc, { type, name, factor = true }) {
  const warnings = new Set();
  const droppedWrappers = new Set();
  // Compteurs de « remise en conformité » (éléments non conformes retirés / customs conservés).
  const stats = { reqHeaders: 0, respHeaders: 0, errorCodes: 0, query: 0, customHeadersKept: 0 };

  const version = String(doc.openapi || doc.swagger || '');
  const is30 = version.startsWith('3.0');
  if (doc.swagger) throw new Error('Swagger 2.0 non supporté : convertissez d’abord en OpenAPI 3.x.');

  const hasWebhooks = isObj(doc.webhooks) && Object.keys(doc.webhooks).length > 0;
  const resolvedType = type || (hasWebhooks ? 'events' : 'exposed');
  if (!['exposed', 'called', 'events'].includes(resolvedType)) {
    throw new Error(`--type invalide : "${resolvedType}" (attendu exposed|called|events)`);
  }
  const isEvents = resolvedType === 'events';

  // Source des opérations : webhooks pour events, sinon paths.
  const source = isEvents ? (doc.webhooks || {}) : (doc.paths || {});

  // --- traitement des opérations, regroupées par fichier ---
  const files = {}; // groupKey -> { route -> pathItem }
  for (const [route, rawItemOrRef] of Object.entries(source)) {
    let item = rawItemOrRef;
    if (isObj(item) && typeof item.$ref === 'string') item = resolveRef(doc, item.$ref);
    if (!isObj(item)) continue;

    const outItem = {};
    // champs de niveau path-item conservés (hors parameters communs et servers).
    for (const [k, v] of Object.entries(item)) {
      if (HTTP_METHODS.includes(k) || k === 'parameters' || k === 'servers') continue;
      outItem[k] = clone(v);
    }
    // parameters communs au path-item : filtrés comme ceux des opérations.
    if (Array.isArray(item.parameters)) {
      const kept = filterParams(inlineNonSchemaRefs(clone(item.parameters), doc, warnings), stats);
      if (kept.length) outItem.parameters = kept;
    }
    for (const method of HTTP_METHODS) {
      if (!isObj(item[method])) continue;
      outItem[method] = processOperation(item[method], { isEvents, route, method, doc, warnings, droppedWrappers, stats });
    }

    const key = groupKey(route, isEvents);
    (files[key] ??= {})[route] = outItem;
  }

  // --- schémas métier (composants schemas moins le socle et les enveloppes de page) ---
  const allSchemas = isObj(doc.components?.schemas) ? doc.components.schemas : {};
  const nullableStats = { nullable: 0, unhandledNullable: 0 };
  const schemas = {};
  for (const [schemaName, def] of Object.entries(allSchemas)) {
    if (SOCLE_SCHEMAS.has(schemaName)) continue;
    if (/^PageOf/.test(schemaName)) continue;      // enveloppe régénérée par le build
    if (droppedWrappers.has(schemaName)) continue; // enveloppe de pagination détectée
    let out = clone(def);
    if (is30) out = convertNullable(out, nullableStats);
    schemas[schemaName] = out;
  }

  // --- purge des schémas devenus orphelins (ex. format d'erreur maison, plus référencé
  //     après remise en conformité des codes retour) ---
  const roots = collectSchemaRoots(files, new Set());
  const reachable = new Set();
  const queue = [...roots];
  while (queue.length) {
    const n = queue.pop();
    if (reachable.has(n)) continue;
    reachable.add(n);
    if (schemas[n]) for (const r of schemaRefsIn(schemas[n], new Set())) if (!reachable.has(r)) queue.push(r);
  }
  const prunedSchemas = Object.keys(schemas).filter((n) => !reachable.has(n));
  for (const n of prunedSchemas) delete schemas[n];

  // --- factorisation des schémas inline répétés dans components.schemas ---
  const factoredSchemas = factor ? factorSchemas(files, schemas) : [];

  // --- api.yaml (couche 3 : le minimum) ---
  const api = { type: resolvedType };
  if (isObj(doc.info)) {
    api.info = {};
    for (const k of ['title', 'version', 'description']) if (doc.info[k] != null) api.info[k] = doc.info[k];
  }
  if (Array.isArray(doc.servers) && doc.servers.length) api.servers = clone(doc.servers);
  if (Array.isArray(doc.tags) && doc.tags.length) api.tags = clone(doc.tags);

  return {
    api, files, schemas, isEvents, resolvedType, name,
    warnings: [...warnings], nullableStats, is30,
    droppedWrappers: [...droppedWrappers], prunedSchemas, stats, factoredSchemas,
  };
}

function writeProject(result, { force }) {
  const dir = path.join(PROJECTS, result.name);
  if (fs.existsSync(dir) && !force) {
    throw new Error(`Le projet "${result.name}" existe déjà (projects/${result.name}). Utilisez --force pour écraser.`);
  }
  fs.mkdirSync(path.join(dir, 'paths'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'schemas'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'api.yaml'), dump(result.api));
  for (const [key, routes] of Object.entries(result.files)) {
    fs.writeFileSync(path.join(dir, 'paths', `${key}.yaml`), dump(routes));
  }
  if (Object.keys(result.schemas).length) {
    fs.writeFileSync(path.join(dir, 'schemas', 'schemas.yaml'), dump(result.schemas));
  }
  return dir;
}

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--no-factor') args.factor = false;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--type') args.type = argv[++i];
    else if (a.startsWith('--')) throw new Error(`Option inconnue : ${a}`);
    else args._.push(a);
  }
  return args;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(1); }

  const input = args._[0];
  if (!input) {
    console.error('Usage : node tools/import.mjs <input.yaml|json> [--name <projet>] [--type exposed|called|events] [--no-factor] [--force]');
    process.exit(1);
  }
  if (!fs.existsSync(input)) { console.error(`Fichier introuvable : ${input}`); process.exit(1); }

  let result;
  try {
    const doc = loadDoc(input);
    const name = sanitize(args.name || doc.info?.title || path.basename(input).replace(/\.(ya?ml|json)$/i, ''));
    result = importDoc(doc, { type: args.type, name, factor: args.factor !== false });
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const dir = writeProject(result, { force: args.force });

  const nbRoutes = Object.values(result.files).reduce((n, r) => n + Object.keys(r).length, 0);
  console.log(`✓ Projet "${result.name}" [${result.resolvedType}] → projects/${result.name}/`);
  console.log(`  ${nbRoutes} route(s) dans ${Object.keys(result.files).length} fichier(s), ${Object.keys(result.schemas).length} schéma(s) métier.`);
  if (result.is30) console.log(`  OpenAPI 3.0 détecté : ${result.nullableStats.nullable} champ(s) nullable convertis en 3.1.`);
  if (result.droppedWrappers.length) console.log(`  Pagination reconstruite (x-paginated), enveloppe(s) retirée(s) : ${result.droppedWrappers.join(', ')}.`);

  const s = result.stats;
  const norm = [];
  if (s.reqHeaders) norm.push(`${s.reqHeaders} header(s) de requête commun(s)`);
  if (s.respHeaders) norm.push(`${s.respHeaders} header(s) de réponse commun(s)`);
  if (s.errorCodes) norm.push(`${s.errorCodes} réponse(s) non-2xx`);
  if (s.query) norm.push(`${s.query} param(s) pagination/tri`);
  if (norm.length) console.log(`  Remis en conformité (retirés, réinjectés par le socle) : ${norm.join(', ')}.`);
  if (s.customHeadersKept) console.log(`  ${s.customHeadersKept} header(s) custom conservé(s).`);
  if (result.prunedSchemas.length) console.log(`  Schéma(s) orphelin(s) purgé(s) : ${result.prunedSchemas.join(', ')}.`);
  if (result.factoredSchemas.length) console.log(`  Doublons factorisés dans components.schemas : ${result.factoredSchemas.map((f) => `${f.name} (×${f.count})`).join(', ')}.`);

  if (result.nullableStats.unhandledNullable) console.log(`  ⚠ ${result.nullableStats.unhandledNullable} nullable non convertible automatiquement (type non scalaire) — à vérifier.`);
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  console.log(`\nProchaine étape : node tools/build.mjs --project ${result.name}`);
}

main();
