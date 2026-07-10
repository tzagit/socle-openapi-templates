// Tests unitaires de l'importer (dé-factorisation d'un OpenAPI existant → projet du socle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectVersionPrefix, stripVersionPrefix, appendSegment, convertNullable,
  sanitize, eventNameFromPath, groupKey, canon, detectPagination, factorSchemas, importDoc,
} from '../tools/import.mjs';

test('detectVersionPrefix — une seule version portée par les paths', () => {
  assert.equal(detectVersionPrefix({ '/v1/a': {}, '/v1/b': {} }), 'v1');
  assert.equal(detectVersionPrefix({ '/V1/a': {}, '/health': {} }), 'v1', 'insensible à la casse, tolère un path non versionné');
  assert.equal(detectVersionPrefix({ '/v1/a': {}, '/v2/b': {} }), null, 'versions multiples → ambigu → null');
  assert.equal(detectVersionPrefix({ '/orders': {} }), null, 'aucune version → null');
});

test('stripVersionPrefix / appendSegment', () => {
  assert.equal(stripVersionPrefix('/v1/orders', 'v1'), '/orders');
  assert.equal(stripVersionPrefix('/v1', 'v1'), '/', 'route réduite à la racine');
  assert.equal(appendSegment('https://x/api', 'v1'), 'https://x/api/v1');
  assert.equal(appendSegment('https://x/api/v1', 'v1'), 'https://x/api/v1', 'idempotent si déjà suffixé');
});

test('convertNullable — 3.0 { nullable:true } → 3.1 [type,"null"]', () => {
  const stats = { nullable: 0, unhandledNullable: 0 };
  const out = convertNullable({ type: 'string', nullable: true }, stats);
  assert.deepEqual(out, { type: ['string', 'null'] });
  assert.equal(stats.nullable, 1);
  assert.deepEqual(convertNullable({ type: 'string', nullable: false }, stats), { type: 'string' }, 'nullable:false simplement retiré');
});

test('sanitize / eventNameFromPath / groupKey', () => {
  assert.equal(sanitize('My API!'), 'my-api');
  assert.equal(sanitize(''), 'api');
  assert.equal(eventNameFromPath('/order-created'), 'order-created');
  assert.equal(eventNameFromPath('/events/{id}/thing'), 'thing', 'ignore les segments paramétrés');
  assert.equal(groupKey('/orders/{id}', false), 'orders');
  assert.equal(groupKey('/anything', true), 'events', 'events → un seul fichier');
});

test('canon — forme canonique indépendante de l’ordre des clés', () => {
  assert.equal(canon({ a: 1, b: [2, 3] }), canon({ b: [2, 3], a: 1 }));
  assert.notEqual(canon({ a: 1 }), canon({ a: 2 }));
});

test('detectPagination — reconnaît une enveloppe Page<Item> sur le 200', () => {
  const doc = {};
  const op = { responses: { '200': { content: { 'application/json': { schema: {
    allOf: [
      { $ref: '#/components/schemas/Page' },
      { type: 'object', properties: { content: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } },
    ],
  } } } } } };
  const dropped = new Set();
  assert.equal(detectPagination(op, doc, dropped), true);
  assert.equal(op['x-paginated'], '#/components/schemas/Order', 'macro x-paginated reconstruite vers l’item');
});

test('factorSchemas — hisse un sous-schéma dupliqué en composant partagé', () => {
  const addr = () => ({ type: 'object', properties: { city: { type: 'string' } } });
  // A et B diffèrent à la racine (sinon B serait entièrement factorisé en $ref A) mais
  // partagent le même sous-schéma addr → seul addr doit être hissé.
  const schemas = {
    A: { type: 'object', properties: { name: { type: 'string' }, addr: addr() } },
    B: { type: 'object', properties: { code: { type: 'integer' }, addr: addr() } },
  };
  const factored = factorSchemas({}, schemas);
  assert.ok(factored.length >= 1, 'au moins un groupe factorisé');
  assert.ok(schemas.A.properties.addr.$ref, 'A.addr devient un $ref');
  assert.equal(schemas.A.properties.addr.$ref, schemas.B.properties.addr.$ref, 'A et B pointent le même composant');
});

test('importDoc events — un fichier de schémas par event (+ common pour les partagés)', () => {
  const doc = {
    openapi: '3.0.1',
    info: { title: 'Events', version: '1.0.0' },
    paths: {
      '/order-created': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderCreated' } } } }, responses: { '200': {} } } },
      '/order-cancelled': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderCancelled' } } } }, responses: { '200': {} } } },
    },
    components: { schemas: {
      OrderCreated: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } },
      OrderCancelled: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' }, reason: { type: 'string' } } },
      Order: { type: 'object', properties: { id: { type: 'string' } } }, // partagé par les deux events
    } },
  };
  const r = importDoc(doc, { type: 'events', name: 'ev', factor: false });
  assert.ok(r.schemaFiles, 'schemaFiles présent pour un import events');
  assert.ok(r.schemaFiles['order-created']?.OrderCreated, 'OrderCreated dans son propre fichier');
  assert.ok(r.schemaFiles['order-cancelled']?.OrderCancelled, 'OrderCancelled dans son propre fichier');
  assert.ok(r.schemaFiles.common?.Order, 'schéma partagé → common.yaml');
  assert.ok(!r.schemaFiles['order-created']?.Order, 'le partagé n’est pas dupliqué dans le fichier d’event');
});

test('importDoc — dé-factorise un OpenAPI 3.0 (intégration)', () => {
  const doc = {
    openapi: '3.0.1',
    info: { title: 'Test API', version: '1.0.0', 'x-dictionary-version': 'D.xlsx' },
    servers: [{ url: 'https://api.x/svc' }],
    paths: {
      '/v1/orders/{id}': {
        get: {
          operationId: 'getOrder',
          parameters: [
            { name: 'X-Request-Id', in: 'header', schema: { type: 'string' } }, // commun → retiré
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }, // métier → conservé
          ],
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
            '404': { description: 'not found' }, // erreur → retirée (réinjectée par le socle)
          },
        },
      },
    },
    components: { schemas: { Order: { type: 'object', properties: { id: { type: 'string', nullable: true } } } } },
  };

  const r = importDoc(doc, { type: 'exposed', name: 'test', factor: false });
  assert.equal(r.resolvedType, 'exposed');
  assert.equal(r.api.type, 'exposed');
  assert.equal(r.api.info['x-dictionary-version'], 'D.xlsx', 'extension custom de info conservée');
  assert.equal(r.versionSeg, 'v1', 'version /v1 détectée');
  assert.equal(r.api.servers[0].url, 'https://api.x/svc/v1', 'version remontée dans le base path');

  const op = r.files.orders['/orders/{id}'].get; // route dé-versionnée + regroupée
  const paramNames = (op.parameters || []).map((p) => p.name);
  assert.deepEqual(paramNames, ['id'], 'header commun retiré, param métier conservé');
  assert.deepEqual(Object.keys(op.responses), ['200'], 'seul le 2xx métier est conservé');
  assert.deepEqual(r.schemas.Order.properties.id.type, ['string', 'null'], 'nullable 3.0 converti en 3.1');
});
