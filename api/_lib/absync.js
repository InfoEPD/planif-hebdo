'use strict';
// api/_lib/absync.js — import unique (relançable) du board Monday « 🪂Absences » (9761392463) vers la table absence_request (Neon).
// Lecture seule dans Monday. Statuts : À traiter → en attente ; Acceptée / Traitée → approuvée ; Refusée → refusée.
// Les absences importées ne touchent pas Planif (déjà importées par « Planif — absences »). Idempotent : un élément déjà importé n'est jamais écrasé.

const { q } = require('./db');
const monday = require('./monday');

const BOARD = '9761392463', LIMIT = 100;
const COLS = ['board_relation_mkw51g49', 'color_mkw51e15', 'timerange_mkzj1td5', 'numeric_mkzj9ez5', 'dropdown_mkvtse95', 'text_mktjn603', 'multiple_person_mkzrbz2c', 'date_mkzjvek6', 'numeric_mky4tb3k'];
const KINDS = [{ key: 'ab_absences', label: 'Absences — demandes d\'absence (board Monday)' }];
const TYPE_BY_LABEL = {
  'accident de travail - cnesst': 'cnesst', 'absence non-justifiée (no show)': 'noshow', 'absence planifiée et autorisée': 'planifiee',
  'congé personnel (mobile - équipe de bureau seulement)': 'personnel', 'congé parental': 'parental', 'congé sans solde': 'sanssolde', 'maladie': 'maladie',
  'maladie enfant / responsabilité familiale': 'maladie_enfant', 'rdv médical / familial / personnel': 'rdv', 'retard / départ anticipé': 'retard', 'vacances autorisées': 'vacances'
};
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

let ready = null;
function ensureTable() {
  if (!ready) ready = q(`CREATE TABLE IF NOT EXISTS absence_request (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL, employee_name TEXT, start_day DATE NOT NULL, end_day DATE NOT NULL,
    days NUMERIC(6,2) NOT NULL DEFAULT 0, hours NUMERIC(5,2), type TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'pending',
    token TEXT UNIQUE, source TEXT NOT NULL DEFAULT 'employee', decided_by TEXT, decision_comment TEXT, decided_at TIMESTAMPTZ,
    planif_absence_id BIGINT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => q('ALTER TABLE absence_request ADD COLUMN IF NOT EXISTS monday_id TEXT'))
    .then(() => q('CREATE UNIQUE INDEX IF NOT EXISTS absence_request_monday_idx ON absence_request (monday_id)'))
    .then(() => q('CREATE INDEX IF NOT EXISTS absence_request_emp_idx ON absence_request (employee_id, start_day)')).catch(e => { ready = null; throw e; });
  return ready;
}

async function fetchPage(cursor) {
  const fields = `id name created_at column_values(ids: ${JSON.stringify(COLS)}) { id text value ... on BoardRelationValue { linked_items { id name board { id } } } }`;
  let page;
  if (!cursor) { const d = await monday.mq(`query { boards(ids: [${BOARD}]) { items_page(limit: ${LIMIT}) { cursor items { ${fields} } } } }`); page = d.boards && d.boards[0] && d.boards[0].items_page; }
  else { const d = await monday.mq(`query($c: String!) { next_items_page(limit: ${LIMIT}, cursor: $c) { cursor items { ${fields} } } }`, { c: cursor }); page = d.next_items_page; }
  return { items: (page && page.items) || [], cursor: (page && page.cursor) || null };
}

let empCache = null;
async function employees() {
  if (!empCache) empCache = (await q('SELECT id, monday_id, name FROM fin_employee')).map(r => ({ id: String(r.id), mid: r.monday_id ? String(r.monday_id) : null, name: r.name }));
  return empCache;
}
async function findEmployee(it, m) {
  const list = await employees();
  const links = ((m.board_relation_mkw51g49 && m.board_relation_mkw51g49.linked_items) || []);
  for (const l of links) { const e = list.find(x => x.id === String(l.id) || x.mid === String(l.id)); if (e) return e; }
  const names = [it.name].concat(links.map(l => l.name)).map(norm).filter(Boolean);
  for (const n of names) { const hits = list.filter(x => norm(x.name) === n); if (hits.length === 1) return hits[0]; }
  return null;
}

async function importItem(it) {
  const m = {}; (it.column_values || []).forEach(c => { m[c.id] = c; });
  const txt = id => ((m[id] && m[id].text) || '').trim();
  const typeKey = TYPE_BY_LABEL[txt('dropdown_mkvtse95').toLowerCase()];
  if (!typeKey) return 'skipped:type inconnu (« ' + txt('dropdown_mkvtse95') + ' »)';
  const parts = txt('timerange_mkzj1td5').split(' - ').map(s => s.trim());
  if (parts.length !== 2 || !isDay(parts[0]) || !isDay(parts[1]) || parts[1] < parts[0]) return 'skipped:période invalide';
  const emp = await findEmployee(it, m);
  if (!emp) return 'skipped:employé introuvable dans Finance (« ' + it.name + ' »)';
  const st = txt('color_mkw51e15');
  const status = /^refus/i.test(st) ? 'refused' : /^(accept|trait)/i.test(st) ? 'approved' : 'pending';
  const hours = parseFloat(txt('numeric_mky4tb3k').replace(',', '.')); const h = hours > 0 ? hours : null;
  const daysRaw = parseFloat(txt('numeric_mkzj9ez5').replace(',', '.')); const days = h ? 0 : (daysRaw > 0 ? daysRaw : 0);
  const dApp = txt('date_mkzjvek6');
  const r = await q(`INSERT INTO absence_request (monday_id, employee_id, employee_name, start_day, end_day, days, hours, type, details, status, source, decided_by, decided_at, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'monday',$11,$12,$13) ON CONFLICT (monday_id) DO NOTHING RETURNING id`,
    [String(it.id), emp.id, emp.name, parts[0], parts[1], days, h, typeKey, txt('text_mktjn603').slice(0, 1000), status, status === 'pending' ? null : (txt('multiple_person_mkzrbz2c') || 'Monday'),
      status === 'pending' ? null : (isDay(dApp) ? dApp : null), it.created_at || new Date().toISOString()]);
  return r[0] ? 'created' : 'protected';
}

async function runPage(kind, cursor) {
  if (kind !== 'ab_absences') throw { status: 400, message: 'Type de synchronisation inconnu.' };
  await ensureTable(); empCache = null;
  const page = await fetchPage(cursor || null);
  const out = { kind, processed: 0, created: 0, updated: 0, protected: 0, skipped: [] };
  for (const it of page.items) {
    out.processed++;
    try { const r = await importItem(it); if (r.startsWith('skipped:')) out.skipped.push({ id: it.id, name: String(it.name).slice(0, 60), reason: r.slice(8) }); else out[r]++; }
    catch (e) { out.skipped.push({ id: it.id, name: String(it.name).slice(0, 60), reason: String((e && e.message) || e).slice(0, 140) }); }
  }
  out.cursor = page.cursor; out.done = !page.cursor || !page.items.length;
  return out;
}
async function status() {
  try { await ensureTable(); return { ab_absences: { imported: (await q("SELECT count(*)::int AS n FROM absence_request WHERE source = 'monday'"))[0].n } }; }
  catch (e) { return { ab_absences: { error: e.message } }; }
}
module.exports = { runPage, status, KINDS };
