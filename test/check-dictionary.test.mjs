// Tests de la comparaison champ ↔ dictionnaire et du parcours des annotations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareField, walk, normPat, effType, isScalarLeaf } from '../tools/check-dictionary.mjs';

const errors = (out) => out.filter((o) => o.sev === 'error').map((o) => o.msg);
const warns = (out) => out.filter((o) => o.sev === 'warn').map((o) => o.msg);

test('normPat / effType / isScalarLeaf', () => {
  assert.equal(normPat('^abc$'), 'abc', 'ancres retirées');
  assert.equal(normPat(null), null);
  assert.equal(effType(['string', 'null']), 'string');
  assert.equal(effType('integer'), 'integer');
  assert.equal(isScalarLeaf({ type: 'string' }), true);
  assert.equal(isScalarLeaf({ type: 'array', items: {} }), false, 'array n’est pas une feuille');
  assert.equal(isScalarLeaf({ type: 'object', properties: {} }), false, 'objet conteneur');
});

test('compareField — conforme → aucun écart', () => {
  const exp = { found: true, kind: 'simple', type: 'string', pattern: '[0-9a-zA-Z\\-]{1,36}', minLength: 1, maxLength: 36 };
  const field = { type: 'string', pattern: '^[0-9a-zA-Z\\-]{1,36}$', minLength: 1, maxLength: 36 };
  assert.deepEqual(compareField(field, exp), [], 'ancres normalisées → pattern identique');
});

test('compareField — type / longueur divergents → erreurs', () => {
  const exp = { found: true, kind: 'simple', type: 'string', maxLength: 36 };
  assert.ok(errors(compareField({ type: 'integer' }, exp)).some((m) => /type/.test(m)), 'type ≠ → erreur');
  assert.ok(errors(compareField({ type: 'string', maxLength: 99 }, exp)).some((m) => /maxLength/.test(m)), 'maxLength ≠ → erreur');
});

test('compareField — format (le dico met un format dans "type")', () => {
  const exp = { found: true, kind: 'simple', type: 'uuid' }; // uuid = format OpenAPI → type string
  assert.deepEqual(compareField({ type: 'string', format: 'uuid' }, exp), [], 'string+format:uuid conforme');
  assert.ok(warns(compareField({ type: 'string' }, exp)).some((m) => /format manquant/.test(m)), 'format absent → warning');
  assert.ok(errors(compareField({ type: 'string', format: 'date-time' }, exp)).some((m) => /format/.test(m)), 'format ≠ → erreur');
});

test('compareField — enum (Codeset)', () => {
  const exp = { found: true, kind: 'codeset', type: 'string', enum: ['A', 'B'] };
  assert.deepEqual(compareField({ type: 'string', enum: ['B', 'A'] }, exp), [], 'même ensemble (ordre libre) → conforme');
  assert.ok(errors(compareField({ type: 'string', enum: ['A'] }, exp)).some((m) => /enum/.test(m)), 'enum ≠ → erreur');
  assert.ok(warns(compareField({ type: 'string' }, exp)).some((m) => /enum manquant/.test(m)), 'enum absent → warning');
});

test('compareField — type structuré non résolu → warning', () => {
  const out = compareField({ type: 'object' }, { found: true, kind: 'unknown', typeName: 'AmountType' });
  assert.equal(errors(out).length, 0);
  assert.ok(warns(out).some((m) => /non résolu/.test(m)));
});

test('walk — repère les ids de body ET de params, signale les params sans id', () => {
  const doc = {
    schemas: { Req: { type: 'object', properties: {
      id: { type: 'string', 'x-dictionary-id': '111' },
      note: { type: 'string' }, // feuille sans id → onLeafNoId
    } } },
    paths: { '/x': { get: { parameters: [
      { name: 'q', in: 'query', schema: { type: 'string', 'x-dictionary-id': '222' } }, // param annoté → onId
      { name: 'r', in: 'query', schema: { type: 'string' } },                            // param sans id → onParamNoId
    ] } } },
  };
  const ids = [], leaves = [], params = [];
  walk(doc, 'root', {
    onId: (n) => ids.push(n['x-dictionary-id']),
    onLeafNoId: (p) => leaves.push(p),
    onParamNoId: (p) => params.push(p),
  });
  assert.deepEqual(ids.sort(), ['111', '222'], 'ids de body et de param détectés');
  assert.equal(leaves.length, 1, 'une feuille de body sans id');
  assert.equal(params.length, 1, 'un paramètre sans id');
  assert.match(params[0], /\(r\)/, 'le param sans id est bien « r »');
});
