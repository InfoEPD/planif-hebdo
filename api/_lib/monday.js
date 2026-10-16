// api/_lib/monday.js
//
// Lecture des boards Monday « Macro | PROJETS » et « Fournisseurs / Sous-traitants & Conformité »
// (côté serveur, avec MONDAY_API_TOKEN — jamais exposé au navigateur), et mise à jour de la
// colonne « Max # PO » du projet après l'émission d'un bon de commande.
//
// Variables d'environnement :
//   MONDAY_API_TOKEN         (obligatoire)
//   PROJECTS_BOARD_ID        défaut 8371776057
//   SUPPLIERS_BOARD_ID       défaut 8371776530

const dirdb = () => require('./dir');
const PROJECTS_BOARD = process.env.PROJECTS_BOARD_ID || '8371776057';
const SUPPLIERS_BOARD = process.env.SUPPLIERS_BOARD_ID || '8371776530';

const PC = { // colonnes du board Projets
  number: 'text',                     // # Projet
  numberAvantage: 'text_mkpcek2c',    // # Projet Avantage
  status: 'status3',                  // Étape du projet
  ownerName: 'texte_mkn5xn7z',        // Nom complet du propriétaire
  ownerAddress: 'texte_1_mkn56t4h',   // Adresse du propriétaire
  ownerCadastre: 'texte_2_mkn5x29j',  // Numéro de cadastre du terrain
  ownerEmail: 'e_mail_mkn5bhtm',      // Adresse courriel du propriétaire
  link: 'link',                       // Lien Wetransfer plans
  maxPo: 'chiffres_mkmqqbae',         // Max # PO
  cp: 'board_relation_mknrjzv9',      // Chargé de projet  -> board Employés
  cm: 'board_relation_mknr357t',      // Contremaître
  coordo: 'board_relation_mksxy8gw',  // Coordonnateur
  insurancePct: 'numeric_mkxt4shj',   // % assurance supplémentaire (avis de changement)
  bondPct: 'numeric_mkxtwdq1'         // % cautionnement supplémentaire
};
const EMP_EMAIL = 'email_mkptcywy';
const EMP_PHONE = 't_l_phone_mkmx24h2';

const SC = { // colonnes du board Fournisseurs
  type: 'color_mky46180',
  active: 'color_mksebna8',
  blacklist: 'status9',
  emailGeneral: 'email_mkp615ew',
  emailContact1: 'email_mktrpxw3',
  emailCompta: 'email9',
  phone: 'phone',
  contact: 'texte_mkmxfscy',
  avantageId: 'id_fourn__avantage_mkmwp6bg'
};

async function mq(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw { status: 500, message: "MONDAY_API_TOKEN n'est pas configuré sur le serveur." };
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token, 'API-Version': '2023-10' },
    body: JSON.stringify({ query, variables })
  });
  let j;
  try { j = await r.json(); } catch (e) { throw { status: 502, message: 'Réponse invalide de Monday (HTTP ' + r.status + ').' }; }
  if (j.errors && j.errors.length) throw { status: 502, message: 'Monday : ' + j.errors.map(e => e.message).join('; ') };
  if (!r.ok) throw { status: 502, message: 'Monday : HTTP ' + r.status };
  return j.data;
}

const RELATION_FRAGMENT = `... on BoardRelationValue { linked_items { id name column_values(ids: ["${EMP_EMAIL}", "${EMP_PHONE}"]) { id text } } }`;

async function paginate(boardId, colIds, fragment) {
  const cols = JSON.stringify(colIds);
  const fields = `id name column_values(ids: ${cols}) { id type text ${fragment || ''} }`;
  let data = await mq(`query { boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items { ${fields} } } } }`);
  let page = data.boards && data.boards[0] && data.boards[0].items_page;
  const out = [];
  while (page) {
    out.push(...(page.items || []));
    if (!page.cursor) break;
    data = await mq(`query($c: String!) { next_items_page(limit: 200, cursor: $c) { cursor items { ${fields} } } }`, { c: page.cursor });
    page = data.next_items_page;
  }
  return out;
}

function cvMap(item) {
  const m = {};
  (item.column_values || []).forEach(cv => { m[cv.id] = cv; });
  return m;
}
const txt = (m, id) => ((m[id] && m[id].text) || '').trim();

function people(m, id) {
  const cv = m[id];
  if (!cv || !cv.linked_items) return [];
  return cv.linked_items.map(li => {
    const cvs = {}; (li.column_values || []).forEach(c => { cvs[c.id] = c.text; });
    return { id: li.id, name: li.name, email: (cvs[EMP_EMAIL] || '').trim(), phone: (cvs[EMP_PHONE] || '').trim() };
  });
}

function parseProject(item) {
  const m = cvMap(item);
  const maxPo = parseInt(txt(m, PC.maxPo), 10);
  return {
    id: item.id,
    name: item.name,
    number: txt(m, PC.number),
    numberAvantage: txt(m, PC.numberAvantage),
    status: txt(m, PC.status),
    owner: { name: txt(m, PC.ownerName), address: txt(m, PC.ownerAddress), cadastre: txt(m, PC.ownerCadastre), email: txt(m, PC.ownerEmail) },
    link: txt(m, PC.link),
    maxPo: isFinite(maxPo) ? maxPo : 0,
    insurancePct: parseFloat(String(txt(m, PC.insurancePct)).replace(',', '.')) || 0,
    bondPct: parseFloat(String(txt(m, PC.bondPct)).replace(',', '.')) || 0,
    cp: people(m, PC.cp),
    cm: people(m, PC.cm),
    coordo: people(m, PC.coordo)
  };
}

const PROJECT_COLS = Object.values(PC);
let projCache = { at: 0, list: null };
async function fetchProjects(force) {
  if (await dirdb().enabled()) return dirdb().listProjects();
  if (!force && projCache.list && Date.now() - projCache.at < 5 * 60 * 1000) return projCache.list;
  const items = await paginate(PROJECTS_BOARD, PROJECT_COLS, RELATION_FRAGMENT);
  const list = items.map(parseProject).filter(p => p.number);
  projCache = { at: Date.now(), list };
  return list;
}

/** Liste légère (numéro, nom, statut, chargé de projet) : beaucoup plus rapide que la fiche complète. */
let projLiteCache = { at: 0, list: null };
async function fetchProjectsLite(force) {
  if (await dirdb().enabled()) return dirdb().listProjects();
  if (!force && projCache.list && Date.now() - projCache.at < 30 * 60 * 1000) return projCache.list;
  if (!force && projLiteCache.list && Date.now() - projLiteCache.at < 30 * 60 * 1000) return projLiteCache.list;
  const items = await paginate(PROJECTS_BOARD, [PC.number, PC.status, PC.cp], RELATION_FRAGMENT);
  const list = items.map(parseProject).filter(p => p.number);
  projLiteCache = { at: Date.now(), list };
  return list;
}

/** Projet à jour (toujours relu dans Monday : sert aux contrôles d'autorisation et au compteur). */
async function fetchProject(itemId) {
  if (await dirdb().enabled()) return dirdb().getProject(itemId);
  if (!/^\d+$/.test(String(itemId))) throw { status: 400, message: 'Projet invalide.' };
  const data = await mq(`query { items(ids: [${itemId}]) { id name board { id } column_values(ids: ${JSON.stringify(PROJECT_COLS)}) { id type text ${RELATION_FRAGMENT} } } }`);
  const item = data.items && data.items[0];
  if (!item || String(item.board && item.board.id) !== String(PROJECTS_BOARD)) throw { status: 404, message: 'Projet introuvable dans Monday.' };
  return parseProject(item);
}

function parseSupplier(item) {
  const m = cvMap(item);
  return {
    id: item.id,
    name: item.name,
    type: txt(m, SC.type),
    active: txt(m, SC.active) !== 'Inactif',
    blacklisted: txt(m, SC.blacklist) === 'Blacklist',
    emails: Array.from(new Set([txt(m, SC.emailGeneral), txt(m, SC.emailContact1), txt(m, SC.emailCompta)].filter(Boolean))),
    phone: txt(m, SC.phone),
    contact: txt(m, SC.contact),
    avantageId: txt(m, SC.avantageId)
  };
}

const SUPPLIER_COLS = Object.values(SC);
let supCache = { at: 0, list: null };
async function fetchSuppliers(force) {
  if (require('./suppliers-db').enabled()) return require('./suppliers-db').fetchSuppliers(force);
  if (!force && supCache.list && Date.now() - supCache.at < 5 * 60 * 1000) return supCache.list;
  const items = await paginate(SUPPLIERS_BOARD, SUPPLIER_COLS, '');
  const list = items.map(parseSupplier).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  supCache = { at: Date.now(), list };
  return list;
}

async function fetchSupplier(itemId) {
  if (require('./suppliers-db').enabled()) return require('./suppliers-db').fetchSupplier(itemId);
  if (!/^\d+$/.test(String(itemId))) throw { status: 400, message: 'Fournisseur invalide.' };
  const data = await mq(`query { items(ids: [${itemId}]) { id name board { id } column_values(ids: ${JSON.stringify(SUPPLIER_COLS)}) { id type text } } }`);
  const item = data.items && data.items[0];
  if (!item || String(item.board && item.board.id) !== String(SUPPLIERS_BOARD)) throw { status: 404, message: 'Fournisseur introuvable dans Monday.' };
  return parseSupplier(item);
}


/** Lecture COMPLÈTE du board Fournisseurs (import unique vers Neon) : toutes les colonnes, repérées par leur titre. */
async function fetchSuppliersFull() {
  const meta = await mq(`query { boards(ids: [${SUPPLIERS_BOARD}]) { columns { id title type } } }`);
  const columns = (meta.boards && meta.boards[0] && meta.boards[0].columns) || [];
  const ids = columns.map(c => c.id);
  const items = await paginate(SUPPLIERS_BOARD, ids, '');
  return { columns, items: items.map(it => {
    const byId = {}; (it.column_values || []).forEach(cv => { byId[cv.id] = (cv.text || '').trim(); });
    const byTitle = {}; columns.forEach(c => { byTitle[c.title] = byId[c.id] || ''; });
    return { id: it.id, name: it.name, byId, byTitle };
  }) };
}

/** Met à jour « Max # PO » (meilleur effort : un échec n'empêche pas l'émission du bon de commande). */
async function setMaxPo(projectItemId, seq) {
  if (await dirdb().enabled()) return dirdb().setMaxPo(projectItemId, seq);   // annuaire Projets dans Neon : plus d'écriture vers Monday
  try {
    await mq(`mutation($b: ID!, $i: ID!, $c: String!, $v: String!) { change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id } }`,
      { b: String(PROJECTS_BOARD), i: String(projectItemId), c: PC.maxPo, v: String(seq) });
    projCache = { at: 0, list: null };
    return true;
  } catch (e) {
    console.error('setMaxPo a échoué:', e && e.message);
    return false;
  }
}

// ---------- Bons de commande existants dans Monday (board « 📝 Bons de commandes ») ----------------------
// Transition : les bons créés avant Finance n'existent que dans Monday. On les retrouve par leur numéro
// (nom de l'élément, ex. « 25113-044 ») pour connaître leur montant, leur projet, leur fournisseur,
// le poste G/L / code d'activité, et ce qui a déjà été facturé dans Monday.

const PO_BOARD = process.env.PO_BOARD_ID || '8371776950';
const PO_COLS = { status: 'status', activity: 'texte__1', gl: 'miroir_mkmwbam2', project: 'connect_boards4', supplier: 'connecter_les_tableaux__1', supplierAv: 'lookup_mkpmxqcx', payables: 'mirror24', invoices: 'link_to_payables___recevables___cashflow___ocr' };
const MINV = { number: '__facture', subtotal: 'numeric', status: 'status' }; // board « ✅ Approbation Factures »

const poCache = new Map(); // numéro -> { at, value }

function splitNums(s) { return String(s || '').split(',').map(x => parseFloat(x.trim())).filter(n => isFinite(n)); }

function parsePoItem(it) {
  const m = cvMap(it);
  const lk = id => (m[id] && m[id].linked_items) || [];
  let subtotal = 0;
  (it.subitems || []).forEach(si => {
    const v = {}; (si.column_values || []).forEach(c => { v[c.id] = parseFloat(String(c.text || '').replace(/\s/g, '').replace(',', '.')); });
    if (isFinite(v.numeric) && isFinite(v.numbers5)) subtotal += v.numeric * v.numbers5;
  });
  const proj = lk(PO_COLS.project).find(x => String(x.board && x.board.id) === String(PROJECTS_BOARD)) || lk(PO_COLS.project)[0];
  const sup = lk(PO_COLS.supplier)[0];
  const dv = id => ((m[id] && (m[id].display_value != null ? m[id].display_value : m[id].text)) || '').toString().trim();
  return {
    itemId: it.id, name: it.name,
    status: txt(m, PO_COLS.status),
    subtotal: Math.round(subtotal * 100) / 100,
    activityCode: txt(m, PO_COLS.activity),
    gl: dv(PO_COLS.gl),
    projectItemId: proj ? proj.id : null,
    supplierItemId: sup ? sup.id : null,
    supplierName: sup ? sup.name : '',
    supplierAvantageId: dv(PO_COLS.supplierAv),
    billedFromMirror: Math.round(splitNums(dv(PO_COLS.payables)).reduce((a, b) => a + b, 0) * 100) / 100,
    invoiceItemIds: lk(PO_COLS.invoices).map(x => x.id)
  };
}

/** Bon de commande Monday par numéro exact (« 25113-044 »), ou null. Résultat gardé 2 minutes. */
async function fetchPoByNumber(poNumber) {
  const n = String(poNumber || '').trim();
  if (!/^[0-9A-Za-z-]{3,24}$/.test(n)) return null;
  const hit = poCache.get(n);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.value;
  const ids = JSON.stringify(Object.values(PO_COLS));
  const build = rich => `query { boards(ids: [${PO_BOARD}]) { items_page(limit: 10, query_params: { rules: [{ column_id: "name", compare_value: [${JSON.stringify(n)}], operator: contains_text }] }) { items { id name
      column_values(ids: ${ids}) { id type text ... on BoardRelationValue { linked_items { id name board { id } } } ${rich ? '... on MirrorValue { display_value }' : ''} }
      subitems { id column_values(ids: ["numeric","numbers5"]) { id text } } } } } }`;
  let data;
  try { data = await mq(build(true)); }
  catch (e) { data = await mq(build(false)); } // repli : sans les valeurs miroir (G/L, factures déjà payées)
  const items = (data.boards && data.boards[0] && data.boards[0].items_page && data.boards[0].items_page.items) || [];
  const it = items.find(x => String(x.name).trim() === n);
  const value = it ? parsePoItem(it) : null;
  poCache.set(n, { at: Date.now(), value });
  return value;
}

/** Factures déjà saisies dans Monday pour ce bon : [{ id, name, number, subtotal, status }]. */
async function fetchMondayInvoices(itemIds) {
  const ids = (itemIds || []).filter(i => /^\d+$/.test(String(i))).slice(0, 60);
  if (!ids.length) return [];
  const data = await mq(`query { items(ids: [${ids.join(',')}]) { id name column_values(ids: ["${MINV.number}","${MINV.subtotal}","${MINV.status}"]) { id text } } }`);
  return (data.items || []).map(it => {
    const m = cvMap(it);
    const sub = parseFloat(txt(m, MINV.subtotal).replace(/\s/g, '').replace(',', '.'));
    return { id: it.id, name: it.name, number: txt(m, MINV.number), subtotal: isFinite(sub) ? sub : 0, status: txt(m, MINV.status) };
  });
}

// ---------- Postes budgétaires (board « 💲 Postes Budgétaires ») ------------------------------------------
// Chaque poste (ex. « 1000 - Exigences générales ») est lié à la charte comptable (ex. « 33510 - ACHATS DE MATÉRIAUX »).
// Le n° de compte G/L est le début du nom de l'élément de la charte comptable.

const BUDGET_BOARD = process.env.BUDGET_BOARD_ID || '8371778023';
const BUDGET_COLS = { activity: 'texte3__1', division: 'extract_with_ai_mkkqqfyp', chart: 'connect_boards_mkkqret0' };
const BUDGET_FRAGMENT = '... on BoardRelationValue { linked_items { id name board { id } } }';

function glFromName(name) { const m = String(name || '').match(/^\s*(\d{4,6})\b/); return m ? m[1] : ''; }

function parseBudget(item) {
  const m = cvMap(item);
  const linked = (m[BUDGET_COLS.chart] && m[BUDGET_COLS.chart].linked_items) || [];
  const withGl = linked.find(x => glFromName(x.name)) || linked[0];
  const code = txt(m, BUDGET_COLS.activity) || (String(item.name).match(/^\s*(\d+)/) || [])[1] || '';
  return { id: item.id, name: item.name, code, gl: withGl ? glFromName(withGl.name) : '', glLabel: withGl ? withGl.name : '' };
}

let budgetCache = { at: 0, list: null };
function resetBudgetCache() { budgetCache = { at: 0, list: null }; }

/** Postes budgétaires gérés dans Exacto (Configuration) : utilisés dès qu'il y en a au moins un; sinon lecture de Monday. */
async function neonBudgetItems() {
  try {
    const { q } = require('./db');
    const rows = await q("SELECT id, code, name, gl, gl_label FROM fin_budget_item WHERE active ORDER BY name");
    if (!rows.length) return null;
    return rows.map(r => ({ id: String(r.id), name: r.name, code: r.code || '', gl: r.gl || '', glLabel: r.gl_label || '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }));
  } catch (e) { return null; }       // table absente (migration non exécutée) : on reste sur Monday
}

async function fetchBudgetItems(force) {
  if (!force && budgetCache.list && Date.now() - budgetCache.at < 10 * 60 * 1000) return budgetCache.list;
  let list = await neonBudgetItems();
  if (!list) {
    const items = await paginate(BUDGET_BOARD, Object.values(BUDGET_COLS), BUDGET_FRAGMENT);
    list = items.map(parseBudget).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }));
  }
  budgetCache = { at: Date.now(), list };
  return list;
}

/** Lecture directe du board Monday (pour l'import initial dans Exacto). */
async function fetchBudgetItemsFromMonday() {
  const items = await paginate(BUDGET_BOARD, Object.values(BUDGET_COLS), BUDGET_FRAGMENT);
  return items.map(parseBudget);
}

async function fetchBudgetItem(itemId) {
  const id = String(itemId == null ? '' : itemId);
  const local = await neonBudgetItems();
  if (local) {
    const hit = local.find(x => x.id === id);
    if (!hit) throw { status: 404, message: 'Poste budgétaire introuvable (ou désactivé) dans Exacto.' };
    return hit;
  }
  if (!/^\d+$/.test(id)) throw { status: 400, message: 'Poste budgétaire invalide.' };
  const data = await mq(`query { items(ids: [${id}]) { id name board { id } column_values(ids: ${JSON.stringify(Object.values(BUDGET_COLS))}) { id type text ${BUDGET_FRAGMENT} } } }`);
  const item = data.items && data.items[0];
  if (!item || String(item.board && item.board.id) !== String(BUDGET_BOARD)) throw { status: 404, message: 'Poste budgétaire introuvable dans Monday.' };
  return parseBudget(item);
}

/** Tous les bons de commande Monday d'un projet (relation « projet »). Résultat gardé 2 minutes. */
const poByProjCache = new Map();
async function fetchPosByProject(projectItemId) {
  if (!/^\d+$/.test(String(projectItemId))) return [];
  const hit = poByProjCache.get(projectItemId);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.value;
  const ids = JSON.stringify(Object.values(PO_COLS));
  const fields = `id name column_values(ids: ${ids}) { id type text ... on BoardRelationValue { linked_items { id name board { id } } } } subitems { id column_values(ids: ["numeric","numbers5"]) { id text } }`;
  let data = await mq(`query { boards(ids: [${PO_BOARD}]) { items_page(limit: 200, query_params: { rules: [{ column_id: "${PO_COLS.project}", compare_value: [${projectItemId}], operator: any_of }] }) { cursor items { ${fields} } } } }`);
  let page = data.boards && data.boards[0] && data.boards[0].items_page;
  const out = [];
  for (let n = 0; page && n < 6; n++) {
    out.push(...(page.items || []));
    if (!page.cursor) break;
    data = await mq(`query($c: String!) { next_items_page(limit: 200, cursor: $c) { cursor items { ${fields} } } }`, { c: page.cursor });
    page = data.next_items_page;
  }
  const value = out.map(parsePoItem);
  poByProjCache.set(projectItemId, { at: Date.now(), value });
  return value;
}

// ---------- Factures Monday d'un projet (board « ✅ Approbation Factures ») : avec ET sans bon de commande ------
const INV_BOARD = process.env.INVOICE_BOARD_ID || '8371778681';
const INV_COLS = { project: 'board_relation_mkpnh3s0', status: 'status', number: '__facture', subtotal: 'numeric', supplier: 'text2', date: 'date4', poText: 'text7',
  po: 'connect_boards', actNoPo: 'lookup_mkpn72g1', actPo: 'mirror_mkkrfnsc', supplierNoPo: 'connecter_les_tableaux__1', division: 'connect_boards_mkkrsctt' };
const invByProjCache = new Map();
async function fetchInvoicesByProject(projectItemId) {
  if (!/^\d+$/.test(String(projectItemId))) return [];
  const hit = invByProjCache.get(projectItemId);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.value;
  const ids = JSON.stringify(Object.values(INV_COLS).filter(c => c !== INV_COLS.project));
  const fields = `id name column_values(ids: ${ids}) { id type text ... on BoardRelationValue { linked_items { id name } } ... on MirrorValue { display_value } }`;
  let data = await mq(`query { boards(ids: [${INV_BOARD}]) { items_page(limit: 200, query_params: { rules: [{ column_id: "${INV_COLS.project}", compare_value: [${projectItemId}], operator: any_of }] }) { cursor items { ${fields} } } } }`);
  let page = data.boards && data.boards[0] && data.boards[0].items_page;
  const out = [];
  for (let n = 0; page && n < 15; n++) {
    out.push(...(page.items || []));
    if (!page.cursor) break;
    data = await mq(`query($c: String!) { next_items_page(limit: 200, cursor: $c) { cursor items { ${fields} } } }`, { c: page.cursor });
    page = data.next_items_page;
  }
  const value = out.map(it => {
    const m = cvMap(it);
    const dv = id => ((m[id] && (m[id].display_value != null && m[id].display_value !== '' ? m[id].display_value : m[id].text)) || '').toString().trim();
    const lk = id => (m[id] && m[id].linked_items) || [];
    const sub = parseFloat(txt(m, INV_COLS.subtotal).replace(/\s/g, '').replace(',', '.'));
    return { id: it.id, name: it.name, number: txt(m, INV_COLS.number), subtotal: isFinite(sub) ? sub : 0, status: txt(m, INV_COLS.status),
      supplier: txt(m, INV_COLS.supplier) || (lk(INV_COLS.supplierNoPo)[0] || {}).name || '', date: txt(m, INV_COLS.date) || null,
      poNumber: txt(m, INV_COLS.poText) || (lk(INV_COLS.po)[0] || {}).name || '', hasPo: lk(INV_COLS.po).length > 0, divisionId: (lk(INV_COLS.division)[0] || {}).id || '',
      activityNoPo: dv(INV_COLS.actNoPo).split(',')[0].trim(), activityPo: dv(INV_COLS.actPo).split(',')[0].trim() };
  });
  invByProjCache.set(projectItemId, { at: Date.now(), value });
  return value;
}


// ---------- Demandes de changement (board « Projets de modification / Extras ») ---------------------------
const DDC_BOARD = process.env.DDC_BOARD_ID || '8371777436';
const DDC_STATUS_OK = (process.env.DDC_APPROVED_STATUS_IDS || '4,3').split(',').map(x => x.trim()).filter(Boolean); // 4 = Approuvé par client, 3 = Avenant reçu
let ddcCache = new Map();

/** DDC approuvées (Monday) d'un projet : { id, number, name, date, total, lines: [{ code, amount }] }. Montants avant taxes, frais/assurance/cautionnement inclus. */
async function fetchDdcByProject(projectItemId) {
  if (!/^\d+$/.test(String(projectItemId))) return [];
  const hit = ddcCache.get(projectItemId);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.value;
  const cols = '["text7","status7","date_mkreb2rn","lookup_mkxtbdgf","lookup_mkxtnvhy","formula_mkye67ys"]';
  const fields = `id name column_values(ids: ${cols}) { id type text ... on FormulaValue { display_value } ... on MirrorValue { display_value } }
    subitems { id name column_values(ids: ["dropdown_mky49zd0","formula_mkrapsav"]) { id type text ... on FormulaValue { display_value } } }`;
  const rules = `[{ column_id: "board_relation__1", compare_value: [${projectItemId}], operator: any_of }, { column_id: "status7", compare_value: [${DDC_STATUS_OK.join(',')}], operator: any_of }]`;
  let data = await mq(`query { boards(ids: [${DDC_BOARD}]) { items_page(limit: 100, query_params: { rules: ${rules} }) { cursor items { ${fields} } } } }`);
  let page = data.boards && data.boards[0] && data.boards[0].items_page;
  const items = [];
  for (let n = 0; page && n < 10; n++) {
    items.push(...(page.items || []));
    if (!page.cursor) break;
    data = await mq(`query($c: String!) { next_items_page(limit: 100, cursor: $c) { cursor items { ${fields} } } }`, { c: page.cursor });
    page = data.next_items_page;
  }
  const f = v => { const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
  const value = items.map(it => {
    const m = cvMap(it);
    const dv = id => (m[id] && (m[id].display_value != null && m[id].display_value !== '' ? m[id].display_value : m[id].text)) || '';
    const factor = 1 + (f(dv('lookup_mkxtbdgf')) + f(dv('lookup_mkxtnvhy'))) / 100;
    const lines = (it.subitems || []).map(si => {
      const sm = cvMap(si);
      const label = String((sm.dropdown_mky49zd0 && sm.dropdown_mky49zd0.text) || '').trim();
      const tot = f((sm.formula_mkrapsav && (sm.formula_mkrapsav.display_value || sm.formula_mkrapsav.text)) || 0);
      return { code: (label.match(/^\s*([A-Za-z0-9/]+)\b/) || [])[1] || '', label, amount: Math.round(tot * factor * 100) / 100 };
    }).filter(l => l.amount);
    let total = f(dv('formula_mkye67ys'));
    const sum = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    if (!total) total = sum;
    return { id: it.id, number: txt(m, 'text7'), name: it.name, date: txt(m, 'date_mkreb2rn') || null, total: Math.round(total * 100) / 100, lines, unallocated: Math.round((total - sum) * 100) / 100 };
  }).filter(d => d.total);
  ddcCache.set(projectItemId, { at: Date.now(), value });
  return value;
}

module.exports = { mq, cvMap, txt, resetBudgetCache, fetchBudgetItemsFromMonday, fetchDdcByProject, fetchInvoicesByProject, fetchProjectsLite, fetchPosByProject, fetchProjects, fetchProject, fetchSuppliers, fetchSupplier, fetchSuppliersFull, SC, setMaxPo, fetchPoByNumber, fetchMondayInvoices, fetchBudgetItems, fetchBudgetItem, glFromName, PROJECTS_BOARD, SUPPLIERS_BOARD, PO_BOARD };
