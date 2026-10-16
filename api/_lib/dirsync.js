'use strict';
// api/_lib/dirsync.js — import unique (relançable) des boards Monday « Employés » et « Macro | PROJETS » vers Neon (fin_employee, fin_project).
// Lecture seule dans Monday. Les colonnes sont repérées par leur TITRE (insensible aux accents, émojis et à la casse).
// Les identifiants Monday sont conservés comme identifiants Exacto (aucune référence ne se perd). Les éléments déjà modifiés dans Exacto sont « protégés ».
// Travail par pages de 25 éléments (limite Vercel 60 s) : l'interface boucle tant que `done` est faux.

const { q } = require('./db');
const monday = require('./monday');
const dir = require('./dir');

const BOARD = { employee: process.env.EMPLOYEES_BOARD_ID || '8371777574', project: process.env.PROJECTS_BOARD_ID || '8371776057' };
const PAGE = 25;
const MONDAY_URL = (process.env.MONDAY_ACCOUNT_URL || 'https://entreprisesphilippedenis.monday.com').replace(/\/$/, '');

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}#%$ ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const colCache = {};
async function columns(kind) {
  if (colCache[kind]) return colCache[kind];
  const d = await monday.mq(`query { boards(ids: [${BOARD[kind]}]) { columns { id title type } } }`);
  const cols = (d.boards && d.boards[0] && d.boards[0].columns) || [];
  const byTitle = new Map();
  cols.forEach(c => { const k = norm(c.title); if (!byTitle.has(k)) byTitle.set(k, c); });
  colCache[kind] = { cols, byTitle };
  return colCache[kind];
}

const EMP_MAP = {   // champ -> titre de colonne
  status: 'Statut employés', company: 'Entreprise', avantage_code: 'Code avantage', hire_date: "Date d'embauche", end_date: "Date de fin d'emploi", job_title: "Titre d'emploi", department: 'Département',
  email_pro: 'Courriel professionnel', email_personal: 'Courriel personnel', address: 'Adresse complète', phone: '# Téléphone', emergency_name: "Contact en cas d'urgence",
  emergency_phone: "# Téléphone en cas d'urgence", notes: 'Notes', punch_access: 'Accès poinçon mobile activé', exclude_payroll: "Exclure de l'export paie", approver: 'Approbateur',
  prime_id: 'Prime', clerk_user_id: 'Clerk User ID (poinçon)',
  sk_charpente: 'Charpente', sk_syst_interieur: 'Syst. Intérieur', sk_quincaillerie: 'Quincaillerie', sk_revet_ext: 'Revêt. Ext.', sk_coffrage_beton: 'Coffrage - Béton'
};
const PRJ_MAP = {
  number: '# Projet', number_avantage: '# Projet Avantage', status: 'Étape du projet', client: 'Client', client_email: 'Courriel client', client_phone: 'Téléphone Client',
  owner_name: 'Nom complet du propriétaire', owner_address: 'Adresse du propriétaire', owner_cadastre: 'Numéro de cadastre du terrain', owner_email: 'Adresse courriel du propriétaire',
  address: 'Adresse du projet', billing_type: 'Type de Facturation', cost_plus_pct: '% Cost +', cost_plus_rate: 'Taux Horaire Facturation Cost +', billing_frequency: 'Fréquence Facturation',
  next_billing: 'Prochaine Facturation', max_po: 'Max # PO', insurance_pct: 'Taux Assurance supplémentaire', bond_pct: 'Taux cautionnement supplémentaire',
  responsible: 'Responsable', cp: 'Chargé de projet', cm: 'Contremaître', coordo: 'Coordonnateur', link: 'Lien Wetransfer plans',
  labor_required: "Main-d'œuvre requise", planif_comment: 'Commentaire planification', labor_week: "Main-d'œuvre requise par semaine (JSON)", carpenters_required: 'Nombre menuisier requis',
  carpenters_week: 'Nombre menuisier requis par semaine (JSON)', non_ccq_only: 'Hors CCQ seulement', punch_radius_m: 'Rayon toléré poinçon (m)', planif_start: 'Heure début (planif)',
  planif_end: 'Heure fin (planif)', lift: 'Équipements de levage', rolling: 'Équipement roulant'
};

const FRAG = `... on BoardRelationValue { linked_item_ids } ... on CheckboxValue { checked }`;
async function fetchPage(kind, cursor) {
  const { byTitle } = await columns(kind);
  const map = kind === 'employee' ? EMP_MAP : PRJ_MAP;
  const ids = []; Object.values(map).forEach(t => { const c = byTitle.get(norm(t)); if (c && !ids.includes(c.id)) ids.push(c.id); });
  const fields = `id name url created_at group { title } column_values(ids: ${JSON.stringify(ids)}) { id type text value ${FRAG} }`;
  let page;
  if (!cursor) { const d = await monday.mq(`query { boards(ids: [${BOARD[kind]}]) { items_page(limit: ${PAGE}) { cursor items { ${fields} } } } }`); page = d.boards && d.boards[0] && d.boards[0].items_page; }
  else { const d = await monday.mq(`query($c: String!) { next_items_page(limit: ${PAGE}, cursor: $c) { cursor items { ${fields} } } }`, { c: cursor }); page = d.next_items_page; }
  return { items: (page && page.items) || [], cursor: (page && page.cursor) || null, byTitle };
}
function getter(item, byTitle) {
  const cv = new Map(); (item.column_values || []).forEach(c => cv.set(c.id, c));
  const raw = title => { const c = byTitle.get(norm(title)); return c ? cv.get(c.id) : null; };
  const J = c => { try { return c && c.value ? JSON.parse(c.value) : null; } catch (e) { return null; } };
  return {
    text: t => { const c = raw(t); return c && c.text ? String(c.text).trim() : ''; },
    num: t => { const c = raw(t); const n = parseFloat(String((c && c.text) || '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; },
    check: t => { const c = raw(t); if (!c) return false; if (c.checked != null) return !!c.checked; const j = J(c); return !!(j && (j.checked === true || j.checked === 'true')); },
    rel: t => { const c = raw(t); return c && Array.isArray(c.linked_item_ids) ? c.linked_item_ids.map(String) : []; },
    loc: t => { const c = raw(t); const j = J(c); return { address: (j && j.address) || (c && c.text) || '', lat: j && j.lat != null ? Number(j.lat) : null, lng: j && j.lng != null ? Number(j.lng) : null }; },
    date: t => { const c = raw(t); const m = /^(\d{4}-\d{2}-\d{2})/.exec((c && c.text) || ''); return m ? m[1] : null; }
  };
}

const SKILLS = { sk_charpente: 'charpente', sk_syst_interieur: 'syst_interieur', sk_quincaillerie: 'quincaillerie', sk_revet_ext: 'revet_ext', sk_coffrage_beton: 'coffrage_beton' };
function mapEmployee(item, byTitle) {
  const g = getter(item, byTitle), loc = g.loc(EMP_MAP.address);
  const skills = {}; Object.keys(SKILLS).forEach(k => { const v = g.text(EMP_MAP[k]); if (v) skills[SKILLS[k]] = v; });
  return { monday_id: String(item.id), legacy: true, name: item.name, status: g.text(EMP_MAP.status), company: g.text(EMP_MAP.company), avantage_code: g.text(EMP_MAP.avantage_code),
    job_title: g.text(EMP_MAP.job_title), department: g.text(EMP_MAP.department), hire_date: g.date(EMP_MAP.hire_date), end_date: g.date(EMP_MAP.end_date),
    email_pro: g.text(EMP_MAP.email_pro), email_personal: g.text(EMP_MAP.email_personal), phone: g.text(EMP_MAP.phone), address: loc.address, lat: loc.lat, lng: loc.lng,
    emergency_name: g.text(EMP_MAP.emergency_name), emergency_phone: g.text(EMP_MAP.emergency_phone), notes: g.text(EMP_MAP.notes), skills: JSON.stringify(skills),
    punch_access: g.check(EMP_MAP.punch_access), exclude_payroll: g.check(EMP_MAP.exclude_payroll), approver: g.check(EMP_MAP.approver), prime_id: g.rel(EMP_MAP.prime_id)[0] || null,
    clerk_user_id: g.text(EMP_MAP.clerk_user_id) || null, monday_group: item.group ? item.group.title : null };
}
const jsonText = t => { try { const o = JSON.parse(t || '{}'); return JSON.stringify(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch (e) { return '{}'; } };
function mapProject(item, byTitle, empIds, empByName) {
  const g = getter(item, byTitle), loc = g.loc(PRJ_MAP.address);
  const keep = ids => ids.filter(i => empIds.has(i));
  const respNames = g.text(PRJ_MAP.responsible).split(/\s*,\s*/).filter(Boolean);
  const respIds = [], unknown = [];
  respNames.forEach(n => { const id = empByName.get(norm(n)); if (id) respIds.push(id); else unknown.push(n); });
  const respRel = keep(g.rel(PRJ_MAP.responsible));
  return { monday_id: String(item.id), legacy: true, number: g.text(PRJ_MAP.number), name: item.name, number_avantage: g.text(PRJ_MAP.number_avantage), status: g.text(PRJ_MAP.status),
    client: g.text(PRJ_MAP.client), client_email: g.text(PRJ_MAP.client_email), client_phone: g.text(PRJ_MAP.client_phone),
    owner_name: g.text(PRJ_MAP.owner_name), owner_address: g.text(PRJ_MAP.owner_address), owner_cadastre: g.text(PRJ_MAP.owner_cadastre), owner_email: g.text(PRJ_MAP.owner_email),
    address: loc.address, lat: loc.lat, lng: loc.lng, billing_type: g.text(PRJ_MAP.billing_type), cost_plus_pct: g.num(PRJ_MAP.cost_plus_pct), cost_plus_rate: g.num(PRJ_MAP.cost_plus_rate),
    billing_frequency: g.text(PRJ_MAP.billing_frequency), next_billing: g.text(PRJ_MAP.next_billing), max_po: Math.round(g.num(PRJ_MAP.max_po) || 0),
    insurance_pct: g.num(PRJ_MAP.insurance_pct) || 0, bond_pct: g.num(PRJ_MAP.bond_pct) || 0,
    responsible_ids: Array.from(new Set(respRel.concat(respIds))), responsible_text: unknown.join(', ') || null,
    cp_ids: keep(g.rel(PRJ_MAP.cp)), cm_ids: keep(g.rel(PRJ_MAP.cm)), coordo_ids: keep(g.rel(PRJ_MAP.coordo)), link: g.text(PRJ_MAP.link),
    labor_required: g.text(PRJ_MAP.labor_required), planif_comment: g.text(PRJ_MAP.planif_comment), labor_week: jsonText(g.text(PRJ_MAP.labor_week)),
    carpenters_required: g.num(PRJ_MAP.carpenters_required), carpenters_week: jsonText(g.text(PRJ_MAP.carpenters_week)), non_ccq_only: g.check(PRJ_MAP.non_ccq_only),
    punch_radius_m: g.num(PRJ_MAP.punch_radius_m) == null ? null : Math.round(g.num(PRJ_MAP.punch_radius_m)), planif_start: g.text(PRJ_MAP.planif_start), planif_end: g.text(PRJ_MAP.planif_end),
    lift_equipment_ids: g.rel(PRJ_MAP.lift), rolling_equipment_ids: g.rel(PRJ_MAP.rolling), monday_group: item.group ? item.group.title : null };
}

const JSONB = new Set(['skills', 'labor_week', 'carpenters_week']);
const TEXTARR = new Set(['responsible_ids', 'cp_ids', 'cm_ids', 'coordo_ids', 'lift_equipment_ids', 'rolling_equipment_ids']);
async function upsert(table, row) {
  const keys = Object.keys(row);
  const ph = keys.map((k, i) => '$' + (i + 1) + (JSONB.has(k) ? '::jsonb' : TEXTARR.has(k) ? '::text[]' : '')).join(',');
  const noUp = new Set(['monday_id', 'legacy']);
  const sets = keys.filter(k => !noUp.has(k)).map(k => k + ' = EXCLUDED.' + k);
  sets.push('monday_synced_at = now()', 'updated_at = now()');
  // `id` = identifiant Monday : toutes les références existantes (Finance, Planif, Punch) restent valides
  const sql = `INSERT INTO ${table} (id, ${keys.join(',')}, monday_synced_at, updated_at) VALUES ($${keys.length + 1}, ${ph}, now(), now())
    ON CONFLICT (monday_id) DO UPDATE SET ${sets.join(', ')}
    WHERE ${table}.legacy AND ${table}.updated_at <= COALESCE(${table}.monday_synced_at, ${table}.updated_at) + interval '2 seconds'
    RETURNING (xmax = 0) AS inserted`;
  const r = await q(sql, keys.map(k => (TEXTARR.has(k) ? row[k] : row[k])).concat([row.monday_id]));
  return r[0] ? (r[0].inserted ? 'created' : 'updated') : 'protected';
}

async function runPage(kind, cursor) {
  if (!BOARD[kind]) throw { status: 400, message: 'Type de synchronisation inconnu.' };
  const page = await fetchPage(kind, cursor || null);
  const out = { kind, processed: 0, created: 0, updated: 0, protected: 0, skipped: [] };
  let empIds = new Set(), empByName = new Map();
  if (kind === 'project') {
    const rows = await q('SELECT id, name FROM fin_employee');
    rows.forEach(r => { empIds.add(String(r.id)); if (!empByName.has(norm(r.name))) empByName.set(norm(r.name), String(r.id)); });
  }
  for (const item of page.items) {
    out.processed++;
    try {
      const row = kind === 'employee' ? mapEmployee(item, page.byTitle) : mapProject(item, page.byTitle, empIds, empByName);
      if (kind === 'project' && !row.number) { out.skipped.push({ id: item.id, name: String(item.name).slice(0, 60), reason: 'numéro de projet manquant' }); continue; }
      const r = await upsert(kind === 'employee' ? 'fin_employee' : 'fin_project', row);
      out[r]++;
    } catch (e) { out.skipped.push({ id: item.id, name: String(item.name).slice(0, 60), reason: String((e && e.message) || e).slice(0, 140) }); }
  }
  out.cursor = page.cursor; out.done = !page.cursor || !page.items.length;
  if (out.done) dir.resetCache();
  return out;
}
async function status() {
  const out = {};
  for (const [k, t] of [['employee', 'fin_employee'], ['project', 'fin_project']]) {
    try { const r = await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE monday_id IS NOT NULL)::int AS imported, max(monday_synced_at) AS last FROM ${t}`); out[k] = { total: r[0].n, imported: r[0].imported, last: r[0].last }; }
    catch (e) { out[k] = { error: 'Migration « migration-finance-directory.sql » non exécutée.' }; }
  }
  return out;
}
module.exports = { runPage, status, mapEmployee, mapProject, norm, BOARD };
