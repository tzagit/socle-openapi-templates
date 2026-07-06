#!/usr/bin/env node
// Moteur de build du système de templating OpenAPI.
// Assemble, pour chaque projet : core (couche 1) ⊕ profil (couche 2) ⊕ projet (couche 3),
// puis injecte les éléments communs (headers, erreurs, pagination) et expanse les macros.
// Voir SPEC.md pour le détail des règles.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// ROOT/TEMPLATES sont résolus depuis le PACKAGE (le socle est livré avec ses templates).
// Les projets et la sortie sont fournis par l'appelant (le dépôt consommateur).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = path.join(ROOT, 'templates');
const EXAMPLES = path.join(ROOT, 'examples'); // défaut pour le dev du socle lui-même
const DEFAULT_OUT = path.join(ROOT, 'build');
// Version du socle (stampée dans info.x-socle-version de chaque contrat généré).
const SOCLE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

// ------------------------------------------------------------------ règles d'injection
// Headers de requête communs (tous types) — refs vers components.parameters.
const COMMON_REQUEST_HEADERS = ['XRequestId', 'XCorrelationId', 'XInstitutionId', 'XUserId', 'XUserContextId'];
// En plus pour called + events.
const PROCESSING_ROUTE_HEADER = ['XProcessingRouteId'];
// En plus pour events : headers d'event obligatoires + traçabilité d'origine (optionnels).
// Headers de livraison (X-Event-Time/-Source, X-Webhook-Id, X-Delivery-Id) : non inclus (SPEC §7.3).
const EVENT_HEADERS = ['XEventId', 'XEventType', 'XEventVersion'];
const EVENT_ORIGIN_HEADERS = ['XOriginalRequestId', 'XOriginalCorrelationId', 'OriginalIdempotencyKey'];

// Idempotency-Key par méthode (cf. §6.2).
const IDEMPOTENCY_BY_METHOD = {
  post: 'IdempotencyKeyRequired',
  patch: 'IdempotencyKeyRequired',
  put: 'IdempotencyKeyOptional',
  delete: 'IdempotencyKeyOptional',
};

// Codes d'erreur communs, avec leur règle de pertinence (cf. §6.4).
const ERRORS_ALWAYS = ['400', '401', '403', '405', '406', '429', '500', '502', '503', '504'];
const ERROR_IF_PATH_PARAM = '404';
const ERROR_IF_WRITE = '409';
const ERRORS_IF_BODY = ['422'];
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

// Headers de réponse communs : nom HTTP -> ref components.headers (cf. §6.3).
const RESPONSE_HEADERS = {
  'X-Request-Id': 'EchoRequestId',
  'X-Correlation-Id': 'EchoCorrelationId',
  'X-Institution-Id': 'EchoInstitutionId',
  'X-User-Id': 'EchoUserId',
  'X-UserContext-Id': 'EchoUserContextId',
  'X-Processing-Route-Id': 'ProcessingRouteId',
};

// ------------------------------------------------------------------ helpers
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const loadYaml = (file) => yaml.load(fs.readFileSync(file, 'utf8')) ?? {};

function deepMerge(a, b) {
  if (b === undefined) return a;
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = isObj(a[k]) && isObj(b[k]) ? deepMerge(a[k], b[k]) : b[k];
  return out;
}

function globYaml(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(dir, f));
}

const mergeFiles = (files, seed = {}) => files.reduce((acc, f) => deepMerge(acc, loadYaml(f)), seed);

// Ref helpers
const paramRef = (name) => ({ $ref: `#/components/parameters/${name}` });
const headerRef = (name) => ({ $ref: `#/components/headers/${name}` });
const responseRef = (code) => ({ $ref: `#/components/responses/Error${code}` });
const schemaNameFromRef = (ref) => String(ref).split('/').pop();

// ------------------------------------------------------------------ chargement des couches
function loadCore() {
  let core = loadYaml(path.join(TEMPLATES, 'core', 'base.yaml'));
  const parts = [
    ...globYaml(path.join(TEMPLATES, 'core', 'headers')),
    ...globYaml(path.join(TEMPLATES, 'core', 'responses')),
    ...globYaml(path.join(TEMPLATES, 'core', 'schemas')),
    ...globYaml(path.join(TEMPLATES, 'core', 'parameters')),
  ];
  return mergeFiles(parts, core);
}

function loadProfile(type) {
  const file = path.join(TEMPLATES, 'profiles', `${type}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`Profil inconnu : "${type}" (attendu exposed|called|events)`);
  return loadYaml(file);
}

function loadProject(dir) {
  const api = loadYaml(path.join(dir, 'api.yaml'));
  const type = api.type;
  if (!type) throw new Error(`api.yaml sans champ "type" dans ${dir}`);
  delete api.type; // champ de contrôle, pas de l'OpenAPI final

  const operations = mergeFiles(globYaml(path.join(dir, 'paths')));
  const schemas = mergeFiles(globYaml(path.join(dir, 'schemas')));
  const doc = { ...api };
  doc.components = deepMerge(doc.components ?? {}, { schemas });
  return { type, operations, doc };
}

// ------------------------------------------------------------------ injections
function ensureParam(op, ref) {
  op.parameters ??= [];
  const key = ref.$ref;
  if (!op.parameters.some((p) => p.$ref === key)) op.parameters.push(ref);
}

function injectRequestHeaders(op, type) {
  for (const h of COMMON_REQUEST_HEADERS) ensureParam(op, paramRef(h));
  if (type === 'called' || type === 'events') for (const h of PROCESSING_ROUTE_HEADER) ensureParam(op, paramRef(h));
  if (type === 'events') {
    for (const h of EVENT_HEADERS) ensureParam(op, paramRef(h));
    for (const h of EVENT_ORIGIN_HEADERS) ensureParam(op, paramRef(h));
  }
}

function injectIdempotency(op, method) {
  const comp = IDEMPOTENCY_BY_METHOD[method];
  if (comp) ensureParam(op, paramRef(comp));
}

function attachResponseHeaders(response) {
  if (!isObj(response) || response.$ref) return; // pas de headers sur un $ref
  response.headers = deepMerge(
    Object.fromEntries(Object.entries(RESPONSE_HEADERS).map(([name, ref]) => [name, headerRef(ref)])),
    response.headers ?? {},
  );
}

function injectErrors(op, method, hasPathParam) {
  op.responses ??= {};
  const codes = new Set(ERRORS_ALWAYS);
  if (hasPathParam) codes.add(ERROR_IF_PATH_PARAM);
  if (WRITE_METHODS.has(method)) codes.add(ERROR_IF_WRITE);
  if (op.requestBody) for (const c of ERRORS_IF_BODY) codes.add(c);

  for (const c of op['x-errors'] ?? []) codes.add(String(c));
  for (const c of op['x-no-errors'] ?? []) codes.delete(String(c));
  delete op['x-errors'];
  delete op['x-no-errors'];

  for (const c of codes) op.responses[c] ??= responseRef(c);
}

// Macro x-paginated: '#/components/schemas/Order' -> Page<Order> + params page/size/sort.
function expandPagination(op, doc) {
  const itemRef = op['x-paginated'];
  delete op['x-paginated'];
  if (!itemRef || itemRef === false) return;

  const itemName = schemaNameFromRef(itemRef);
  const pageSchema = `PageOf${itemName}`;
  doc.components.schemas ??= {};
  doc.components.schemas[pageSchema] ??= {
    allOf: [
      { $ref: '#/components/schemas/Page' },
      { type: 'object', properties: { content: { type: 'array', items: { $ref: itemRef } } } },
    ],
  };

  for (const p of ['PageParam', 'SizeParam', 'SortParam']) ensureParam(op, paramRef(p));

  const existing = isObj(op.responses?.['200']) ? op.responses['200'] : {};
  op.responses ??= {};
  op.responses['200'] = deepMerge(
    { description: 'Page de résultats.', content: { 'application/json': { schema: { $ref: `#/components/schemas/${pageSchema}` } } } },
    existing,
  );
}

// ------------------------------------------------------------------ assemblage d'un projet
export function buildProject(dir, outDir = DEFAULT_OUT) {
  const name = path.basename(path.resolve(dir));
  const { type, operations, doc: projectDoc } = loadProject(dir);

  let doc = deepMerge(loadCore(), loadProfile(type));
  doc = deepMerge(doc, projectDoc);
  doc.info = { ...(doc.info ?? {}), 'x-socle-version': SOCLE_VERSION }; // traçabilité du socle

  const isEvents = type === 'events';
  const container = {}; // paths ou webhooks

  for (const [route, item] of Object.entries(operations)) {
    if (!isObj(item)) continue;
    const pathHasParam = /\{[^}]+\}/.test(route);
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;

      injectRequestHeaders(op, type);

      if (isEvents) {
        // events : payload brut, pas de pagination, pas de catalogue d'erreurs,
        // pas d'Idempotency-Key (dédup via X-Event-Id ; origine via Original-Idempotency-Key).
        delete op['x-event']; // marqueur documentaire ; l'injection est pilotée par le type
        normalizeAckResponses(op);
      } else {
        injectIdempotency(op, method);
        expandPagination(op, doc);
        injectErrors(op, method, pathHasParam);
      }
      // headers de réponse sur toute réponse définie inline (les $ref d'erreur les portent déjà).
      // Pas pour les events : le 2XX est l'ack produit par le partenaire, pas par mon SI.
      if (!isEvents) for (const resp of Object.values(op.responses ?? {})) attachResponseHeaders(resp);
    }
    container[route] = item;
  }

  if (isEvents) doc.webhooks = deepMerge(doc.webhooks ?? {}, container);
  else doc.paths = deepMerge(doc.paths ?? {}, container);

  validateRefs(doc, name);

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${name}.openapi.yaml`);
  fs.writeFileSync(outFile, yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false }));
  return { name, type, outFile, operations: Object.keys(operations).length };
}

// events : transforme une réponse d'ack déclarée `'2xx': ~` en 2XX avec description.
function normalizeAckResponses(op) {
  op.responses ??= {};
  for (const key of Object.keys(op.responses)) {
    if (/^2xx$/i.test(key)) {
      const val = op.responses[key];
      delete op.responses[key];
      op.responses['2XX'] = isObj(val) ? val : { description: 'Event acquitté par le partenaire.' };
    }
  }
  if (!Object.keys(op.responses).length) op.responses['2XX'] = { description: 'Event acquitté par le partenaire.' };
}

// ------------------------------------------------------------------ validation légère des $ref internes
function collectRefs(node, acc) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, acc));
  else if (isObj(node)) for (const [k, v] of Object.entries(node)) (k === '$ref' && typeof v === 'string') ? acc.push(v) : collectRefs(v, acc);
  return acc;
}

function resolvePointer(doc, ref) {
  if (!ref.startsWith('#/')) return true; // ref externe : hors périmètre de ce check
  let cur = doc;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) || !(key in cur)) return false;
    cur = cur[key];
  }
  return true;
}

function validateRefs(doc, name) {
  const missing = [...new Set(collectRefs(doc, []))].filter((r) => !resolvePointer(doc, r));
  if (missing.length) throw new Error(`[${name}] $ref non résolus :\n  - ${missing.join('\n  - ')}`);
}

// ------------------------------------------------------------------ découverte des projets
const isProjectDir = (dir) => fs.existsSync(path.join(dir, 'api.yaml'));

function projectDirs(root, filter) {
  if (isProjectDir(root)) return [root]; // le dossier fourni EST un projet
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)              // sinon : conteneur de projets (un sous-dossier par API)
    .map((d) => path.join(root, d))
    .filter((d) => fs.statSync(d).isDirectory() && isProjectDir(d))
    .filter((d) => !filter || path.basename(d) === filter);
}

// API : construit un ou plusieurs projets. `root` peut être un projet ou un conteneur de projets.
export function buildProjects({ root = EXAMPLES, outDir = DEFAULT_OUT, filter = null } = {}) {
  const dirs = projectDirs(root, filter);
  const results = [];
  for (const dir of dirs) {
    try { results.push({ ok: true, ...buildProject(dir, outDir) }); }
    catch (e) { results.push({ ok: false, name: path.basename(dir), error: e.message }); }
  }
  return { dirs, results };
}

// CLI de dev du socle : `node tools/build.mjs [--project <nom>]` construit examples/ → build/.
function main() {
  const idx = process.argv.indexOf('--project');
  const filter = idx !== -1 ? process.argv[idx + 1] : null;
  const { dirs, results } = buildProjects({ root: EXAMPLES, outDir: DEFAULT_OUT, filter });
  if (!dirs.length) {
    console.error(filter ? `Projet "${filter}" introuvable.` : 'Aucun projet dans examples/.');
    process.exit(1);
  }
  let ok = 0;
  for (const r of results) {
    if (r.ok) { console.log(`✓ ${r.name.padEnd(28)} [${r.type}]  ${r.operations} route(s)  → build/${r.name}.openapi.yaml`); ok++; }
    else console.error(`✗ ${r.name} : ${r.error}`);
  }
  console.log(`\n${ok}/${dirs.length} projet(s) construit(s).`);
  if (ok !== dirs.length) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
