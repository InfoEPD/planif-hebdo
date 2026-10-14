// api/_lib/pb-store.js
//
// Exacto-Punch dans Neon : exécute, en local, les requêtes GraphQL "style Monday" que le portail Admin, l'interface mobile
// et les tâches planifiées de Punch envoient déjà — SANS jamais appeler Monday. Les données vivent dans la base Finance :
//   - Employés  → fin_employee   (colonnes Monday ↔ champs, voir EMP_COLS)
//   - Projets   → fin_project    (voir PRJ_COLS)
//   - Tout le reste du module Punch (poinçons, messages, métiers, tâches, primes, configuration, km entre chantiers)
//     → table pb_item : une ligne par "item", colonnes dans un JSON { idColonne: { text, value, ids, hour, minute } }.
// Les identifiants Monday d'origine sont conservés (aucune référence ne se perd). Nouveaux éléments : séquence dès 9 500 000 001.
//
// Sous-ensemble GraphQL pris en charge : boards{items_page}, items(ids), items_page_by_column_values, create_item,
// change_multiple_column_values, delete_item — exactement ce que le code Punch utilise.

'use strict';

// ===================================================================================================================
// 1. Analyseur GraphQL minimal
// ===================================================================================================================
function tokenize(src) {
  const out = []; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s|,/.test(c)) { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (src.startsWith('...', i)) { out.push({ t: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { out.push({ t: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') { if (src[j] === '\\') { j++; const e = src[j]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; } else s += src[j]; j++; }
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (m && /[-\d]/.test(c)) { out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (nm) { out.push({ t: 'name', v: nm[0] }); i += nm[0].length; continue; }
    throw new Error('Requête invalide près de « ' + src.slice(i, i + 20) + ' »');
  }
  return out;
}
function parseDocument(src) {
  const tk = tokenize(src); let p = 0;
  const peek = () => tk[p]; const next = () => tk[p++];
  const expect = t => { const x = next(); if (!x || x.t !== t) throw new Error('Requête invalide : « ' + t + ' » attendu'); return x; };
  function value() {
    const x = next();
    if (!x) throw new Error('Requête invalide (fin inattendue)');
    if (x.t === '$') return { k: 'var', name: expect('name').v };
    if (x.t === 'str' || x.t === 'num') return { k: 'lit', v: x.v };
    if (x.t === 'name') return { k: 'lit', v: x.v === 'true' ? true : x.v === 'false' ? false : x.v === 'null' ? null : x.v };
    if (x.t === '[') { const items = []; while (peek() && peek().t !== ']') items.push(value()); expect(']'); return { k: 'list', items }; }
    if (x.t === '{') { const o = {}; while (peek() && peek().t !== '}') { const key = expect('name').v; expect(':'); o[key] = value(); } expect('}'); return { k: 'obj', o }; }
    throw new Error('Requête invalide (valeur)');
  }
  function args() {
    const a = {};
    if (peek() && peek().t === '(') { next(); while (peek() && peek().t !== ')') { const key = expect('name').v; expect(':'); a[key] = value(); } expect(')'); }
    return a;
  }
  function selectionSet() {
    expect('{'); const fields = [];
    while (peek() && peek().t !== '}') {
      if (peek().t === '...') {
        next(); if (peek() && peek().t === 'name' && peek().v === 'on') { next(); next(); }
        const inner = selectionSet(); inner.forEach(f => fields.push(f)); continue;
      }
      let name = expect('name').v, alias = null;
      if (peek() && peek().t === ':') { next(); alias = name; name = expect('name').v; }
      const a = args();
      while (peek() && peek().t === '@') { next(); expect('name'); args(); }
      const sel = peek() && peek().t === '{' ? selectionSet() : null;
      fields.push({ alias: alias || name, name, args: a, sel });
    }
    expect('}'); return fields;
  }
  let kind = 'query';
  if (peek() && peek().t === 'name') {
    kind = next().v;
    if (peek() && peek().t === 'name') next();
    if (peek() && peek().t === '(') { let depth = 0; do { const x = next(); if (x.t === '(') depth++; else if (x.t === ')') depth--; } while (depth > 0); }
  }
  return { kind, fields: selectionSet() };
}
function evalValue(node, vars) {
  switch (node.k) {
    case 'var': return vars ? vars[node.name] : undefined;
    case 'lit': return node.v;
    case 'list': return node.items.map(x => evalValue(x, vars));
    case 'obj': { const o = {}; Object.keys(node.o).forEach(k => { o[k] = evalValue(node.o[k], vars); }); return o; }
    default: return undefined;
  }
}
const evalArgs = (a, vars) => { const o = {}; Object.keys(a).forEach(k => { o[k] = evalValue(a[k], vars); }); return o; };

// ===================================================================================================================
// 2. Cartes de colonnes (employés / projets) et formats de valeurs
// ===================================================================================================================
const EMP_BOARD = '8371777574', PRJ_BOARD = '8371776057';
const EMP_COLS = {
  t_l_phone_mkmx24h2: { f: 'phone', t: 'text' },
  statut__1: { f: 'status', t: 'status', idx: { 0: 'Terminé', 1: 'Actif', 2: 'Inactif' } },
  color_mkpfwcat: { f: 'company', t: 'status', idx: { 1: 'EPD' } },
  text_mkp7mh5p: { f: 'avantage_code', t: 'text' },
  statut_mkmx1x42: { f: 'job_title', t: 'status' },
  lieu_mkmxm4z: { f: 'address', t: 'location' },
  boolean_mm6hfkq2: { f: 'exclude_payroll', t: 'bool' },
  boolean_mm73h61q: { f: 'approver', t: 'bool' },
  board_relation_mm6khzqn: { f: 'prime_id', t: 'rel1' },
  text_mm6dqed0: { f: 'clerk_user_id', t: 'text' },
  boolean_mm6dd03t: { f: 'punch_access', t: 'bool' },
  statut_mkmxsdjs: { f: 'department', t: 'status', idx: { 0: 'Chantier', 1: 'Bureau' } },
  date_mm0fqp9c: { f: 'end_date', t: 'date' },
  email_mkptcywy: { f: 'email_pro', t: 'text' },
  e_mail_mkmxrm05: { f: 'email_personal', t: 'text' }
};
const PRJ_COLS = {
  status3: { f: 'status', t: 'status', idx: { 0: 'Projet en cours', 1: 'Projet terminé', 3: 'Attente de libération', 4: 'En planification (Tâches administratives)' } },
  boolean_mm6eweyh: { f: 'non_ccq_only', t: 'bool' },
  text_mkpcek2c: { f: 'number_avantage', t: 'text' },
  lieu__1: { f: 'address', t: 'location' },
  numeric_mm6h7r56: { f: 'punch_radius_m', t: 'num' },
  text: { f: 'number', t: 'text' }
};
const EMP_FIELDS = 'id, name, status, company, avantage_code, job_title, department, phone, address, lat, lng, exclude_payroll, approver, prime_id, clerk_user_id, punch_access, email_pro, email_personal, to_char(end_date,\'YYYY-MM-DD\') AS end_date, created_at, updated_at';
const PRJ_FIELDS = 'id, name, number, status, number_avantage, address, lat, lng, punch_radius_m, non_ccq_only, created_at, updated_at';

const emptyCv = id => ({ id, text: '', value: null, linked_item_ids: [], linked_items: [], hour: null, minute: null });
const two = n => String(n).padStart(2, '0');

/** Valeur d'une colonne virtuelle (fin_employee / fin_project) au format "colonne Monday". */
function virtualCell(row, colId, def) {
  const cv = emptyCv(colId); const v = row[def.f];
  switch (def.t) {
    case 'bool': cv.text = v ? 'v' : ''; cv.value = v ? '{"checked":"true"}' : null; break;
    case 'num': cv.text = v == null ? '' : String(Number(v)); cv.value = v == null ? null : JSON.stringify(String(Number(v))); break;
    case 'location': {
      cv.text = row.address || '';
      if (row.lat != null && row.lng != null) cv.value = JSON.stringify({ lat: String(Number(row.lat)), lng: String(Number(row.lng)), address: row.address || '' });
      break;
    }
    case 'rel1': cv.linked_item_ids = v ? [String(v)] : []; break;
    case 'date': cv.text = v || ''; cv.value = v ? JSON.stringify({ date: v }) : null; break;
    default: cv.text = v == null ? '' : String(v); cv.value = cv.text ? JSON.stringify(cv.text) : null;
  }
  return cv;
}
/** Convertit une valeur d'écriture Monday en { champ: valeur SQL } pour un board virtuel. */
function virtualWrite(def, val) {
  const out = {};
  const labelOf = x => {
    if (x && typeof x === 'object') { if (x.label != null) return String(x.label); if (x.index != null) return (def.idx && def.idx[x.index]) || ''; }
    return x == null ? '' : String(x);
  };
  switch (def.t) {
    case 'bool': out[def.f] = !!(val && typeof val === 'object' ? val.checked === 'true' || val.checked === true : val === true || val === 'true'); break;
    case 'num': { const n = parseFloat(String(val && typeof val === 'object' ? val.text : val).replace(',', '.')); out[def.f] = isFinite(n) ? Math.round(n) : null; break; }
    case 'location': {
      if (val && typeof val === 'object') {
        const lat = parseFloat(val.lat), lng = parseFloat(val.lng);
        out.address = val.address != null ? String(val.address) : ''; out.lat = isFinite(lat) ? lat : null; out.lng = isFinite(lng) ? lng : null;
      } else { out.address = String(val || ''); }
      break;
    }
    case 'rel1': { const ids = val && typeof val === 'object' ? (val.item_ids || val.ids || []) : []; out[def.f] = ids.length ? String(ids[0]) : null; break; }
    case 'date': { const d = val && typeof val === 'object' ? val.date : val; out[def.f] = /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null; break; }
    case 'status': out[def.f] = labelOf(val); break;
    default: out[def.f] = val && typeof val === 'object' ? String(val.text != null ? val.text : '') : (val == null ? '' : String(val));
  }
  return out;
}
/** Convertit une valeur d'écriture Monday en entrée stockée de pb_item. */
function toEntry(val) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    if ('checked' in val) { const on = val.checked === 'true' || val.checked === true; return { text: on ? 'v' : '', value: on ? '{"checked":"true"}' : null }; }
    if ('hour' in val && 'minute' in val) { const h = Number(val.hour), m = Number(val.minute); return { text: two(h) + ':' + two(m), value: JSON.stringify({ hour: h, minute: m }), hour: h, minute: m }; }
    if ('item_ids' in val || 'ids' in val) return { text: '', ids: (val.item_ids || val.ids || []).map(String) };
    if ('date' in val) return { text: String(val.date || ''), value: JSON.stringify({ date: val.date || null }) };
    if ('label' in val) return { text: String(val.label || ''), value: JSON.stringify({ label: val.label }) };
    if ('index' in val) return { text: String(val.index), value: JSON.stringify({ index: val.index }) };
    if ('lat' in val) return { text: String(val.address || ''), value: JSON.stringify(val) };
    if ('text' in val) return { text: String(val.text == null ? '' : val.text) };
    return { text: JSON.stringify(val) };
  }
  if (val == null) return { text: '' };
  return { text: String(val) };
}
/** Entrée stockée → colonne au format Monday. */
function entryToCv(id, e) {
  const cv = emptyCv(id);
  if (!e) return cv;
  cv.text = e.text == null ? '' : String(e.text);
  cv.value = e.value || null;
  if (e.hour != null) { cv.hour = e.hour; cv.minute = e.minute; }
  if (e.ids) cv.linked_item_ids = e.ids.map(String);
  return cv;
}

// ===================================================================================================================
// 3. Accès aux données (SQL ; remplaçable en test)
// ===================================================================================================================
const SQL_REPO = () => {
  const { q } = require('./planif-db');
  const rowItem = r => ({ id: String(r.id), board: String(r.board), name: r.name || '', grp: r.grp || '', created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || ''), updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || ''), cv: typeof r.cv === 'string' ? JSON.parse(r.cv) : (r.cv || {}) });
  return {
    async listBoard(board, hint) {
      const params = [String(board)]; let where = 'board = $1';
      (hint && hint.textIn || []).forEach(h => { params.push(h.col, h.vals.map(String)); where += ` AND cv->$${params.length - 1}::text->>'text' = ANY($${params.length}::text[])`; });
      (hint && hint.relHas || []).forEach(h => { params.push(h.col, h.ids.map(String)); where += ` AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(cv->$${params.length - 1}::text->'ids','[]'::jsonb)) x(v) WHERE x.v = ANY($${params.length}::text[]))`; });
      return (await q(`SELECT id, board, name, grp, created_at, updated_at, cv FROM pb_item WHERE ${where} ORDER BY created_at, id`, params)).map(rowItem);
    },
    async byIds(ids) { if (!ids.length) return []; return (await q('SELECT id, board, name, grp, created_at, updated_at, cv FROM pb_item WHERE id = ANY($1::text[])', [ids.map(String)])).map(rowItem); },
    async insert(board, name, cv, grp) {
      const r = await q("INSERT INTO pb_item (id, board, name, grp, cv) VALUES (nextval('pb_item_id_seq')::text, $1, $2, $3, $4::jsonb) RETURNING id", [String(board), name, grp || '', JSON.stringify(cv)]);
      return String(r[0].id);
    },
    async patch(id, cvPatch, name) {
      const r = await q('UPDATE pb_item SET cv = cv || $2::jsonb, name = COALESCE($3, name), updated_at = now() WHERE id = $1 RETURNING id', [String(id), JSON.stringify(cvPatch), name == null ? null : name]);
      return !!r[0];
    },
    async remove(id) { const r = await q('DELETE FROM pb_item WHERE id = $1 RETURNING id', [String(id)]); return !!r[0]; },
    async employees(ids) { const r = await q(`SELECT ${EMP_FIELDS} FROM fin_employee` + (ids ? ' WHERE id = ANY($1::text[])' : ''), ids ? [ids.map(String)] : []); return r; },
    async projects(ids) { const r = await q(`SELECT ${PRJ_FIELDS} FROM fin_project` + (ids ? ' WHERE id = ANY($1::text[])' : ''), ids ? [ids.map(String)] : []); return r; },
    async updateVirtual(table, id, fields) {
      const keys = Object.keys(fields); if (!keys.length) return true;
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const r = await q(`UPDATE ${table} SET ${sets}, updated_at = now() WHERE id = $1 RETURNING id`, [String(id)].concat(keys.map(k => fields[k])));
      return !!r[0];
    },
    async names(ids) {
      const m = new Map(); if (!ids.length) return m;
      const a = [ids.map(String)];
      (await q('SELECT id, name FROM fin_employee WHERE id = ANY($1::text[])', a)).forEach(r => m.set(String(r.id), r.name));
      (await q('SELECT id, name FROM fin_project WHERE id = ANY($1::text[])', a)).forEach(r => { if (!m.has(String(r.id))) m.set(String(r.id), r.name); });
      (await q('SELECT id, name FROM pb_item WHERE id = ANY($1::text[])', a)).forEach(r => { if (!m.has(String(r.id))) m.set(String(r.id), r.name); });
      return m;
    }
  };
};
let _repo = null;
const repo = () => _repo || (_repo = SQL_REPO());
function setRepo(r) { _repo = r; }

// ===================================================================================================================
// 4. Construction des items
// ===================================================================================================================
function isoOrNow(v) { return v || new Date().toISOString(); }
function pbItemToObj(it) { return { kind: 'pb', id: it.id, name: it.name, board: it.board, grp: it.grp, created_at: isoOrNow(it.created_at), updated_at: it.updated_at, cell: id => entryToCv(id, it.cv[id]), colIds: () => Object.keys(it.cv), raw: it }; }
function empToObj(r) { return { kind: 'emp', id: String(r.id), name: r.name, board: EMP_BOARD, grp: '', created_at: isoOrNow(r.created_at), updated_at: r.updated_at, cell: id => (EMP_COLS[id] ? virtualCell(r, id, EMP_COLS[id]) : emptyCv(id)), colIds: () => Object.keys(EMP_COLS), raw: r }; }
function prjObj(r) { return { kind: 'prj', id: String(r.id), name: r.name, board: PRJ_BOARD, grp: '', created_at: isoOrNow(r.created_at), updated_at: r.updated_at, cell: id => (PRJ_COLS[id] ? virtualCell(r, id, PRJ_COLS[id]) : emptyCv(id)), colIds: () => Object.keys(PRJ_COLS), raw: r }; }

async function boardItems(board, hint) {
  const b = String(board);
  if (b === EMP_BOARD) return (await repo().employees()).map(empToObj);
  if (b === PRJ_BOARD) return (await repo().projects()).map(prjObj);
  return (await repo().listBoard(b, hint)).map(pbItemToObj);
}
async function itemsByIds(ids) {
  const out = [], seen = new Set(); ids = (ids || []).map(String).filter(x => /^\d+$/.test(x));
  if (!ids.length) return out;
  (await repo().byIds(ids)).forEach(it => { out.push(pbItemToObj(it)); seen.add('pb' + it.id); });
  (await repo().employees(ids)).forEach(r => out.push(empToObj(r)));
  (await repo().projects(ids)).forEach(r => out.push(prjObj(r)));
  return out;
}

/** Rendu final d'un item (avec résolution des noms de relations). */
async function render(objs, fieldSel, vars) {
  // 1) colonnes demandées par item
  const colSel = (fieldSel || []).find(f => f.name === 'column_values');
  const csArgs = colSel ? evalArgs(colSel.args || {}, vars || {}) : {};
  const wantIds = Array.isArray(csArgs.ids) ? csArgs.ids : null;
  const built = objs.map(o => {
    if (!colSel) return { o, cvs: [] };
    const ids = wantIds ? wantIds.map(String) : o.colIds();
    return { o, cvs: ids.map(id => o.cell(id)) };
  });
  const relIds = new Set(); built.forEach(b => b.cvs.forEach(cv => cv.linked_item_ids.forEach(i => relIds.add(i))));
  const names = relIds.size ? await repo().names(Array.from(relIds)) : new Map();
  return built.map(({ o, cvs }) => {
    cvs.forEach(cv => {
      cv.linked_items = cv.linked_item_ids.map(i => ({ id: i, name: names.get(i) || '' }));
      if (cv.linked_item_ids.length && !cv.text) cv.text = cv.linked_items.map(x => x.name).join(', ');
    });
    const item = { id: o.id, name: o.name, created_at: o.created_at, updated_at: o.updated_at || o.created_at, board: { id: o.board }, group: { id: o.grp || 'topics', title: o.grp || '' } };
    if (colSel) { item[colSel.alias] = cvs; item.column_values = cvs; }
    return item;
  });
}

// ===================================================================================================================
// 5. Filtres (rules, columns)
// ===================================================================================================================
function labelsFor(board, colId, vals) {
  const def = String(board) === EMP_BOARD ? EMP_COLS[colId] : String(board) === PRJ_BOARD ? PRJ_COLS[colId] : null;
  return (vals || []).map(v => (typeof v === 'number' && def && def.idx && def.idx[v] != null ? def.idx[v] : String(v)));
}
function matchRule(board, obj, rule) {
  const cv = obj.cell(rule.column_id); const op = rule.operator || 'any_of';
  const vals = Array.isArray(rule.compare_value) ? rule.compare_value : [rule.compare_value];
  const text = String(cv.text || '').toLowerCase();
  if (op === 'contains_text') return vals.some(v => text.includes(String(v).toLowerCase()));
  if (op === 'is_empty') return !cv.text && !cv.linked_item_ids.length;
  if (op === 'is_not_empty') return !!cv.text || cv.linked_item_ids.length > 0;
  const labels = labelsFor(board, rule.column_id, vals).map(x => String(x).toLowerCase());
  const hit = labels.includes(text) || (cv.linked_item_ids.length && cv.linked_item_ids.some(i => labels.includes(String(i).toLowerCase())))
    || (vals.some(v => typeof v === 'number') && labels.includes(text));
  return op === 'not_any_of' ? !hit : hit;
}
async function itemsPage(board, args) {
  const qp = (args && args.query_params) || {};
  const rules = Array.isArray(qp.rules) ? qp.rules : [];
  const hint = { textIn: [], relHas: [] };
  // pré-filtre SQL pour les égalités simples sur colonnes texte / relation (poinçons, messages)
  rules.forEach(r => {
    if ((r.operator || 'any_of') !== 'any_of') return;
    const vals = Array.isArray(r.compare_value) ? r.compare_value : [r.compare_value];
    if (/^board_relation/.test(r.column_id)) hint.relHas.push({ col: r.column_id, ids: vals });
    else if (vals.every(v => typeof v === 'string') && /^(date|text)_/.test(r.column_id)) hint.textIn.push({ col: r.column_id, vals });
  });
  let items = await boardItems(board, hint);
  items = items.filter(o => rules.every(r => matchRule(board, o, r)));
  const ob = Array.isArray(qp.order_by) ? qp.order_by[0] : null;
  if (ob && ob.column_id) {
    const dir = ob.direction === 'desc' ? -1 : 1;
    items.sort((a, b) => { const x = a.cell(ob.column_id).text || '', y = b.cell(ob.column_id).text || ''; const nx = Number(x), ny = Number(y); return dir * ((x !== '' && y !== '' && isFinite(nx) && isFinite(ny)) ? nx - ny : String(x).localeCompare(String(y))); });
  }
  return items;
}
async function itemsByColumnValues(board, args) {
  const cols = Array.isArray(args.columns) ? args.columns : [];
  const hint = { textIn: [], relHas: [] };
  cols.forEach(c => {
    const vals = (c.column_values || []).map(String);
    if (/^board_relation/.test(c.column_id)) hint.relHas.push({ col: c.column_id, ids: vals });
    else if (/^(date|text)_/.test(c.column_id)) hint.textIn.push({ col: c.column_id, vals });
  });
  let items = await boardItems(board, hint);
  return items.filter(o => cols.every(c => {
    const vals = (c.column_values || []).map(x => String(x).toLowerCase());
    const cv = o.cell(c.column_id);
    return vals.includes(String(cv.text || '').toLowerCase()) || cv.linked_item_ids.some(i => vals.includes(String(i).toLowerCase()));
  }));
}

// ===================================================================================================================
// 6. Mutations
// ===================================================================================================================
function parseCv(x) { if (typeof x === 'string') { try { return JSON.parse(x) || {}; } catch (e) { throw new Error('column_values invalide.'); } } return x || {}; }
async function createItem(args) {
  const board = String(args.board_id), cv = parseCv(args.column_values);
  if (board === EMP_BOARD || board === PRJ_BOARD) throw new Error('La création d\'employés / projets se fait dans Finance.');
  const stored = {}; Object.keys(cv).forEach(k => { stored[k] = toEntry(cv[k]); });
  const id = await repo().insert(board, String(args.item_name || '').slice(0, 500), stored, '');
  return { id };
}
async function changeColumns(args) {
  const board = String(args.board_id), id = String(args.item_id), cv = parseCv(args.column_values);
  if (board === EMP_BOARD || board === PRJ_BOARD) {
    const cols = board === EMP_BOARD ? EMP_COLS : PRJ_COLS; const fields = {};
    Object.keys(cv).forEach(k => { if (cols[k]) Object.assign(fields, virtualWrite(cols[k], cv[k])); });
    const ok = await repo().updateVirtual(board === EMP_BOARD ? 'fin_employee' : 'fin_project', id, fields);
    if (!ok) throw new Error('Élément introuvable.');
    return { id };
  }
  const patch = {}; Object.keys(cv).forEach(k => { patch[k] = toEntry(cv[k]); });
  const ok = await repo().patch(id, patch, null);
  if (!ok) throw new Error('Élément introuvable.');
  return { id };
}
async function deleteItem(args) {
  const ok = await repo().remove(String(args.item_id));
  if (!ok) throw new Error('Élément introuvable.');
  return { id: String(args.item_id) };
}

// ===================================================================================================================
// 7. Exécution
// ===================================================================================================================
async function execute(query, variables) {
  const doc = parseDocument(String(query || ''));
  const data = {};
  for (const f of doc.fields) {
    const a = evalArgs(f.args, variables || {});
    if (f.name === 'boards') {
      const boards = [];
      for (const bid of (a.ids || [])) {
        const bobj = {};
        for (const sf of (f.sel || [])) {
          if (sf.name === 'id') bobj[sf.alias] = String(bid);
          else if (sf.name === 'items_page') {
            const sa = evalArgs(sf.args, variables || {});
            const items = await itemsPage(bid, sa);
            const itemsSel = (sf.sel || []).find(x => x.name === 'items');
            bobj[sf.alias] = { cursor: null, items: await render(items, itemsSel ? itemsSel.sel : [], variables) };
          }
        }
        boards.push(bobj);
      }
      data[f.alias] = boards;
    } else if (f.name === 'items') {
      const objs = await itemsByIds((a.ids || []).map(String));
      data[f.alias] = await render(objs, f.sel, variables);
    } else if (f.name === 'items_page_by_column_values') {
      const items = await itemsByColumnValues(a.board_id, a);
      const itemsSel = (f.sel || []).find(x => x.name === 'items');
      data[f.alias] = { cursor: null, items: await render(items, itemsSel ? itemsSel.sel : [], variables) };
    } else if (f.name === 'create_item') data[f.alias] = await createItem(a);
    else if (f.name === 'change_multiple_column_values') data[f.alias] = await changeColumns(a);
    else if (f.name === 'delete_item') data[f.alias] = await deleteItem(a);
    else throw new Error('Opération non prise en charge : ' + f.name);
  }
  return data;
}

// Remplace fetch('https://api.monday.com/v2', {body}) : exécute localement sur Neon, même forme de réponse.
async function pbFetch(url, opts) {
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
  let payload;
  try { payload = { data: await execute(body.query, body.variables || {}) }; }
  catch (e) { payload = { errors: [{ message: e.message || String(e) }] }; }
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

module.exports = { pbFetch, execute, setRepo, parseDocument, toEntry, entryToCv, virtualWrite, virtualCell, EMP_COLS, PRJ_COLS, EMP_BOARD, PRJ_BOARD };
