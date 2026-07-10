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
// Version d'event par défaut quand le fichier n'en déclare pas.
const DEFAULT_EVENT_VERSION = '1.0';

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

export function deepMerge(a, b) {
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
// events/ accepte aussi les .json (JSON Schema).
function globEvents(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f)).sort().map((f) => path.join(dir, f));
}

const mergeFiles = (files, seed = {}) => files.reduce((acc, f) => deepMerge(acc, loadYaml(f)), seed);
export const pascal = (s) => String(s).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

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

// Métadonnées d'un fichier d'event consommées par le build (retirées du schéma de payload).
const EVENT_META = new Set(['x-event-type', 'x-event-version', 'x-summary', 'x-description', 'x-operation-id', 'x-tags', 'x-deprecated']);

// events/ : chaque fichier = JSON Schema du payload + métadonnées x-event-*. Génère un webhook.
function loadEvents(dir) {
  const operations = {};
  const schemas = {};
  for (const file of globEvents(path.join(dir, 'events'))) {
    const raw = loadYaml(file);
    const type = raw['x-event-type'];
    if (!type) throw new Error(`events/${path.basename(file)} : "x-event-type" manquant`);

    // payload = le schéma privé des métadonnées consommées
    const payload = {};
    for (const [k, v] of Object.entries(raw)) if (!EVENT_META.has(k)) payload[k] = v;

    // requestBody : réutilise un $ref nu tel quel, sinon enregistre le schéma inline.
    let schemaRef;
    if (typeof payload.$ref === 'string' && Object.keys(payload).length === 1) {
      schemaRef = payload.$ref;
    } else {
      const name = payload.title || `${pascal(type)}Event`;
      schemas[name] = payload;
      schemaRef = `#/components/schemas/${name}`;
    }

    const post = {
      operationId: raw['x-operation-id'] || `on${pascal(type)}`,
      'x-event': type,
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: schemaRef } } } },
      responses: { '2xx': null },
    };
    // version par défaut si absente (l'import la pose déjà ; défensif ici aussi).
    const version = raw['x-event-version'] || DEFAULT_EVENT_VERSION;
    // summary : le résumé humain seul. Les coordonnées d'event (X-Event-Type / -Version)
    // sont portées par info.description du swagger (cf. describeEvent), pas par le webhook.
    post.summary = raw['x-summary'] || type;
    if (raw['x-description']) post.description = raw['x-description'];
    post['x-event-version'] = version;
    if (raw['x-tags']) post.tags = raw['x-tags'];
    if (raw['x-deprecated']) post.deprecated = true;
    operations[type] = { post };
  }
  return { operations, schemas };
}

function loadProject(dir) {
  const api = loadYaml(path.join(dir, 'api.yaml'));
  const type = api.type;
  if (!type) throw new Error(`api.yaml sans champ "type" dans ${dir}`);
  delete api.type; // champ de contrôle, pas de l'OpenAPI final

  // Champs optionnels → nullable. Défaut : requêtes OUI, réponses NON (nullable en réponse est
  // cassant). Configurable par projet via `nullableOptionals` dans api.yaml :
  //   false | true | { requests: bool, responses: bool }
  const nullCfg = api.nullableOptionals;
  delete api.nullableOptionals; // champ de contrôle
  const nullable = { requests: true, responses: false };
  if (nullCfg === false) nullable.requests = false;
  else if (isObj(nullCfg)) {
    nullable.requests = nullCfg.requests !== false;
    nullable.responses = nullCfg.responses === true;
  }

  const operations = mergeFiles(globYaml(path.join(dir, 'paths')));
  const schemas = mergeFiles(globYaml(path.join(dir, 'schemas')));
  if (type === 'events') {
    const ev = loadEvents(dir);           // webhooks générés depuis events/
    Object.assign(operations, ev.operations);
    Object.assign(schemas, ev.schemas);
  }
  const doc = { ...api };
  doc.components = deepMerge(doc.components ?? {}, { schemas });
  return { type, operations, doc, nullable };
}

// ------------------------------------------------------------------ injections
function ensureParam(op, ref) {
  op.parameters ??= [];
  const key = ref.$ref;
  if (!op.parameters.some((p) => p.$ref === key)) op.parameters.push(ref);
}

// Remplace le paramètre $ref <compName> par une copie inline portant un example spécifique
// (un $ref ne peut pas porter d'example propre à l'opération).
function inlineParamExample(op, doc, compName, example) {
  if (example == null || !Array.isArray(op.parameters)) return;
  const ref = `#/components/parameters/${compName}`;
  const idx = op.parameters.findIndex((p) => p.$ref === ref);
  const comp = doc.components?.parameters?.[compName];
  if (idx === -1 || !isObj(comp)) return;
  op.parameters[idx] = { ...structuredClone(comp), example };
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

export function injectErrors(op, method, hasPathParam) {
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
export function expandPagination(op, doc) {
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

// Passe une propriété en nullable (OpenAPI 3.1).
export function asNullable(s) {
  if (!isObj(s)) return s;
  if (s.$ref) return { anyOf: [{ $ref: s.$ref }, { type: 'null' }] }; // un $ref nu ne peut pas porter null
  const t = s.type;
  if (Array.isArray(t)) { if (!t.includes('null')) s.type = [...t, 'null']; return s; }
  if (typeof t === 'string') { if (t !== 'null') s.type = [t, 'null']; return s; }
  if (s.allOf || s.oneOf || s.anyOf) return { anyOf: [s, { type: 'null' }] };       // composition
  return s; // schéma libre {} : accepte déjà null
}

// Rend nullable les propriétés optionnelles d'un schéma (récursif sur les sous-schémas).
export function nullableSchema(schema) {
  if (!isObj(schema)) return;
  if (isObj(schema.properties)) {
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const key of Object.keys(schema.properties)) {
      if (!req.has(key)) schema.properties[key] = asNullable(schema.properties[key]);
    }
  }
  for (const kw of ['items', 'not', 'additionalProperties']) if (isObj(schema[kw])) nullableSchema(schema[kw]);
  for (const kw of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(schema[kw])) schema[kw].forEach(nullableSchema);
  if (isObj(schema.properties)) for (const v of Object.values(schema.properties)) nullableSchema(v);
}

// Schémas composants atteignables depuis une RÉPONSE (à ne jamais rendre nullable : ce serait
// cassant pour le consommateur — cf. SPEC §10).
export function responseReachableSchemas(doc) {
  const seen = new Set(); const names = new Set(); const queue = [];
  for (const cont of [doc.paths, doc.webhooks]) {
    if (!isObj(cont)) continue;
    for (const item of Object.values(cont)) {
      if (!isObj(item)) continue;
      for (const m of HTTP_METHODS) if (isObj(item[m]?.responses)) queue.push(...collectRefs(item[m].responses, []));
    }
  }
  while (queue.length) {
    const ref = queue.pop();
    if (typeof ref !== 'string' || !ref.startsWith('#/components/') || seen.has(ref)) continue;
    seen.add(ref);
    if (ref.startsWith('#/components/schemas/')) names.add(schemaNameFromRef(ref));
    const node = resolveComponent(doc, ref);
    if (node !== undefined) queue.push(...collectRefs(node, []));
  }
  return names;
}

// Optionnel → nullable, piloté par { requests, responses } :
//  - un schéma composant atteignable depuis une réponse → soumis au flag `responses` ;
//    sinon (requête seule ou inutilisé) → soumis au flag `requests` ;
//  - schémas inline des requestBody → `requests` ; des responses → `responses`.
export function nullableOptionals(doc, { requests = true, responses = false } = {}) {
  const responseSchemas = responseReachableSchemas(doc);
  for (const [name, def] of Object.entries(doc.components?.schemas ?? {})) {
    if (responseSchemas.has(name) ? responses : requests) nullableSchema(def);
  }
  for (const cont of [doc.paths, doc.webhooks]) {
    if (!isObj(cont)) continue;
    for (const item of Object.values(cont)) {
      if (!isObj(item)) continue;
      for (const m of HTTP_METHODS) {
        const op = item[m];
        if (!isObj(op)) continue;
        if (requests) for (const media of Object.values(op.requestBody?.content ?? {})) {
          if (isObj(media?.schema) && !media.schema.$ref) nullableSchema(media.schema);
        }
        if (responses) for (const resp of Object.values(op.responses ?? {})) {
          if (!isObj(resp) || resp.$ref) continue;
          for (const media of Object.values(resp.content ?? {})) if (isObj(media?.schema) && !media.schema.$ref) nullableSchema(media.schema);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ assemblage d'un projet
export function buildProject(dir, outDir = DEFAULT_OUT) {
  const name = path.basename(path.resolve(dir));
  const { type, operations, doc: projectDoc, nullable } = loadProject(dir);

  let doc = deepMerge(loadCore(), loadProfile(type));
  doc = deepMerge(doc, projectDoc);
  doc.info = { ...(doc.info ?? {}), 'x-socle-version': SOCLE_VERSION, 'x-socle-type': type }; // traçabilité du socle

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
        // events : payload brut, ack 204 (No Content) + codes d'erreur communs ;
        // pas de pagination, pas d'Idempotency-Key (dédup via X-Event-Id).
        const evType = op['x-event'];
        const evVersion = op['x-event-version'];
        delete op['x-event']; // marqueur documentaire ; l'injection est pilotée par le type
        normalizeEventAck(op);                  // réponse de succès → 204
        injectErrors(op, method, pathHasParam); // catalogue d'erreurs commun
        // exemples spécifiques à l'event sur X-Event-Type / X-Event-Version (params inlinés).
        inlineParamExample(op, doc, 'XEventType', evType);
        inlineParamExample(op, doc, 'XEventVersion', evVersion);
      } else {
        injectIdempotency(op, method);
        expandPagination(op, doc);
        injectErrors(op, method, pathHasParam);
      }
      // headers de réponse (tous optionnels) sur toute réponse inline, events compris ;
      // les $ref d'erreur les portent déjà.
      for (const resp of Object.values(op.responses ?? {})) attachResponseHeaders(resp);
    }
    container[route] = item;
  }

  if (isEvents) doc.webhooks = deepMerge(doc.webhooks ?? {}, container);
  else doc.paths = deepMerge(doc.paths ?? {}, container);

  nullableOptionals(doc, nullable); // champs optionnels → nullable (requêtes par défaut, réponses en opt-in)
  stripDictAnnotations(doc);   // retire x-dictionary-id + x-estreem-* (annotations internes ; x-dictionary-version conservé)

  fs.mkdirSync(outDir, { recursive: true });
  const dump = (d) => yaml.dump(d, { lineWidth: 120, noRefs: true, sortKeys: false });
  const write = (d, file) => {
    pruneUnusedComponents(d); // n'émet que les composants réellement référencés
    validateRefs(d, path.basename(file, '.openapi.yaml'));
    fs.writeFileSync(file, dump(d));
    return file;
  };

  // events avec PLUSIEURS events → un swagger webhook par event (chacun réduit à ses composants).
  const webhookRoutes = isEvents ? Object.keys(doc.webhooks ?? {}) : [];
  const outFiles = [];
  if (webhookRoutes.length > 1) {
    for (const route of webhookRoutes) {
      const one = structuredClone({ ...doc, webhooks: { [route]: doc.webhooks[route] } });
      describeEvent(one, route);
      outFiles.push(write(one, path.join(outDir, `${name}-${eventSlug(route)}.openapi.yaml`)));
    }
  } else {
    if (webhookRoutes.length === 1) describeEvent(doc, webhookRoutes[0]);
    outFiles.push(write(doc, path.join(outDir, `${name}.openapi.yaml`)));
  }
  return { name, type, outFiles, operations: Object.keys(operations).length };
}

// Slug de nom de fichier depuis une clé d'event (ex. order.created → order-created).
export const eventSlug = (route) => String(route).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

// events : chaque swagger de sortie porte UN event. Ses coordonnées (X-Event-Type = la clé
// de route, X-Event-Version = l'extension de l'opération) sont ajoutées à info.description
// (bloc Markdown), et non au webhook. L'extension x-event-version reste sur l'opération.
function describeEvent(doc, route) {
  const version = doc.webhooks?.[route]?.post?.['x-event-version'] ?? DEFAULT_EVENT_VERSION;
  const coords = `- **X-Event-Type**: ${route}\n- **X-Event-Version**: ${version}`;
  const base = doc.info?.description ? `${doc.info.description}\n\n` : '';
  doc.info = { ...(doc.info ?? {}), description: `${base}${coords}` };
}

// events : la réponse de succès est un 204 (ack sans corps). Retire toute réponse 2xx déclarée.
function normalizeEventAck(op) {
  op.responses ??= {};
  for (const key of Object.keys(op.responses)) if (/^2/.test(key)) delete op.responses[key];
  op.responses['204'] = { description: 'Event acquitté par le partenaire (No Content).' };
}

// Retire les annotations internes du dictionnaire : x-dictionary-id et tout x-estreem-*.
// x-dictionary-version (dans info) est conservé pour la traçabilité.
export function stripDictAnnotations(node) {
  if (Array.isArray(node)) { node.forEach(stripDictAnnotations); return; }
  if (!isObj(node)) return;
  for (const k of Object.keys(node)) {
    if (k === 'x-dictionary-id' || k.startsWith('x-estreem')) delete node[k];
    else stripDictAnnotations(node[k]);
  }
}

// ------------------------------------------------------------------ tree-shaking des composants
// Ne conserve que les composants (schemas/parameters/headers/responses/securitySchemes)
// réellement atteignables depuis paths/webhooks/security. Le socle fournit un sur-ensemble ;
// le contrat final ne porte que ce qu'il utilise (pagination, headers d'event, etc.).
function collectSecuritySchemeNames(node, set) {
  if (Array.isArray(node)) { node.forEach((n) => collectSecuritySchemeNames(n, set)); return; }
  if (!isObj(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'security' && Array.isArray(v)) { for (const req of v) if (isObj(req)) Object.keys(req).forEach((s) => set.add(s)); }
    else collectSecuritySchemeNames(v, set);
  }
}

function resolveComponent(doc, ref) {
  let cur = doc;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function pruneUnusedComponents(doc) {
  if (!isObj(doc.components)) return;
  const { components, ...outside } = doc; // racines : refs hors de components

  const reachable = new Set(collectRefs(outside, []).filter((r) => r.startsWith('#/components/')));
  const queue = [...reachable];
  while (queue.length) {
    const node = resolveComponent(doc, queue.pop());
    for (const r of collectRefs(node, [])) {
      if (r.startsWith('#/components/') && !reachable.has(r)) { reachable.add(r); queue.push(r); }
    }
  }

  const usedSchemes = new Set();
  collectSecuritySchemeNames(outside, usedSchemes);

  for (const [kind, group] of Object.entries(components)) {
    if (!isObj(group)) continue;
    for (const name of Object.keys(group)) {
      const keep = kind === 'securitySchemes' ? usedSchemes.has(name) : reachable.has(`#/components/${kind}/${name}`);
      if (!keep) delete group[name];
    }
    if (!Object.keys(group).length) delete components[kind];
  }
}

// ------------------------------------------------------------------ validation légère des $ref internes
export function collectRefs(node, acc) {
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
  if (idx !== -1 && !process.argv[idx + 1]) {
    console.error('Usage : npm run build:one -- <nom-du-projet>   (ex. npm run build:one -- cms-exposed)');
    process.exit(1);
  }
  const filter = idx !== -1 ? process.argv[idx + 1] : null;
  const { dirs, results } = buildProjects({ root: EXAMPLES, outDir: DEFAULT_OUT, filter });
  if (!dirs.length) {
    console.error(filter ? `Projet "${filter}" introuvable.` : 'Aucun projet dans examples/.');
    process.exit(1);
  }
  let ok = 0;
  for (const r of results) {
    if (r.ok) {
      const outs = r.outFiles.map((f) => `build/${path.basename(f)}`).join(', ');
      console.log(`✓ ${r.name.padEnd(28)} [${r.type}]  ${r.operations} route(s)  → ${outs}`); ok++;
    } else console.error(`✗ ${r.name} : ${r.error}`);
  }
  console.log(`\n${ok}/${dirs.length} projet(s) construit(s).`);
  if (ok !== dirs.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
