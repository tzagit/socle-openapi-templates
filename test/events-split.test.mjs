// Tests du découpage « un swagger webhook par event » (type events multi-events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventSlug, buildProject } from '../tools/build.mjs';

test('eventSlug — slug de fichier depuis une clé d’event', () => {
  assert.equal(eventSlug('order.created'), 'order-created');
  assert.equal(eventSlug('IAS.Transaction'), 'ias-transaction');
  assert.equal(eventSlug('a__b--c'), 'a-b-c');
});

// Construit un projet events éphémère et vérifie la sortie.
function makeProject(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socle-ev-'));
  fs.writeFileSync(path.join(dir, 'api.yaml'), 'type: events\ninfo: { title: T, version: 1.0.0 }\n');
  fs.mkdirSync(path.join(dir, 'events'));
  for (const e of events) {
    fs.writeFileSync(path.join(dir, 'events', `${e}.yaml`),
      `x-event-type: ${e}\nx-summary: ev ${e}\ntype: object\nproperties: { id: { type: string } }\n`);
  }
  return dir;
}

test('buildProject events — PLUSIEURS events → un swagger par event', () => {
  const dir = makeProject(['order.created', 'order.cancelled']);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'socle-out-'));
  const r = buildProject(dir, out);
  assert.equal(r.outFiles.length, 2, 'deux contrats produits');
  const names = r.outFiles.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, [`${r.name}-order-cancelled.openapi.yaml`, `${r.name}-order-created.openapi.yaml`]);
  for (const f of r.outFiles) assert.ok(fs.existsSync(f), `${f} écrit`);
});

test('buildProject events — UN SEUL event → un contrat unique (comportement inchangé)', () => {
  const dir = makeProject(['order.created']);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'socle-out-'));
  const r = buildProject(dir, out);
  assert.equal(r.outFiles.length, 1, 'un seul contrat');
  assert.equal(path.basename(r.outFiles[0]), `${r.name}.openapi.yaml`);
});
