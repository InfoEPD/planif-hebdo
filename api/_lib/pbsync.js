'use strict';
// api/_lib/pbsync.js — import unique (relançable) des boards Monday de Punch vers Neon (table pb_item).
// Lecture seule dans Monday. Toutes les colonnes de chaque board sont copiées telles quelles (texte, valeur, heures,
// liens vers employés / projets), identifiants Monday conservés. Idempotent : un élément déjà importé n'est jamais écrasé.

const { q } = require('./db');
const monday = require('./monday');

const B = {
  pb_punches: ['18427410930', 100], pb_messages: ['18427410933', 100], pb_trades: ['18427580793', 100], pb_tasks: ['18427580795', 100],
  pb_primes: ['18428290998', 100], pb_config: ['18427580797', 5], pb_km: ['18427889714', 100]
};
const KINDS = [
  { key: 'pb_punches', label: 'Punch — poinçons' }, { key: 'pb_messages', label: 'Punch — messages' }, { key: 'pb_trades', label: 'Punch — métiers' },
  { key: 'pb_tasks', label: 'Punch — tâches' }, { key: 'pb_primes', label: 'Punch — primes' }, { key: 'pb_config', label: 'Punch — configuration générale' },
  { key: 'pb_km', label: 'Punch — km entre chantiers' }
];

async function fetchPage(kind, cursor) {
  const [board, limit] = B[kind];
  const fields = `id name created_at group { id } column_values { id type text value ... on BoardRelationValue { linked_item_ids } ... on HourValue { hour minute } }`;
  let page;
  if (!cursor) { const d = await monday.mq(`query { boards(ids: [${board}]) { items_page(limit: ${limit}) { cursor items { ${fields} } } } }`); page = d.boards && d.boards[0] && d.boards[0].items_page; }
  else { const d = await monday.mq(`query($c: String!) { next_items_page(limit: ${limit}, cursor: $c) { cursor items { ${fields} } } }`, { c: cursor }); page = d.next_items_page; }
  return { items: (page && page.items) || [], cursor: (page && page.cursor) || null };
}

/** Colonne Monday → entrée stockée { text, value, ids, hour, minute } (seulement si non vide). */
function convert(c) {
  const e = {};
  const text = c.text == null ? '' : String(c.text);
  if (c.type === 'board_relation' || c.type === 'dependency') {
    const ids = (c.linked_item_ids || []).map(String);
    if (!ids.length) return null;
    return { text: '', ids };
  }
  if (c.type === 'hour') {
    if (c.hour == null) return null;
    return { text: text || (String(c.hour).padStart(2, '0') + ':' + String(c.minute || 0).padStart(2, '0')), value: JSON.stringify({ hour: c.hour, minute: c.minute || 0 }), hour: c.hour, minute: c.minute || 0 };
  }
  if (c.type === 'checkbox') return text === 'v' ? { text: 'v', value: '{"checked":"true"}' } : null;
  if (!text && !c.value) return null;
  e.text = text;
  if (c.value && ['location', 'status', 'color', 'date', 'numbers'].indexOf(c.type) >= 0) e.value = typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
  return e;
}

async function importItem(it) {
  const cv = {};
  (it.column_values || []).forEach(c => { const e = convert(c); if (e) cv[c.id] = e; });
  const r = await q(`INSERT INTO pb_item (id, board, name, grp, cv, created_at, updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
    ON CONFLICT (id) DO NOTHING RETURNING id`, [String(it.id), it.__board, String(it.name || ''), (it.group && it.group.id) || '', JSON.stringify(cv), it.created_at || new Date().toISOString()]);
  return r[0] ? 'created' : 'protected';
}

async function runPage(kind, cursor) {
  if (!B[kind]) throw { status: 400, message: 'Type de synchronisation inconnu.' };
  const page = await fetchPage(kind, cursor || null);
  const out = { kind, processed: 0, created: 0, updated: 0, protected: 0, skipped: [] };
  for (const it of page.items) {
    out.processed++; it.__board = B[kind][0];
    try { out[await importItem(it)]++; }
    catch (e) { out.skipped.push({ id: it.id, name: String(it.name).slice(0, 60), reason: String((e && e.message) || e).slice(0, 140) }); }
  }
  out.cursor = page.cursor; out.done = !page.cursor || !page.items.length;
  return out;
}
async function status() {
  const out = {};
  for (const k of Object.keys(B)) {
    try { out[k] = { imported: (await q('SELECT count(*)::int AS n FROM pb_item WHERE board = $1', [B[k][0]]))[0].n }; }
    catch (e) { out[k] = { error: 'Migration « migration-punch-neon.sql » non exécutée.' }; }
  }
  return out;
}
module.exports = { runPage, status, KINDS, convert };
