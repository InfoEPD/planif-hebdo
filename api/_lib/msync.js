// api/_lib/msync.js
//
// Synchronisation Monday → Exacto (transition). Lecture seule dans Monday; écriture dans Neon.
// Historique complet de 5 boards : Bons de commandes, Approbation Factures, Projets de modification / Extras (DDC),
// DA et FT, QRT. Les PDF NE sont PAS copiés (ils restent dans Monday « Legacy » / SharePoint).
// Chaque élément importé porte monday_id, monday_url et legacy = TRUE (affiché « Traité » lorsqu'il est terminé).
// Idempotent : relancer met à jour les éléments importés qui n'ont pas été modifiés dans Exacto depuis (les autres sont « protégés »).
//
// Le travail se fait par pages (50 éléments) : l'interface boucle tant que `done` est faux (limite Vercel 60 s).

const { q } = require('./db');
const monday = require('./monday');
const pdf = require('./pdf');
const { computeChange } = require('./cdpdf');

const ACCOUNT_URL = (process.env.MONDAY_ACCOUNT_URL || 'https://entreprisesphilippedenis.monday.com').replace(/\/$/, '');
const BOARDS = {
  po: process.env.PO_BOARD_ID || '8371776950',
  invoice: process.env.INVOICE_BOARD_ID || '8371778681',
  change: process.env.DDC_BOARD_ID || '8371777436',
  da: process.env.DA_BOARD_ID || '8372418174',
  qrt: process.env.QRT_BOARD_ID || '8372442042'
};
const KINDS = [
  { key: 'employee', label: 'Employés (annuaire)' },
  { key: 'project', label: 'Projets (Macro | PROJETS)' },
  { key: 'budget', label: 'Postes budgétaires et comptes G/L' },
  { key: 'po', label: 'Bons de commande' },
  { key: 'invoice', label: 'Factures' },
  { key: 'change', label: 'Demandes de changement' },
  { key: 'da', label: 'Dessins d\'atelier / fiches techniques' },
  { key: 'qrt', label: 'QRT' },
  { key: 'counters', label: 'Compteurs de bons de commande' }
].concat(require('./plsync').KINDS).concat(require('./pbsync').KINDS).concat(require('./absync').KINDS);
const PAGE = 50;

// ---------- Colonnes lues -------------------------------------------------------------------------------------
const COLS = {
  po: ['color', 'status', 'connect_boards4', 'connecter_les_tableaux__1', 'lookup_mkpmxqcx', 'texte__1', 'miroir_mkmwbam2', 'text_mkq61wwv', 'text4', 'date_1', 'texte3__1'],
  invoice: ['status', 'connect_boards', 'board_relation_mkpnh3s0', 'connecter_les_tableaux__1', '__facture', 'text7', 'date4', 'date9', 'numeric', 'numeric3', 'numeric4', 'numeric5', 'text2', 'text3', 'numeric_mkpnc4n7',
    'lookup_mkpmnv5g', 'mirror_mkkryrfg', 'mirror_mkkrfnsc', 'lookup_mkpn72g1', 'texte_mkmwz8jz'],
  change: ['text7', 'board_relation__1', 'status1', 'status16', 'date', 'statut__1', 'statut3__1', 'chiffres__1', 'long_text', 'status7', 'date_mkreb2rn', 'date__1', 'lookup_mkxtbdgf', 'lookup_mkxtnvhy'],
  da: ['color_mkrt2zv3', 'board_relation_mkrtww2g', 'text_mkrtfbej', 'text_mkrt1t98', 'email_mkx4b1qm', 'long_text_mkrtpnx6', 'text_mm0h2ytf', 'color_mm0hr76x', 'date_mkrtd6c0'],
  qrt: ['color_mkqyb70v', 'text_mkpxnqe3', 'date_mkpxn8hh', 'board_relation_mkpxr20d', 'text_mkrk3d1g', 'color_mkqygjm9', 'color_mkqyh3sh', 'color_mkqya2rk', 'long_text_mkrkpeyy', 'email_mktkw0k2', 'text_mktkyfjj']
};
const SUBCOLS = {
  po: ['numeric', 'numbers5'],
  change: ['numbers_mkkrvaza', 'numbers_mkkrcr8c', 'numeric_mkra5xc7', 'dropdown_mky49zd0', 'connect_boards']
};

const FIELDS = (kind) => {
  const col = ids => `column_values(ids: ${JSON.stringify(ids)}) { id type text ... on BoardRelationValue { linked_items { id name board { id } } } ... on MirrorValue { display_value } ... on FormulaValue { display_value } }`;
  const sub = SUBCOLS[kind] ? ` subitems { id name ${col(SUBCOLS[kind])} }` : '';
  return `id name created_at updated_at group { id title } ${col(COLS[kind])}${sub}`;
};

async function fetchPage(kind, cursor, limit) {
  const fields = FIELDS(kind);
  let page;
  if (!cursor) {
    const d = await monday.mq(`query { boards(ids: [${BOARDS[kind]}]) { items_page(limit: ${limit}) { cursor items { ${fields} } } } }`);
    page = d.boards && d.boards[0] && d.boards[0].items_page;
  } else {
    const d = await monday.mq(`query($c: String!) { next_items_page(limit: ${limit}, cursor: $c) { cursor items { ${fields} } } }`, { c: cursor });
    page = d.next_items_page;
  }
  return { items: (page && page.items) || [], cursor: (page && page.cursor) || null };
}

// ---------- Normalisation / utilitaires -----------------------------------------------------------------------
function normCv(arr) {
  const o = {};
  (arr || []).forEach(c => { o[c.id] = { text: String(c.text == null ? '' : c.text).trim(), linked: c.linked_items || [], display: c.display_value == null ? '' : String(c.display_value).trim() }; });
  return o;
}
function norm(raw, kind) {
  return { id: String(raw.id), name: String(raw.name || '').trim(), created: raw.created_at || null, updated: raw.updated_at || null, group: raw.group || {},
    url: ACCOUNT_URL + '/boards/' + BOARDS[kind] + '/pulses/' + raw.id, cv: normCv(raw.column_values),
    subs: (raw.subitems || []).map(s => ({ id: String(s.id), name: String(s.name || '').trim(), cv: normCv(s.column_values) })) };
}
const T = (it, id) => (it.cv[id] && (it.cv[id].text || it.cv[id].display)) || '';
const D = (it, id) => { const c = it.cv[id]; return c ? (c.display || c.text || '') : ''; };
const L = (it, id) => (it.cv[id] && it.cv[id].linked) || [];
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const date10 = v => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : null; };
const oneLine = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const norm2 = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------- Mappings de statuts -------------------------------------------------------------------------------
const PO_STATUS = { 'signe': 'signe', 'b/c envoye': 'envoye', 'b/c ferme': 'signe', 'annule': 'annule' };               // le reste : brouillon
const poStatus = s => PO_STATUS[norm2(s)] || 'brouillon';

const INV_STATUS = {
  'payee': ['approuvee', 'reussi'], 'exportation reussie': ['approuvee', 'reussi'], 'approuve - visa': ['approuvee', null],
  'approuvee - a exporter': ['approuvee', null], 'erreur export avantage': ['approuvee', null],
  'refusee': ['rejetee', null], 'annulee': ['rejetee', null],
  'a traiter par coordo': ['a_valider', null], 'a approuver': ['a_approuver', null], 'a determiner': ['a_determiner', null]
};
const invStatus = s => INV_STATUS[norm2(s)] || ['a_valider', null];

const CHG_STATUS = { 'approuve par client': 'approuve', 'avenant recu': 'avenant_recu', 'signe': 'approuve', 'sans frais ni credit': 'approuve',
  'envoye, en attente': 'envoye', 'envoye': 'envoye', 'a envoyer': 'envoye', 'refuse': 'refuse', 'annule': 'annule' };
const chgStatus = s => CHG_STATUS[norm2(s)] || 'brouillon';
const PRICE = { 'oui, augmentation': 'augmentation', 'oui, reduction': 'reduction', 'non, inchange': 'inchange' };
const priceFlag = s => PRICE[norm2(s)] || 'inconnu';

// DA : statut Monday -> [statut Exacto, supprimé (annulé / sans objet)]
const DA_STATUS = { 'a traiter': ['a_demander', false], 'generer pandadoc': ['a_demander', false], 'pandadoc genere': ['a_demander', false], 'epd a fournir': ['a_demander', false],
  'en attente du sous-traitant': ['demande', false], 'en attente du professionel': ['chez_pro', false], 'a resoumettre': ['a_corriger', false],
  'refuse': ['a_corriger', false], 'accepte': ['approuve', false], 'annule': ['a_demander', true], 'n/a': ['a_demander', true] };
const daStatus = s => DA_STATUS[norm2(s)] || ['a_demander', false];
const SPECIALTY = { 'mecanique': 'Mécanique', 'architecture': 'Architecture', 'architecture de paysage': 'Architecture de paysage', 'electrique': 'Électrique', 'structure': 'Structure', 'civil': 'Civil', 'hygiene': 'Hygiène' };

const QRT_STATUS = { 'qrt envoye |en attente|': 'chez_pro', 'pandadoc genere': 'chez_pro', 'qrt repondue': 'repondu' };       // le reste : brouillon
const YN = { 'oui': 'oui', 'non': 'non', 'inchange': 'non' };
const yn = s => YN[norm2(s)] || 'a_determiner';

// ---------- Mappers (purs, testés) ---------------------------------------------------------------------------
function projectInfo(ctx, id) {
  const p = ctx.projects.get(String(id || ''));
  return p ? { id: String(p.id), number: p.number || '', name: p.name || '', cp: (p.cp || []).map(c => String(c.email || '').toLowerCase()).filter(Boolean).join(',') } : null;
}

function mapPo(it, ctx) {
  const m = /^([0-9A-Za-z]+)-(\d{1,4})$/.exec(it.name);
  if (!m) return { skip: 'numéro de BC non conforme « ' + it.name + ' »' };
  const projLink = L(it, 'connect_boards4')[0];
  const proj = projLink ? projectInfo(ctx, projLink.id) : null;
  const sup = L(it, 'connecter_les_tableaux__1')[0];
  const lines = it.subs.map(s => ({ name: oneLine(s.name, 400), price: r2(num(T(s, 'numbers5'))), qty: Math.round(num(T(s, 'numeric')) * 1000) / 1000 })).filter(l => l.name || l.price || l.qty);
  const totals = pdf.computeTotals(lines);
  const status = poStatus(T(it, 'status'));
  const code = oneLine(T(it, 'texte__1'), 20);
  const bud = code && ctx.budgetByCode.get(code);
  const sent = date10(T(it, 'date_1'));
  const row = {
    monday_id: it.id, monday_url: it.url, legacy: true,
    po_number: it.name, project_number: m[1], seq: Number(m[2]), doc_ref: 'M-' + it.id, status,
    project_item_id: proj ? proj.id : (projLink ? String(projLink.id) : null), project_name: proj ? proj.name : (projLink ? projLink.name : null), cp_emails: proj ? proj.cp : '',
    supplier_item_id: sup ? String(sup.id) : null, supplier_name: sup ? sup.name : 'Fournisseur inconnu (Monday)', supplier_avantage_id: oneLine(D(it, 'lookup_mkpmxqcx'), 40) || null,
    issuer_user_id: 'monday-import', issuer_name: 'Import Monday', issuer_email: null,
    po_date: sent || date10(it.created) || new Date().toISOString().slice(0, 10), soumission_number: oneLine(T(it, 'text_mkq61wwv'), 80) || null,
    info_additional: /extra/i.test(T(it, 'color')) ? 'Extra / AV-C' : null,
    lines: JSON.stringify(lines), subtotal: totals.subtotal, tps: totals.tps, tvq: totals.tvq, total: totals.total,
    budget_item_id: bud ? bud.id : null, budget_label: bud ? bud.name : null, budget_code: code || null, gl_account: oneLine(D(it, 'miroir_mkmwbam2'), 20).split(/\s/)[0] || (bud ? bud.gl : null) || null, gl_label: bud ? bud.glLabel : null,
    sent_at: status === 'envoye' || status === 'signe' ? (sent ? sent + 'T12:00:00Z' : it.created) : null,
    signed_at: status === 'signe' ? it.updated : null,
    created_at: it.created
  };
  return { row, noUpdate: ['po_number', 'seq', 'doc_ref', 'issuer_user_id'], json: ['lines'], po: { project: row.project_number, seq: row.seq } };
}

function mapInvoice(it, ctx) {
  const [status, av] = invStatus(T(it, 'status'));
  const poLink = L(it, 'connect_boards')[0];
  const poFin = poLink && ctx.poById.get(String(poLink.id));
  const projLink = L(it, 'board_relation_mkpnh3s0')[0];
  const projId = projLink ? String(projLink.id) : (poFin ? poFin.project_item_id : null);
  const proj = projId ? projectInfo(ctx, projId) : null;
  const sup = L(it, 'connecter_les_tableaux__1')[0];
  const poText = oneLine(T(it, 'text7'), 60);
  const poNumber = poFin ? poFin.po_number : (poLink ? poLink.name : ((/^(\d{4,6}-\d{2,4})/.exec(poText) || [])[1] || poText || null));
  const gl = (D(it, 'lookup_mkpmnv5g') || D(it, 'mirror_mkkryrfg') || '').split(/[\s,]/)[0];
  const act = (D(it, 'mirror_mkkrfnsc') || D(it, 'lookup_mkpn72g1') || '').split(',')[0].trim();
  const subtotal = num(T(it, 'numeric')), tps = num(T(it, 'numeric3')), tvq = num(T(it, 'numeric4'));
  const total = num(T(it, 'numeric5')) || r2(subtotal + tps + tvq);
  const ret = T(it, 'numeric_mkpnc4n7');
  const row = {
    monday_id: it.id, monday_url: it.url, legacy: true, status, source: 'monday',
    supplier_name: oneLine(T(it, 'text2'), 200) || (sup ? sup.name : null), supplier_id: sup ? String(sup.id) : null,
    project_item_id: proj ? proj.id : projId, project_number: proj ? proj.number : (poFin ? poFin.project_number : null), project_name: proj ? proj.name : null, cp_emails: proj ? proj.cp : null,
    po_number: poNumber, po_id: poFin ? poFin.id : null, po_source: poFin ? 'finance' : null,
    invoice_number: oneLine(T(it, '__facture'), 80) || null, invoice_date: date10(T(it, 'date4')), due_date: date10(T(it, 'date9')),
    subtotal, tps, tvq, total, retention_pct: ret === '' ? null : num(ret),
    gl_expense: gl || null, activity_code: act || null, description: oneLine(T(it, 'text3'), 200) || null, comment: 'Importé de Monday (' + (T(it, 'status') || 'sans statut') + ')',
    avantage_status: av, avantage_account: oneLine(T(it, 'texte_mkmwz8jz'), 40) || null,
    created_by: 'monday-import', created_at: it.created
  };
  return { row, noUpdate: ['created_by'], json: [] };
}

function mapChange(it, ctx) {
  const projLink = L(it, 'board_relation__1')[0];
  if (!projLink) return { skip: 'aucun projet lié' };
  const proj = projectInfo(ctx, projLink.id);
  const avc = oneLine(T(it, 'text7'), 40) || oneLine(it.name.split(/\s+/)[0], 40);
  if (!avc) return { skip: 'numéro de DDC manquant' };
  const lines = it.subs.map(s => {
    const act = T(s, 'dropdown_mky49zd0'), sup = L(s, 'connect_boards')[0];
    return { name: oneLine(s.name, 400), qty: Math.round(num(T(s, 'numbers_mkkrvaza')) * 1000) / 1000, price: r2(num(T(s, 'numbers_mkkrcr8c'))), feePct: Math.min(100, Math.max(0, r2(num(T(s, 'numeric_mkra5xc7'))))),
      activityCode: (/^\s*([A-Za-z0-9/]+)\b/.exec(act) || [])[1] || '', budgetItemId: '', activityLabel: oneLine(act, 160), supplierItemId: sup ? String(sup.id) : '', supplierName: sup ? sup.name : '', supplierEmail: '' };
  }).filter(l => l.name || l.qty || l.price);
  const ins = num(D(it, 'lookup_mkxtbdgf')), bond = num(D(it, 'lookup_mkxtnvhy'));
  const c = computeChange(lines, ins, bond);
  const status = chgStatus(T(it, 'status7'));
  const row = {
    monday_id: it.id, monday_url: it.url, legacy: true,
    project_item_id: String(projLink.id), project_number: proj ? proj.number : null, project_name: proj ? proj.name : projLink.name,
    avc_number: avc, ddc_number: null, status, rev: 0, title: oneLine(it.name, 300),
    change_type: oneLine(T(it, 'status1'), 60) || null, issuer: oneLine(T(it, 'status16'), 60) || null, received_date: date10(T(it, 'date')),
    affects_price: priceFlag(T(it, 'statut__1')), affects_delay: priceFlag(T(it, 'statut3__1')), extra_days: T(it, 'chiffres__1') === '' ? null : Math.round(num(T(it, 'chiffres__1'))),
    description: String(T(it, 'long_text') || '').slice(0, 8000) || null,
    insurance_pct: ins, bond_pct: bond, lines: JSON.stringify(lines),
    total_before_tax: r2(c.subtotal), tps: r2(c.tps), tvq: r2(c.tvq), total: r2(c.total),
    sent_at: status === 'envoye' || status === 'approuve' || status === 'avenant_recu' ? (date10(T(it, 'date__1')) ? date10(T(it, 'date__1')) + 'T12:00:00Z' : it.created) : null,
    approved_at: (status === 'approuve' || status === 'avenant_recu') ? (date10(T(it, 'date_mkreb2rn')) ? date10(T(it, 'date_mkreb2rn')) + 'T12:00:00Z' : it.updated) : null,
    signed_date: (status === 'approuve' || status === 'avenant_recu') ? date10(T(it, 'date_mkreb2rn')) : null,
    created_by: 'monday-import', updated_by: 'monday-import', created_at: it.created
  };
  return { row, noUpdate: ['created_by'], json: ['lines'] };
}

function mapDa(it, ctx) {
  const projLink = L(it, 'board_relation_mkrtww2g')[0];
  if (!projLink) return { skip: 'aucun projet lié' };
  const proj = projectInfo(ctx, projLink.id);
  const [status, deleted] = daStatus(T(it, 'color_mkrt2zv3'));
  const desc = oneLine(it.name + (T(it, 'long_text_mkrtpnx6') ? ' — ' + T(it, 'long_text_mkrtpnx6') : ''), 500) || 'Sans description';
  const type = /\bfiche\b|\bFT\b|\bfiche technique/i.test(it.name + ' ' + T(it, 'long_text_mkrtpnx6')) ? 'FT' : 'DA';
  const spec = SPECIALTY[norm2(T(it, 'color_mm0hr76x'))] || null;
  const row = {
    monday_id: it.id, monday_url: it.url, legacy: true,
    project_item_id: String(projLink.id), project_number: proj ? proj.number : null, project_name: proj ? proj.name : projLink.name,
    da_type: type, description: desc, specialty: spec, spec_section: oneLine(T(it, 'text_mm0h2ytf'), 60) || null,
    supplier_name: oneLine(T(it, 'text_mkrtfbej'), 200) || null, supplier_contact: oneLine(T(it, 'text_mkrt1t98'), 120) || null, supplier_email: oneLine(T(it, 'email_mkx4b1qm'), 200).toLowerCase() || null,
    status, approved_at: (status === 'approuve' || status === 'avenant_recu') ? it.updated : null,
    deleted_at: deleted ? (it.updated || new Date().toISOString()) : null, deleted_by: deleted ? 'monday-import' : null,
    created_by: 'monday-import', updated_by: 'monday-import', created_at: it.created
  };
  return { row, noUpdate: ['created_by'], json: [], refPrefix: type };
}

function mapQrt(it, ctx) {
  const projLink = L(it, 'board_relation_mkpxr20d')[0];
  if (!projLink) return { skip: 'aucun projet lié (colonne Projet vide)' };
  const proj = projectInfo(ctx, projLink.id);
  const refText = T(it, 'text_mkpxnqe3');
  const mm = /QRT-([A-Z])-(\d+)/i.exec(refText);
  const grp = norm2(it.group && it.group.title);
  let status = QRT_STATUS[norm2(T(it, 'color_mkqyb70v'))] || 'brouillon';
  if (/archive/.test(grp)) status = 'retourne';
  const question = String(T(it, 'long_text_mkrkpeyy') || '').slice(0, 8000);
  const row = {
    monday_id: it.id, monday_url: it.url, legacy: true,
    project_item_id: String(projLink.id), project_number: proj ? proj.number : null, project_name: proj ? proj.name : projLink.name,
    discipline: mm ? mm[1].toUpperCase() : 'X', qrt_date: date10(T(it, 'date_mkpxn8hh')) || date10(it.created) || new Date().toISOString().slice(0, 10),
    object: oneLine(it.name, 300) || 'QRT importée de Monday', impact_schedule: yn(T(it, 'color_mkqygjm9')), impact_budget: yn(T(it, 'color_mkqyh3sh')), directive: yn(T(it, 'color_mkqya2rk')),
    requester_name: oneLine(T(it, 'text_mktkyfjj'), 120) || null, requester_email: oneLine(T(it, 'email_mktkw0k2'), 200).toLowerCase() || null, question: question || null,
    status, source: 'monday', created_by: 'monday-import', updated_by: 'monday-import', created_at: it.created
  };
  return { row, noUpdate: ['created_by', 'discipline'], json: [], qrtSeq: mm ? Number(mm[2]) : null };
}

const MAPPERS = { po: mapPo, invoice: mapInvoice, change: mapChange, da: mapDa, qrt: mapQrt };
const TABLES = { po: 'fin_po', invoice: 'fin_invoice', change: 'fin_change', da: 'fin_da', qrt: 'fin_qrt' };

// ---------- Écriture ------------------------------------------------------------------------------------------
async function upsert(table, row, opt) {
  const keys = Object.keys(row);
  const json = new Set(opt.json || []);
  const noUp = new Set(['monday_id', 'legacy'].concat(opt.noUpdate || []));
  const vals = keys.map(k => row[k]);
  const ph = keys.map((k, i) => '$' + (i + 1) + (json.has(k) ? '::jsonb' : '')).join(',');
  const sets = keys.filter(k => !noUp.has(k)).map(k => k + ' = EXCLUDED.' + k);
  sets.push('monday_synced_at = now()', 'updated_at = now()');
  const sql = `INSERT INTO ${table} (${keys.join(',')}, monday_synced_at, updated_at) VALUES (${ph}, now(), now())
    ON CONFLICT (monday_id) DO UPDATE SET ${sets.join(', ')}
    WHERE ${table}.legacy AND ${table}.updated_at <= COALESCE(${table}.monday_synced_at, ${table}.updated_at) + interval '2 seconds'
    RETURNING (xmax = 0) AS inserted`;
  const r = await q(sql, vals);
  return r[0] ? (r[0].inserted ? 'created' : 'updated') : 'protected';
}

async function existsByMonday(table, id) {
  const r = await q(`SELECT id FROM ${table} WHERE monday_id = $1`, [id]);
  return !!r[0];
}

async function processItem(kind, it, ctx) {
  const table = TABLES[kind];
  const mapped = MAPPERS[kind](it, ctx);
  if (mapped.skip) return { result: 'skipped', reason: mapped.skip };
  const row = mapped.row;
  const known = await existsByMonday(table, it.id);
  const noUpdate = (mapped.noUpdate || []).slice();

  if (!known) {
    // numérotation propre à Exacto pour les éléments qui n'en ont pas dans Monday
    if (kind === 'da') {
      const m = await q('SELECT COALESCE(MAX(seq), 0)::int AS m FROM fin_da WHERE project_item_id = $1', [row.project_item_id]);
      row.seq = m[0].m + 1; row.ref = mapped.refPrefix + '-' + String(row.seq).padStart(3, '0');
    } else if (kind === 'qrt') {
      const rows = await q('SELECT seq FROM fin_qrt WHERE project_item_id = $1 AND discipline = $2', [row.project_item_id, row.discipline]);
      const used = new Set(rows.map(r => Number(r.seq)));
      let n = mapped.qrtSeq && !used.has(mapped.qrtSeq) ? mapped.qrtSeq : 1; while (used.has(n)) n++;
      row.seq = n; row.ref = 'QRT-' + row.discipline + '-' + String(n).padStart(2, '0');
    } else if (kind === 'change') {
      const r = await q('SELECT 1 FROM fin_change WHERE project_item_id = $1 AND avc_number = $2', [row.project_item_id, row.avc_number]);
      if (r[0]) row.avc_number = row.avc_number + '-M' + it.id.slice(-4);        // doublon de numéro dans le projet
    }
  } else if (kind === 'da' || kind === 'qrt') {
    row.seq = 0; row.ref = 'x';                                                   // ignorés à la mise à jour
  }
  if (kind === 'da' || kind === 'qrt') noUpdate.push('seq', 'ref');
  const res = await upsert(table, row, { json: mapped.json, noUpdate });
  return { result: res, po: res !== 'protected' ? mapped.po : null };
}

// ---------- Postes budgétaires / comptes G/L ------------------------------------------------------------------
async function importBudget() {
  const items = await monday.fetchBudgetItemsFromMonday();
  let created = 0, updated = 0;
  const gl = new Map();
  for (const b of items) {
    if (!b.name) continue;
    const r = await q(`INSERT INTO fin_budget_item (id, code, name, gl, gl_label, active, updated_by) VALUES ($1,$2,$3,$4,$5,TRUE,$6)
        ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, gl = EXCLUDED.gl, gl_label = EXCLUDED.gl_label, updated_by = EXCLUDED.updated_by, updated_at = now()
        WHERE fin_budget_item.updated_by = 'monday-import' RETURNING (xmax = 0) AS inserted`, [String(b.id), b.code || '', b.name, b.gl || '', b.glLabel || '', 'monday-import']);
    if (r[0]) { if (r[0].inserted) created++; else updated++; }
    if (b.gl) gl.set(b.gl, b.glLabel || '');
  }
  for (const [account, label] of gl) {
    await q(`INSERT INTO fin_gl_account (account, label, updated_by) VALUES ($1,$2,'monday-import') ON CONFLICT (account) DO NOTHING`, [account, label]);
  }
  monday.resetBudgetCache();
  return { created, updated, glAccounts: gl.size, total: items.length };
}

async function refreshCounters() {
  const r = await q(`INSERT INTO fin_po_counter (project_number, last_seq)
      SELECT project_number, MAX(seq)::int FROM fin_po GROUP BY project_number
      ON CONFLICT (project_number) DO UPDATE SET last_seq = GREATEST(fin_po_counter.last_seq, EXCLUDED.last_seq)
      RETURNING project_number`);
  return { projects: r.length };
}

// ---------- Exécution d'une page -------------------------------------------------------------------------------
async function loadCtx() {
  const projects = new Map();
  (await monday.fetchProjectsLite()).forEach(p => projects.set(String(p.id), p));
  const budgetByCode = new Map();
  try { (await q('SELECT id, code, name, gl, gl_label FROM fin_budget_item')).forEach(b => { if (b.code && !budgetByCode.has(b.code)) budgetByCode.set(b.code, { id: b.id, name: b.name, gl: b.gl, glLabel: b.gl_label }); }); } catch (e) { /* table absente */ }
  return { projects, budgetByCode, poById: new Map() };
}

/** Traite une page de 50 éléments. Retourne { cursor, done, … }. */
async function runPage(user, kind, cursor) {
  if (/^ab_/.test(kind)) { const s = await require('./absync').runPage(kind, cursor || null); return Object.assign({ note: '' }, s); }
  if (/^pb_/.test(kind)) { const s = await require('./pbsync').runPage(kind, cursor || null); return Object.assign({ note: '' }, s); }
  if (/^pl_/.test(kind)) { const s = await require('./plsync').runPage(kind, cursor || null); return Object.assign({ note: '' }, s); }
  if (kind === 'employee' || kind === 'project') { const s = await require('./dirsync').runPage(kind, cursor || null); return Object.assign({ note: '' }, s); }
  if (kind === 'budget') { const s = await importBudget(); return { kind, done: true, cursor: null, processed: s.total, created: s.created, updated: s.updated, protected: 0, skipped: [], note: s.glAccounts + ' compte(s) G/L' }; }
  if (kind === 'counters') { const s = await refreshCounters(); return { kind, done: true, cursor: null, processed: s.projects, created: 0, updated: s.projects, protected: 0, skipped: [], note: s.projects + ' projet(s)' }; }
  if (!BOARDS[kind]) throw { status: 400, message: 'Type de synchronisation inconnu.' };
  const ctx = await loadCtx();
  const page = await fetchPage(kind, cursor || null, PAGE);
  const out = { kind, processed: 0, created: 0, updated: 0, protected: 0, skipped: [] };
  if (kind === 'invoice') {                       // retrouve d'un coup les bons de commande déjà importés
    const ids = [];
    page.items.forEach(raw => (raw.column_values || []).forEach(c => { if (c.id === 'connect_boards') (c.linked_items || []).forEach(l => ids.push(String(l.id))); }));
    if (ids.length) (await q('SELECT id, monday_id, po_number, project_item_id, project_number FROM fin_po WHERE monday_id = ANY($1::text[])', [ids])).forEach(r => ctx.poById.set(String(r.monday_id), r));
  }
  const poSeqs = new Map();
  for (const raw of page.items) {
    const it = norm(raw, kind);
    out.processed++;
    try {
      const r = await processItem(kind, it, ctx);
      if (r.result === 'skipped') out.skipped.push({ id: it.id, name: it.name.slice(0, 60), reason: r.reason });
      else out[r.result]++;
      if (r.po) poSeqs.set(r.po.project, Math.max(poSeqs.get(r.po.project) || 0, r.po.seq));
    } catch (e) {
      out.skipped.push({ id: it.id, name: it.name.slice(0, 60), reason: String((e && e.message) || e).slice(0, 140) });
    }
  }
  for (const [project, seq] of poSeqs) {
    await q(`INSERT INTO fin_po_counter (project_number, last_seq) VALUES ($1,$2) ON CONFLICT (project_number) DO UPDATE SET last_seq = GREATEST(fin_po_counter.last_seq, $2)`, [project, seq]);
  }
  out.cursor = page.cursor; out.done = !page.cursor || !page.items.length;
  return out;
}

/** Nombre d'éléments déjà importés par type (tableau de bord de la synchro). */
async function status() {
  const out = {};
  for (const k of Object.keys(TABLES)) {
    try {
      const r = await q(`SELECT count(*)::int AS n, max(monday_synced_at) AS last FROM ${TABLES[k]} WHERE monday_id IS NOT NULL`);
      out[k] = { imported: r[0].n, last: r[0].last };
    } catch (e) { out[k] = { error: 'Migration « migration-finance-monday.sql » non exécutée.' }; }
  }
  try { const d = await require('./dirsync').status(); out.employee = d.employee.error ? d.employee : { imported: d.employee.imported, last: d.employee.last }; out.project = d.project.error ? d.project : { imported: d.project.imported, last: d.project.last }; } catch (e) { /* facultatif */ }
  try { const p = await require('./absync').status(); Object.keys(p).forEach(k => { out[k] = p[k].error ? p[k] : { imported: p[k].imported }; }); } catch (e) { /* ignoré */ }
  try { const p = await require('./pbsync').status(); Object.keys(p).forEach(k => { out[k] = p[k].error ? p[k] : { imported: p[k].imported }; }); } catch (e) { /* ignoré */ }
  try { const p = await require('./plsync').status(); Object.keys(p).forEach(k => { out[k] = p[k].error ? p[k] : { imported: p[k].imported }; }); } catch (e) { /* ignoré */ }
  try { out.budget = { imported: (await q('SELECT count(*)::int AS n FROM fin_budget_item'))[0].n }; } catch (e) { out.budget = { error: 'Migration non exécutée.' }; }
  return { kinds: KINDS, status: out };
}

module.exports = { runPage, status, KINDS, norm, mapPo, mapInvoice, mapChange, mapDa, mapQrt, poStatus, invStatus, chgStatus, daStatus, upsert };
