// Tests du chargeur de dictionnaire, sur le vrai fichier dico/ (fixture du dépôt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDictionary } from '../tools/dictionary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICO = path.join(ROOT, 'dico', '_DICO_ESTREEM_v21.15.xlsx');
const available = fs.existsSync(DICO);

test('loadDictionary.resolve — type simple', { skip: available ? false : 'dico absent' }, () => {
  const dico = loadDictionary(DICO);
  const r = dico.resolve('250331121313'); // cardholder.cardholderId
  assert.equal(r.found, true);
  assert.equal(r.kind, 'simple');
  assert.equal(r.type, 'string');
  assert.equal(r.object, 'cardholder');
  assert.equal(r.attribute, 'cardholderId');
});

test('loadDictionary.resolve — codeset (énumération)', { skip: available ? false : 'dico absent' }, () => {
  const dico = loadDictionary(DICO);
  const r = dico.resolve('250617090116'); // cardSelectionCode → CardSelectionCodeset
  assert.equal(r.kind, 'codeset');
  assert.ok(Array.isArray(r.enum) && r.enum.length > 0, 'liste de valeurs');
  for (const v of ['AATA', 'ACTV', 'BLKD']) assert.ok(r.enum.includes(v), `enum contient ${v}`);
});

test('loadDictionary.resolve — type structuré (objet + sous-champs)', { skip: available ? false : 'dico absent' }, () => {
  const dico = loadDictionary(DICO);
  const r = dico.resolve('241112000106'); // cardholder.postalAddress → PostalAddressType
  assert.equal(r.kind, 'structured');
  assert.equal(r.type, 'object');
  assert.ok(r.attributes?.buildingNumber, 'sous-champ buildingNumber résolu');
  assert.equal(r.attributes.buildingNumber.kind, 'simple');
  assert.equal(r.attributes.buildingNumber.maxLength, 16);
});

test('loadDictionary.resolve — id inconnu → found:false', { skip: available ? false : 'dico absent' }, () => {
  const dico = loadDictionary(DICO);
  assert.equal(dico.resolve('000000000000').found, false);
});
