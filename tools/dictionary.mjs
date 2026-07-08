// Chargeur du dictionnaire Estreem (.xlsx). Résout un x-dictionary-id vers la définition
// attendue (type, pattern, longueurs, enum, digits) en suivant la chaîne :
//   x-dictionary-id → DICO_Complet.Reference → Type → TypesSimples (simple) | Codeset (énum).
import xlsx from 'xlsx';

const trimKeys = (r) => { const o = {}; for (const k of Object.keys(r)) o[String(k).trim()] = r[k]; return o; };
const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const s = str(v); if (s === '') return null; const n = Number(s.replace(',', '.')); return Number.isFinite(n) ? n : null; };

export function loadDictionary(file) {
  const wb = xlsx.readFile(file);
  const sheet = (n) => (wb.Sheets[n] ? xlsx.utils.sheet_to_json(wb.Sheets[n], { defval: '' }).map(trimKeys) : []);

  const byId = new Map();
  for (const r of sheet('DICO_Complet')) { const id = str(r['Reference']); if (id) byId.set(id, r); }

  const simpleByName = new Map();
  for (const r of sheet('TypesSimples')) { const n = str(r['Libellés']); if (n) simpleByName.set(n, r); }

  const codesetByName = new Map();
  for (const r of sheet('Codeset')) {
    const n = str(r['Codeset']); if (!n) continue;
    if (!codesetByName.has(n)) codesetByName.set(n, { format: str(r['Format']), values: [] });
    const d = str(r['Data']); if (d) codesetByName.get(n).values.push(d);
  }

  // Types structurés (objets) : Structure → liste de { attribute, typology }.
  const structuredByName = new Map();
  for (const r of sheet('TypesStructures')) {
    const n = str(r['Structure']), a = str(r['Attributes']); if (!n || !a) continue;
    if (!structuredByName.has(n)) structuredByName.set(n, []);
    structuredByName.get(n).push({ attribute: a, typology: str(r['Typologie']) });
  }

  const simpleDef = (name) => {
    const s = simpleByName.get(name); if (!s) return null;
    return {
      type: str(s['Type']) || null,
      pattern: str(s['Pattern']) || null,
      minLength: num(s['minLength /mininclusive']),
      maxLength: num(s['maxLength']),
      fractionDigits: num(s['FractionD']),
      totalDigits: num(s['TotalD']),
    };
  };

  // Résout un NOM de type (simple | codeset | structuré | inconnu). Récursif sur les sous-champs
  // d'un type structuré ; `seen` coupe les cycles éventuels.
  const resolveTypeName = (name, seen = new Set()) => {
    const n = str(name);
    if (simpleByName.has(n)) return { kind: 'simple', ...simpleDef(n) };
    if (codesetByName.has(n)) {
      const cs = codesetByName.get(n);
      return { kind: 'codeset', ...(simpleDef(cs.format) || { type: 'string' }), enum: cs.values };
    }
    if (structuredByName.has(n)) {
      if (seen.has(n)) return { kind: 'structured', type: 'object', attributes: {} }; // garde-fou anti-cycle
      const next = new Set(seen).add(n);
      const attributes = {};
      for (const { attribute, typology } of structuredByName.get(n)) attributes[attribute] = resolveTypeName(typology, next);
      return { kind: 'structured', type: 'object', attributes };
    }
    return { kind: 'unknown', typeName: n };
  };

  return {
    version: file,
    resolveTypeName,
    // Renvoie { found, kind:'simple'|'codeset'|'structured'|'unknown', type, pattern, minLength,
    //          maxLength, fractionDigits, totalDigits, enum, attributes, object, attribute, typeName }
    resolve(id) {
      const e = byId.get(str(id));
      if (!e) return { found: false };
      const typeName = str(e['Type']);
      const meta = { object: str(e['Object']), attribute: str(e['Attribute']), typeName };
      return { found: true, ...resolveTypeName(typeName), ...meta };
    },
  };
}
