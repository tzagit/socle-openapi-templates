// Tests de la fonction Spectral custom versionMajorMatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import versionMajorMatch from '../functions/versionMajorMatch.js';

const empty = (r) => r === undefined || (Array.isArray(r) && r.length === 0);

test('versionMajorMatch — majeure cohérente → aucun problème', () => {
  assert.ok(empty(versionMajorMatch({ info: { version: '2.3.0' }, servers: [{ url: 'https://x/api/v2' }] })));
  assert.ok(empty(versionMajorMatch({ info: { version: '1.0.0' }, servers: [{ url: 'http://x/v1/' }] })));
});

test('versionMajorMatch — divergence → un problème par server', () => {
  const r = versionMajorMatch({ info: { version: '2.10.0' }, servers: [{ url: 'https://api/issuing/v1' }] });
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].path, ['servers', 0, 'url']);
  assert.match(r[0].message, /2.*≠.*v1/);
});

test('versionMajorMatch — non jugé quand rien à comparer', () => {
  assert.ok(empty(versionMajorMatch({ info: { version: '1.0.0' } })), 'pas de servers (events)');
  assert.ok(empty(versionMajorMatch({ info: { version: '1.0.0' }, servers: [{ url: 'https://x/api' }] })), 'pas de /vN dans l’url');
  assert.ok(empty(versionMajorMatch({ servers: [{ url: 'https://x/v1' }] })), 'pas de version');
});
