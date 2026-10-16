// api/_lib/dupes.js — détection de doublons (fournisseurs / intervenants) et références aux fournisseurs.
const { q } = require('./db');
const SUFFIX = /\b(inc|incorporee|ltee|ltd|limitee|enr|enregistree|senc|sencrl|cie|compagnie|corp|corporation|co|llc|et fils|et freres|les|la|le|l)\b/g;
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
function similar(a, b) {
  const x = norm(a), y = norm(b); if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return true;
  return false;
}
/** Retourne les entrées existantes (fournisseurs + intervenants) dont le nom ressemble à `name`. */
async function find(name, opts) {
  opts = opts || {};
  const out = [];
  const sup = await q('SELECT id, name, avantage_id, in_avantage, supplier_type FROM fin_supplier');
  for (const s of sup) {
    if (opts.excludeSupplierId && Number(s.id) === Number(opts.excludeSupplierId)) continue;
    if (similar(name, s.name)) out.push({ source: 'supplier', id: s.id, name: s.name, avantage: !!s.avantage_id, type: s.supplier_type || null });
  }
  let par = []; try { await require('./parties').ensure(); par = await q('SELECT id, name, kind FROM fin_party'); } catch (e) { par = []; }
  for (const p of par) {
    if (opts.excludePartyId && Number(p.id) === Number(opts.excludePartyId)) continue;
    if (similar(name, p.name)) out.push({ source: 'party', id: p.id, name: p.name, kind: p.kind });
  }
  return out;
}
const REFS = [['fin_invoice', 'supplier_id'], ['fin_po', 'supplier_item_id'], ['fin_da', 'supplier_item_id'], ['fin_qrt', 'supplier_item_id'], ['fin_fc_item', 'supplier_item_id']];
/** Nombre de références (par ext_id) à un fournisseur, par table. Tables absentes ignorées. */
async function refCounts(extId) {
  const res = {}; if (!extId) return res;
  for (const [t, c] of REFS) {
    try { const r = await q(`SELECT count(*)::int AS n FROM ${t} WHERE ${c} = $1`, [String(extId)]); if (r[0] && r[0].n) res[t] = r[0].n; } catch (e) { /* table/colonne absente */ }
  }
  return res;
}
async function reassign(fromExt, toExt) {
  for (const [t, c] of REFS) { try { await q(`UPDATE ${t} SET ${c} = $2 WHERE ${c} = $1`, [String(fromExt), String(toExt)]); } catch (e) {} }
}
module.exports = { norm, similar, find, refCounts, reassign };
