'use strict';
// api/_lib/plsync.js — import unique (relançable) des boards Monday de Planif vers Neon (tables planif_*).
// Lecture seule dans Monday. Cases de planification, jours fériés, réglages, distances routières, équipements (roulant / levage),
// absences bloquantes, historique des changements et historique des horaires envoyés. Les identifiants d'employés et de projets
// (identifiants Monday) sont conservés : ils correspondent déjà à fin_employee / fin_project.
// Idempotent : les éléments modifiés dans Exacto depuis l'import ne sont jamais écrasés.

const { q } = require('./db');
const monday = require('./monday');

const B = {
  pl_cells: ['18426416285', 50], pl_holidays: ['18426426760', 100], pl_settings: ['18431141848', 10], pl_distances: ['18426435716', 50],
  pl_rolling: ['8478346039', 100], pl_lift: ['8478280754', 100], pl_absences: ['9761392463', 100], pl_history: ['18428465325', 50], pl_sendlog: ['18426682285', 10]
};
const KINDS = [
  { key: 'pl_cells', label: 'Planif — cases de planification' }, { key: 'pl_holidays', label: 'Planif — jours fériés' },
  { key: 'pl_settings', label: 'Planif — réglages' }, { key: 'pl_distances', label: 'Planif — distances routières' },
  { key: 'pl_rolling', label: 'Planif — équipement roulant' }, { key: 'pl_lift', label: 'Planif — équipements de levage' },
  { key: 'pl_absences', label: 'Planif — absences' }, { key: 'pl_history', label: 'Planif — historique des changements' },
  { key: 'pl_sendlog', label: 'Planif — historique des horaires envoyés' }
];
const SNAP_COLS = ['long_text_mm688z1z', 'long_text_mm6j2hbv', 'long_text_mm6jg2ny', 'long_text_mm6j7qrd', 'long_text_mm6j44b9', 'long_text_mm6jdgqt', 'long_text_mm6jdafy', 'long_text_mm6j3ae',
  'long_text_mm6j1m6x', 'long_text_mm6jqn1k', 'long_text_mm6j45w4', 'long_text_mm6j63kh', 'long_text_mm6jfxaq', 'long_text_mm6jng3z', 'long_text_mm6jvt1j'];
const COLS = {
  pl_cells: ['board_relation_mm66kzga', 'date_mm66w0ga', 'board_relation_mm66fec0', 'long_text_mm7x7kfh'],
  pl_holidays: ['date_mm66qb31'],
  pl_settings: ['text_mm77rg7d', 'text_mm77fh43', 'boolean_mm77zwe2'],
  pl_distances: ['text_mm66z9bc', 'long_text_mm668qje', 'date_mm66n8s0'],
  pl_rolling: ['color_mm0vb825', 'board_relation_mm0vnz4x'],
  pl_lift: ['color_mm0cjm1n', 'board_relation_mm0cqnyv', 'marque_mkn4y57z', 'texte4__1', 'texte_mkn48v7m'],
  pl_absences: ['board_relation_mkw51g49', 'color_mkw51e15', 'timerange_mkzj1td5'],
  pl_history: ['text_mm6m9xvr', 'long_text_mm6m7c46', 'text_mm6mgxh', 'long_text_mm6msgtd'],
  pl_sendlog: ['text_mm68dngj', 'date_mm68m1zc'].concat(SNAP_COLS)
};
const EMPLOYEES_BOARD = String(process.env.EMPLOYEES_BOARD_ID || '8371777574');
const SETTINGS_ITEM = '13050085592';

async function fetchPage(kind, cursor) {
  const [board, limit] = B[kind];
  const fields = `id name created_at column_values(ids: ${JSON.stringify(COLS[kind])}) { id text value ... on BoardRelationValue { linked_items { id name board { id } } } }`;
  const rules = kind === 'pl_absences' ? ', query_params: { rules: [{ column_id: "color_mkw51e15", compare_value: [1, 2], operator: any_of }] }' : '';
  let page;
  if (!cursor) { const d = await monday.mq(`query { boards(ids: [${board}]) { items_page(limit: ${limit}${rules}) { cursor items { ${fields} } } } }`); page = d.boards && d.boards[0] && d.boards[0].items_page; }
  else { const d = await monday.mq(`query($c: String!) { next_items_page(limit: ${limit}, cursor: $c) { cursor items { ${fields} } } }`, { c: cursor }); page = d.next_items_page; }
  return { items: (page && page.items) || [], cursor: (page && page.cursor) || null };
}
const cvMap = it => { const m = {}; (it.column_values || []).forEach(c => { m[c.id] = c; }); return m; };
const txt = (m, id) => ((m[id] && m[id].text) || '').trim();
const linked = (m, id) => ((m[id] && m[id].linked_items) || []).map(l => ({ id: String(l.id), name: l.name, board: l.board ? String(l.board.id) : null }));
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const jsonOrEmpty = s => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } };

const HANDLERS = {
  async pl_cells(it) {
    const m = cvMap(it), proj = linked(m, 'board_relation_mm66kzga')[0], day = txt(m, 'date_mm66w0ga');
    if (!proj || !isDay(day)) return 'skipped';
    const emps = linked(m, 'board_relation_mm66fec0').map(x => x.id);
    const r = await q(`INSERT INTO planif_cell (monday_id, project_id, day, employee_ids, assigned_at, created_at, updated_at) VALUES ($1,$2,$3,$4::text[],$5::jsonb,$6,$6)
      ON CONFLICT (project_id, day) DO UPDATE SET monday_id = EXCLUDED.monday_id, employee_ids = EXCLUDED.employee_ids, assigned_at = EXCLUDED.assigned_at, updated_at = planif_cell.created_at
      WHERE planif_cell.monday_id IS NOT NULL AND planif_cell.updated_at <= planif_cell.created_at RETURNING (xmax = 0) AS inserted`,
      [String(it.id), proj.id, day, emps, JSON.stringify(jsonOrEmpty(txt(m, 'long_text_mm7x7kfh'))), it.created_at || new Date().toISOString()]);
    return r[0] ? (r[0].inserted ? 'created' : 'updated') : 'protected';
  },
  async pl_holidays(it) {
    const d = txt(cvMap(it), 'date_mm66qb31'); if (!isDay(d)) return 'skipped';
    const r = await q('INSERT INTO planif_holiday (day, monday_id) VALUES ($1,$2) ON CONFLICT (day) DO NOTHING RETURNING day', [d, String(it.id)]);
    return r[0] ? 'created' : 'protected';
  },
  async pl_settings(it) {
    if (String(it.id) !== SETTINGS_ITEM) return 'skipped';
    const m = cvMap(it);
    const vals = { startDefault: txt(m, 'text_mm77rg7d') || '07:00', endDefault: txt(m, 'text_mm77fh43') || '15:30', showWeekend: txt(m, 'boolean_mm77zwe2') === 'v' ? '1' : '0' };
    let n = 0;
    for (const k of Object.keys(vals)) { const r = await q('INSERT INTO planif_setting (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key', [k, vals[k]]); if (r[0]) n++; }
    return n ? 'created' : 'protected';
  },
  async pl_distances(it) {
    const m = cvMap(it), emp = txt(m, 'text_mm66z9bc'); if (!/^\d+$/.test(emp)) return 'skipped';
    const d = txt(m, 'date_mm66n8s0');
    const r = await q(`INSERT INTO planif_distance (employee_id, data, computed_on) VALUES ($1,$2::jsonb,$3) ON CONFLICT (employee_id) DO UPDATE SET data = EXCLUDED.data, computed_on = EXCLUDED.computed_on
      WHERE planif_distance.computed_on IS NULL OR planif_distance.computed_on <= EXCLUDED.computed_on RETURNING (xmax = 0) AS inserted`,
      [emp, JSON.stringify(jsonOrEmpty(txt(m, 'long_text_mm668qje'))), isDay(d) ? d : null]);
    return r[0] ? (r[0].inserted ? 'created' : 'updated') : 'protected';
  },
  async pl_rolling(it) { return equip(it, 'rolling', 'color_mm0vb825', 'board_relation_mm0vnz4x', null); },
  async pl_lift(it) { return equip(it, 'lift', 'color_mm0cjm1n', 'board_relation_mm0cqnyv', { brand: 'marque_mkn4y57z', model: 'texte4__1', year: 'texte_mkn48v7m' }); },
  async pl_absences(it) {
    const m = cvMap(it), link = linked(m, 'board_relation_mkw51g49').find(l => l.board === EMPLOYEES_BOARD);
    const parts = txt(m, 'timerange_mkzj1td5').split(' - ');
    if (!link || parts.length !== 2 || !isDay(parts[0].trim()) || !isDay(parts[1].trim())) return 'skipped';
    const r = await q('INSERT INTO planif_absence (monday_id, employee_id, start_day, end_day, note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (monday_id) DO NOTHING RETURNING id',
      [String(it.id), link.id, parts[0].trim(), parts[1].trim(), String(it.name || '').slice(0, 200)]);
    return r[0] ? 'created' : 'protected';
  },
  async pl_history(it) {
    const m = cvMap(it);
    const r = await q('INSERT INTO planif_history (monday_id, week_key, description, user_label, diff, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (monday_id) DO NOTHING RETURNING id',
      [String(it.id), txt(m, 'text_mm6m9xvr'), txt(m, 'long_text_mm6m7c46'), txt(m, 'text_mm6mgxh'), JSON.stringify(jsonOrEmpty(txt(m, 'long_text_mm6msgtd'))), it.created_at || new Date().toISOString()]);
    return r[0] ? 'created' : 'protected';
  },
  async pl_sendlog(it) {
    const m = cvMap(it), week = txt(m, 'text_mm68dngj'); if (!isDay(week)) return 'skipped';
    const combined = SNAP_COLS.map(c => (m[c] && m[c].text) || '').join('');
    let corrupted = false; try { JSON.parse(combined || '{}'); } catch (e) { corrupted = true; }
    const d = txt(m, 'date_mm68m1zc');
    const r = await q('INSERT INTO planif_send_log (week_key, payload, sent_date, corrupted) VALUES ($1,$2,$3,$4) ON CONFLICT (week_key) DO NOTHING RETURNING week_key', [week, combined, isDay(d) ? d : null, corrupted]);
    return r[0] ? 'created' : 'protected';
  }
};
async function equip(it, kind, statusCol, empCol, extra) {
  const m = cvMap(it), active = /^actif$/i.test(txt(m, statusCol));
  const emps = linked(m, empCol).map(x => x.id);
  const r = await q(`INSERT INTO planif_equipment (monday_id, kind, name, active, brand, model, year, employee_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[])
    ON CONFLICT (monday_id) DO NOTHING RETURNING id`,
    [String(it.id), kind, String(it.name || '').slice(0, 200), active, extra ? txt(m, extra.brand) : '', extra ? txt(m, extra.model) : '', extra ? txt(m, extra.year) : '', emps]);
  return r[0] ? 'created' : 'protected';
}

async function runPage(kind, cursor) {
  if (!B[kind]) throw { status: 400, message: 'Type de synchronisation inconnu.' };
  const page = await fetchPage(kind, cursor || null);
  const out = { kind, processed: 0, created: 0, updated: 0, protected: 0, skipped: [] };
  for (const it of page.items) {
    out.processed++;
    try { const r = await HANDLERS[kind](it); if (r === 'skipped') out.skipped.push({ id: it.id, name: String(it.name).slice(0, 60), reason: 'données incomplètes' }); else out[r]++; }
    catch (e) { out.skipped.push({ id: it.id, name: String(it.name).slice(0, 60), reason: String((e && e.message) || e).slice(0, 140) }); }
  }
  out.cursor = page.cursor; out.done = !page.cursor || !page.items.length;
  return out;
}
const TABLE = { pl_cells: 'planif_cell', pl_holidays: 'planif_holiday', pl_settings: 'planif_setting', pl_distances: 'planif_distance', pl_rolling: 'planif_equipment', pl_lift: 'planif_equipment',
  pl_absences: 'planif_absence', pl_history: 'planif_history', pl_sendlog: 'planif_send_log' };
async function status() {
  const out = {};
  for (const k of Object.keys(TABLE)) {
    try {
      const where = k === 'pl_rolling' ? " WHERE kind = 'rolling'" : k === 'pl_lift' ? " WHERE kind = 'lift'" : '';
      out[k] = { imported: (await q(`SELECT count(*)::int AS n FROM ${TABLE[k]}${where}`))[0].n };
    } catch (e) { out[k] = { error: 'Migration « migration-planif-neon.sql » non exécutée.' }; }
  }
  return out;
}
module.exports = { runPage, status, KINDS };
