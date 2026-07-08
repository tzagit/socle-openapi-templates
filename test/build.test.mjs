// Tests unitaires du moteur de build (fonctions pures / déterministes).
// Lancer : npm test   (ou : node --test test/build.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepMerge, pascal, asNullable, injectErrors, expandPagination,
  stripDictAnnotations, pruneUnusedComponents, collectRefs,
} from '../tools/build.mjs';

test('deepMerge — fusion récursive, b prioritaire, arrays remplacés', () => {
  assert.deepEqual(deepMerge({ a: 1, o: { x: 1 } }, { b: 2, o: { y: 2 } }), { a: 1, b: 2, o: { x: 1, y: 2 } });
  assert.deepEqual(deepMerge({ v: 1 }, { v: 2 }), { v: 2 }, 'b écrase les scalaires');
  assert.deepEqual(deepMerge({ list: [1, 2] }, { list: [3] }), { list: [3] }, 'les tableaux sont remplacés, pas concaténés');
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 }, 'b indéfini → a inchangé');
});

test('pascal — PascalCase depuis séparateurs variés', () => {
  assert.equal(pascal('order-created'), 'OrderCreated');
  assert.equal(pascal('card agreement.owner'), 'CardAgreementOwner');
  assert.equal(pascal('already'), 'Already');
});

test('asNullable — passe un schéma en nullable (3.1)', () => {
  assert.deepEqual(asNullable({ type: 'string' }), { type: ['string', 'null'] });
  assert.deepEqual(asNullable({ $ref: '#/c/S' }), { anyOf: [{ $ref: '#/c/S' }, { type: 'null' }] }, 'un $ref nu → anyOf');
  assert.deepEqual(asNullable({ type: ['integer'] }), { type: ['integer', 'null'] });
  assert.deepEqual(asNullable({ type: ['string', 'null'] }), { type: ['string', 'null'] }, 'déjà nullable → inchangé');
  const comp = { allOf: [{ $ref: '#/c/A' }] };
  assert.deepEqual(asNullable(comp), { anyOf: [comp, { type: 'null' }] }, 'composition → anyOf');
});

test('injectErrors — catalogue contextuel par méthode', () => {
  const always = ['400', '401', '403', '405', '406', '429', '500', '502', '503', '504'];

  const get = { responses: {} };
  injectErrors(get, 'get', false);
  assert.deepEqual(Object.keys(get.responses).sort(), [...always].sort(), 'GET sans body ni path param → catalogue seul');

  const post = { requestBody: {}, responses: {} };
  injectErrors(post, 'post', false);
  assert.ok('409' in post.responses, 'POST (écriture) → 409');
  assert.ok('422' in post.responses, 'requestBody → 422');

  const del = { responses: {} };
  injectErrors(del, 'delete', true);
  assert.ok('404' in del.responses, 'paramètre de path → 404');
  assert.ok('409' in del.responses, 'DELETE (écriture) → 409');
  assert.ok(!('422' in del.responses), 'sans body → pas de 422');

  const custom = { responses: {}, 'x-errors': ['418'], 'x-no-errors': ['429'] };
  injectErrors(custom, 'get', false);
  assert.ok('418' in custom.responses, 'x-errors ajoute un code');
  assert.ok(!('429' in custom.responses), 'x-no-errors retire un code');
  assert.ok(!('x-errors' in custom) && !('x-no-errors' in custom), 'les macros sont consommées');
});

test('expandPagination — macro x-paginated → PageOf<Item> + params', () => {
  const doc = { components: { schemas: {} } };
  const op = { 'x-paginated': '#/components/schemas/Order', responses: {} };
  expandPagination(op, doc);
  assert.ok(doc.components.schemas.PageOfOrder, 'schéma PageOfOrder créé');
  const params = op.parameters.map((p) => p.$ref);
  for (const name of ['PageParam', 'SizeParam', 'SortParam']) {
    assert.ok(params.includes(`#/components/parameters/${name}`), `param ${name} injecté`);
  }
  assert.ok(op.responses['200'], 'réponse 200 générée');
  assert.ok(!('x-paginated' in op), 'la macro est consommée');
});

test('stripDictAnnotations — retire x-dictionary-id + x-estreem-*, garde le reste', () => {
  const doc = {
    info: { 'x-dictionary-version': 'D.xlsx' },
    components: { schemas: { S: { properties: {
      f: { type: 'string', 'x-dictionary-id': '123', 'x-estreem-field-original-name': 'foo', 'x-enumDescriptions': { A: 'a' } },
    } } } },
  };
  stripDictAnnotations(doc);
  const f = doc.components.schemas.S.properties.f;
  assert.ok(!('x-dictionary-id' in f), 'x-dictionary-id retiré');
  assert.ok(!('x-estreem-field-original-name' in f), 'x-estreem-* retiré');
  assert.equal(doc.info['x-dictionary-version'], 'D.xlsx', 'x-dictionary-version conservé');
  assert.ok(f['x-enumDescriptions'], 'x-enumDescriptions conservé');
});

test('pruneUnusedComponents — ne garde que les composants atteignables', () => {
  const doc = {
    paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Used' } } } } } } } },
    components: { schemas: {
      Used: { type: 'object' },
      Unused: { type: 'object' },
    } },
  };
  pruneUnusedComponents(doc);
  assert.ok(doc.components.schemas.Used, 'schéma utilisé conservé');
  assert.ok(!doc.components.schemas.Unused, 'schéma orphelin supprimé');
});

test('collectRefs — collecte tous les $ref', () => {
  const refs = collectRefs({ a: { $ref: '#/x' }, b: [{ $ref: '#/y' }], c: 3 }, []);
  assert.deepEqual(refs.sort(), ['#/x', '#/y']);
});
