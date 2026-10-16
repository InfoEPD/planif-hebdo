// api/_lib/invoice.js
//
// Étape B1 — factures fournisseurs : calculs (retenue / taxes / écriture comptable), lecture automatique
// par Claude (extraction structurée), rapprochement avec Monday (projet, fournisseur) et les bons de
// commande, réception des factures par courriel (Microsoft Graph), copie SharePoint.
//
// Variables d'environnement :
//   ANTHROPIC_API_KEY            clé API Anthropic (lecture automatique) — sans elle : saisie manuelle
//   INVOICE_OCR_MODEL            (facultatif) défaut « claude-sonnet-5-5 »
//   FINANCE_ACCOUNTING_EMAILS    (facultatif) valeur par défaut de la liste « comptabilité » (modifiable dans l'application)
//   INVOICE_MAILBOX              boîte partagée qui reçoit les factures, ex. factures@epd.ca
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   (même application Entra que SharePoint ; permission Mail.ReadWrite)
//   INVOICE_CRON_SECRET          secret du déclencheur externe qui appelle /api/invoices?cron=1

const { q } = require('./db');
const sp = require('./sharepoint');
const monday = require('./monday');
const mlive = require('./mlive');

const TPS_RATE = 0.05, TVQ_RATE = 0.09975;
const DEFAULT_ACCOUNTING = 'cdufort@epd.ca,mayotte@epd.ca,alachapelle@epd.ca';

// Comptes de bilan Avantage (fixes)
const GL = { fournisseurs: '21300', retenues: '21310', tpsAchats: '21340', tpsRetenues: '21341', tvqAchats: '21370', tvqRetenues: '21371' };

function num(v) { if (v === '' || v == null) return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; }
function n0(v) { const n = num(v); return n == null ? 0 : n; }
function round2(n) { const a = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100; return n < 0 ? -a : a; }
function money(n) { return Number(n || 0).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $'; }
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max || 200); }
/** Description envoyée à Avantage : max 50 car., lettres/chiffres/espace et - . / # seulement (accents retirés). */
function cleanDescription(v, max) {
  let t = String(v == null ? '' : v).replace(/[œŒ]/g, 'oe').replace(/[æÆ]/g, 'ae').replace(/&/g, ' et ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[^A-Za-z0-9 .\-\/#]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, max || 50).trim();
}
function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isFinite(v) ? v.toISOString().slice(0, 10) : null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}

// ---------- Écriture comptable / retenue / contrôles ---------------------------------------------------

/**
 * Retenue contractuelle = % du TOTAL taxes incluses. Les taxes sont réparties au même prorata :
 *   90 % -> 21340 (TPS payée sur achats) / 21370 (TVQ payée sur achats)
 *   10 % -> 21341 (TPS à payer sur retenues) / 21371 (TVQ à payer sur retenues)
 * (la part « achats » = taxe − part « retenue », pour que tout balance au cent près).
 */
function computeEntry(inv) {
  const sub = n0(inv.subtotal), tps = n0(inv.tps), tvq = n0(inv.tvq);
  const total = inv.total != null && inv.total !== '' ? n0(inv.total) : round2(sub + tps + tvq);
  const pct = Math.max(0, Math.min(100, n0(inv.retention_pct)));
  const retention = round2(total * pct / 100);
  const tpsRet = round2(tps * pct / 100), tvqRet = round2(tvq * pct / 100);
  const tpsAch = round2(tps - tpsRet), tvqAch = round2(tvq - tvqRet);
  const net = round2(total - retention);
  const lines = [
    { description: 'Dépense (sous-total avant taxes)', poste: inv.gl_expense || '', amount: sub },
    { description: 'TPS payée sur achats', poste: GL.tpsAchats, amount: tpsAch },
    { description: 'TVQ payée sur achats', poste: GL.tvqAchats, amount: tvqAch }
  ];
  if (retention !== 0) {
    lines.push({ description: 'TPS à payer sur retenues', poste: GL.tpsRetenues, amount: tpsRet });
    lines.push({ description: 'TVQ à payer sur retenues', poste: GL.tvqRetenues, amount: tvqRet });
  }
  const debit = round2(lines.reduce((s, l) => s + l.amount, 0));
  return {
    total, retention_pct: pct, retention, net, lines,
    credits: [
      { description: 'Comptes fournisseurs (solde à payer)', poste: GL.fournisseurs, amount: net },
      ...(retention !== 0 ? [{ description: 'Retenues à payer', poste: GL.retenues, amount: retention }] : [])
    ],
    balanced: Math.abs(debit - total) < 0.005
  };
}

/** Contrôles affichés à la comptabilité (écarts de taxes, total, doublons gérés ailleurs). */
function computeChecks(inv) {
  const out = [];
  const sub = n0(inv.subtotal), tps = n0(inv.tps), tvq = n0(inv.tvq);
  if (inv.subtotal == null || inv.subtotal === '') return out;
  const eTps = round2(sub * TPS_RATE), eTvq = round2(sub * TVQ_RATE);
  if (Math.abs(tps - eTps) > 0.02) out.push({ level: 'warn', code: 'tps', message: 'TPS facturée ' + money(tps) + ' ≠ TPS calculée ' + money(eTps) + ' (5 % de ' + money(sub) + ') — écart de ' + money(round2(tps - eTps)) + '.' });
  if (Math.abs(tvq - eTvq) > 0.02) out.push({ level: 'warn', code: 'tvq', message: 'TVQ facturée ' + money(tvq) + ' ≠ TVQ calculée ' + money(eTvq) + ' (9,975 % de ' + money(sub) + ') — écart de ' + money(round2(tvq - eTvq)) + '.' });
  if (inv.total != null && inv.total !== '' && Math.abs(round2(sub + tps + tvq) - n0(inv.total)) > 0.02) {
    out.push({ level: 'warn', code: 'total', message: 'Sous-total + TPS + TVQ = ' + money(round2(sub + tps + tvq)) + ', mais le total de la facture est ' + money(n0(inv.total)) + '.' });
  }
  return out;
}

// ---------- Rapprochement (noms, bons de commande, projets) ----------------------------------------------

function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|incorporee|ltee|ltd|limitee|enr|senc|cie|compagnie|et|and|la|le|les|de|du|des)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function normInvoiceNumber(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/**
 * « BC-25113-044 » / « PO 25113 044 » / « BC‑25113‑044 » (tirets spéciaux) / « BC25113044 »
 *   -> { poNumber: '25113-044', projectNumber: '25113' }
 */
function parsePoNumber(raw) {
  const s = String(raw || '');
  let m = s.match(/(\d{4,6})\D{1,3}(\d{1,4})(?!\d)/);
  if (!m) m = s.match(/^\D*(\d{5})(\d{3})\D*$/);
  if (!m) return null;
  return { projectNumber: m[1], poNumber: m[1] + '-' + m[2].padStart(3, '0') };
}

function normNum(s) { return String(s || '').replace(/[^0-9A-Za-z]/g, '').replace(/^0+/, '').toUpperCase(); }
function projectByNumber(projects, n) {
  const k = normNum(n);
  if (!k) return null;
  return projects.find(p => normNum(p.number) === k) || projects.find(p => normNum(p.numberAvantage) === k) || null;
}

// ---------- Bon de commande : Finance d'abord, sinon Monday ---------------------------------------------

/**
 * Retrouve un bon de commande par son numéro normalisé (« 25113-044 ») :
 *   1) dans Finance (table fin_po)   2) dans le board Monday « 📝 Bons de commandes » (bons créés avant Finance).
 * Retourne { source, number, subtotal (avant taxes), total (taxes incluses), … } ou null.
 */
async function findPo(poNumber) {
  const pp = parsePoNumber(poNumber);
  const n = pp ? pp.poNumber : String(poNumber || '').trim();
  if (!n) return null;
  const rows = await q('SELECT id, po_number, status, project_item_id, supplier_item_id, supplier_name, supplier_avantage_id, subtotal, total, budget_label, budget_code, gl_account FROM fin_po WHERE po_number = $1', [n]);
  if (rows[0]) {
    const r = rows[0];
    return { source: 'finance', number: n, poId: r.id, itemId: null, status: r.status, subtotal: Number(r.subtotal), total: Number(r.total),
      projectItemId: r.project_item_id || null, supplierItemId: r.supplier_item_id || null, supplierName: r.supplier_name, supplierAvantageId: r.supplier_avantage_id || '',
      glExpense: r.gl_account || '', activityCode: r.budget_code || '', budgetLabel: r.budget_label || '', mondayInvoiceIds: [], billedFromMirror: 0 };
  }
  if (mlive.po) try {
    const m = await monday.fetchPoByNumber(n);
    if (m) {
      return { source: 'monday', number: n, poId: null, itemId: m.itemId, status: m.status, subtotal: m.subtotal, total: round2(m.subtotal * (1 + TPS_RATE + TVQ_RATE)),
        projectItemId: m.projectItemId, supplierItemId: m.supplierItemId, supplierName: '', supplierAvantageId: m.supplierAvantageId || '',
        glExpense: m.gl || '', activityCode: m.activityCode || '', mondayInvoiceIds: m.invoiceItemIds || [], billedFromMirror: m.billedFromMirror || 0 };
    }
  } catch (e) { console.error('findPo Monday', e && e.message); }
  return null;
}

/**
 * Suivi du bon de commande par rapport aux factures (montants AVANT taxes, comme le Δ « Bons − Payables » de Monday) :
 *   facturé dans Monday (avant Finance) + approuvé dans Finance + cette facture  vs  montant du bon.
 * Les factures Monday dont le n° de facture est celui de cette facture ne sont pas recomptées (doublon de transition).
 */
/** Autres factures liées au même bon de commande (date, fournisseur, montant avant taxes). */
async function poInvoicesFor(poNumber, excludeId, includeUnvalidated) {
  const n = (parsePoNumber(poNumber) || {}).poNumber || String(poNumber || '').trim();
  if (!n) return [];
  const rows = await q(`SELECT id, status, invoice_number, invoice_date, supplier_name, subtotal FROM fin_invoice
      WHERE po_number = $1 AND status <> 'rejetee' AND id <> $2 ${includeUnvalidated ? '' : "AND status IN ('a_approuver','en_attente','approuvee')"}
      ORDER BY invoice_date ASC NULLS LAST, created_at ASC LIMIT 60`, [n, excludeId || '00000000-0000-0000-0000-000000000000']);
  return rows.map(x => ({ id: x.id, status: x.status, invoiceNumber: x.invoice_number, invoiceDate: isoDate(x.invoice_date), supplier: x.supplier_name, subtotal: x.subtotal == null ? null : Number(x.subtotal) }));
}

async function poBudget(poNumber, cur) {
  const po = await findPo(poNumber);
  if (!po) return null;
  poNumber = po.number;
  const others = await q(`SELECT id, status, invoice_number, supplier_name, subtotal FROM fin_invoice WHERE po_number = $1 AND status <> 'rejetee' AND id <> $2`, [poNumber, cur && cur.id ? cur.id : '00000000-0000-0000-0000-000000000000']);
  const approved = round2(others.filter(o => o.status === 'approuvee').reduce((s, o) => s + n0(o.subtotal), 0));
  const pending = round2(others.filter(o => o.status !== 'approuvee').reduce((s, o) => s + n0(o.subtotal), 0));

  let monday_ = [], mondayTotal = 0, dupInMonday = null;
  if (po.source === 'monday' && po.mondayInvoiceIds.length) {
    try {
      const list = await monday.fetchMondayInvoices(po.mondayInvoiceIds);
      // Une facture Monday déjà reprise dans Finance (même n°) n'est pas comptée deux fois :
      // c'est la version Finance qui compte si elle est approuvée, ou la facture en cours de traitement.
      const thisNum = cur && cur.invoice_number ? normInvoiceNumber(cur.invoice_number) : '';
      const finCounted = new Set(others.filter(o => o.status === 'approuvee').map(o => normInvoiceNumber(o.invoice_number)));
      if (thisNum) finCounted.add(thisNum);
      list.forEach(x => {
        const excluded = /refus|annul/i.test(x.status || '');
        const same = !!x.number && finCounted.has(normInvoiceNumber(x.number));
        if (same) dupInMonday = x;
        monday_.push(Object.assign({}, x, { counted: !excluded && !same, same }));
      });
      mondayTotal = round2(monday_.filter(x => x.counted).reduce((s, x) => s + x.subtotal, 0));
    } catch (e) {
      console.error("poBudget Monday invoices", e && e.stack);
      mondayTotal = po.billedFromMirror || 0; // repli : somme du miroir « Total payables »
    }
  }
  const thisSub = cur && cur.subtotal != null ? n0(cur.subtotal) : 0;
  const after = round2(mondayTotal + approved + thisSub);
  const remaining = round2(po.subtotal - after);
  return {
    source: po.source, number: po.number, status: po.status, poSubtotal: po.subtotal, poTotal: po.total,
    budgetLabel: po.budgetLabel || '', glExpense: po.glExpense || '', activityCode: po.activityCode || '',
    mondayInvoiced: mondayTotal, mondayInvoices: monday_, financeApproved: approved, financePending: pending,
    thisSubtotal: thisSub, afterApproval: after, remaining, over: remaining < -0.005, overBy: remaining < -0.005 ? round2(-remaining) : 0,
    duplicateInMonday: dupInMonday ? { name: dupInMonday.name, number: dupInMonday.number } : null
  };
}

function matchSupplier(name, suppliers) {
  const n = normName(name);
  if (!n) return null;
  const exact = suppliers.filter(s => normName(s.name) === n);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  if (n.length >= 6) {
    const part = suppliers.filter(s => { const k = normName(s.name); return k.length >= 6 && (k.includes(n) || n.includes(k)); });
    if (part.length === 1) return part[0];
  }
  return null;
}

/** Remplit projet / fournisseur / bon de commande à partir de ce que Claude a lu. Meilleur effort, jamais bloquant. */
async function autoMatch(ocr) {
  const res = { project: null, supplier: null, po: null, poNumber: null, glExpense: '', activityCode: '' };
  let projects = [], suppliers = [];
  try { projects = await monday.fetchProjects(false); } catch (e) { console.error('autoMatch projets', e && e.message); }
  try { suppliers = await monday.fetchSuppliers(false); } catch (e) { console.error('autoMatch fournisseurs', e && e.message); }

  const parsed = parsePoNumber(ocr.po_number) || parsePoNumber(ocr.project_hint);
  if (parsed) {
    res.poNumber = parsed.poNumber;
    try { res.po = await findPo(parsed.poNumber); } catch (e) { console.error('autoMatch bon de commande', e && e.message); }
    if (res.po) {
      // Le bon de commande (Finance ou Monday) est lié à son projet et à son fournisseur : source la plus fiable
      res.project = projects.find(p => String(p.id) === String(res.po.projectItemId)) || null;
      if (res.po.supplierItemId) res.supplier = suppliers.find(s => String(s.id) === String(res.po.supplierItemId)) || null;
      res.glExpense = res.po.glExpense || '';
      res.activityCode = res.po.activityCode || '';
    }
    if (!res.project) res.project = projectByNumber(projects, parsed.projectNumber); // repli : n° de projet = début du n° de bon (25113)
  }
  if (!res.supplier) res.supplier = matchSupplier(ocr.supplier_name, suppliers);
  return res;
}

const cpEmailsOf = p => p ? p.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean).join(',') : null;

/**
 * Relance le rapprochement pour une facture « à valider » dont des champs sont vides (projet, fournisseur,
 * G/L, code d'activité, lien au bon de commande). Ne touche jamais à un champ déjà rempli. Retourne true si modifié.
 */
async function rematch(r) {
  if (r.status !== 'a_valider') return false;
  const parsed = parsePoNumber(r.po_number);
  if (!parsed) return false;
  if (r.project_item_id && r.supplier_id && r.gl_expense && r.activity_code && r.po_source && r.po_number === parsed.poNumber) return false;
  const m = await autoMatch({ po_number: r.po_number, supplier_name: r.supplier_name });
  const sets = [], vals = [r.id];
  const set = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
  if (r.po_number !== parsed.poNumber) set('po_number', parsed.poNumber);
  if (m.po) { set('po_source', m.po.source); set('po_item_id', m.po.itemId || null); set('po_id', m.po.poId || null); }
  if (!r.project_item_id && m.project) {
    set('project_item_id', m.project.id); set('project_number', m.project.number); set('project_name', m.project.name);
    set('project_avantage', m.project.numberAvantage || null); set('cp_emails', cpEmailsOf(m.project));
  }
  if (!r.supplier_id && m.supplier) { set('supplier_id', m.supplier.id); set('supplier_name', m.supplier.name); set('supplier_avantage_id', m.supplier.avantageId || null); }
  if (!r.gl_expense && m.glExpense) set('gl_expense', m.glExpense);
  if (!r.activity_code && m.activityCode) set('activity_code', m.activityCode);
  if (!sets.length) return false;
  await q('UPDATE fin_invoice SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1', vals);
  return true;
}

// ---------- Lecture automatique (Claude) ----------------------------------------------------------------

const EXTRACT_TOOL = {
  name: 'enregistrer_facture',
  description: "Enregistre les données lues sur une facture de fournisseur.",
  input_schema: {
    type: 'object',
    properties: {
      supplier_name: { type: 'string', description: "Nom du fournisseur qui ÉMET la facture (jamais le client)." },
      invoice_number: { type: 'string', description: 'Numéro de la facture.' },
      invoice_date: { type: 'string', description: 'Date de la facture, format AAAA-MM-JJ.' },
      due_date: { type: 'string', description: "Date d'échéance AAAA-MM-JJ, vide si absente." },
      po_number: { type: 'string', description: "Numéro de bon de commande / « No. Commande » cité sur la facture, tel qu'écrit (ex. BC-25113-044). Vide si absent." },
      project_hint: { type: 'string', description: 'Nom ou numéro de projet / chantier mentionné sur la facture. Vide si absent.' },
      billed_to: { type: 'string', description: 'Client facturé tel qu\'écrit sur la facture.' },
      subtotal: { type: 'number', description: 'Total avant taxes.' },
      tps: { type: 'number', description: 'Montant de TPS (ou TVH). 0 si absente.' },
      tvq: { type: 'number', description: 'Montant de TVQ. 0 si absente.' },
      total: { type: 'number', description: 'Total de la facture, taxes incluses.' },
      description: { type: 'string', description: 'Résumé très court (max 100 caractères) de ce qui est facturé.' },
      tps_number: { type: 'string', description: 'Numéro de TPS/TVH du fournisseur, si visible.' },
      tvq_number: { type: 'string', description: 'Numéro de TVQ du fournisseur, si visible.' },
      notes: { type: 'string', description: "Doutes, champs illisibles ou anomalies (ex. totaux incohérents). Vide si tout est clair." }
    },
    required: ['supplier_name', 'invoice_number', 'subtotal', 'tps', 'tvq', 'total']
  }
};

const SYSTEM_PROMPT = "Tu lis des factures de fournisseurs et de sous-traitants adressées à Les Entreprises Philippe Denis inc. (EPD), un entrepreneur général du Québec. " +
  "Extrais les données demandées en appelant l'outil. Le fournisseur est l'entreprise qui émet la facture, jamais EPD. " +
  "Les montants sont en dollars canadiens : nombres avec point décimal, sans symbole ni séparateur de milliers. TPS = 5 %, TVQ = 9,975 %. " +
  "Ne devine jamais : si une donnée n'est pas lisible, laisse la chaîne vide (ou 0 pour une taxe absente) et explique dans « notes ». " +
  "Dates au format AAAA-MM-JJ.";

function ocrConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

async function extractInvoice(bytes, contentType) {
  if (!ocrConfigured()) return { status: 'non_configure' };
  const ct = String(contentType || 'application/pdf').toLowerCase();
  const block = ct === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: ct, data: Buffer.from(bytes).toString('base64') } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.INVOICE_OCR_MODEL || 'claude-sonnet-5-5',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools: [EXTRACT_TOOL],
        // Pas de tool_choice forcé : certains modèles ne le permettent pas. Le texte demande l'appel de l'outil.
        messages: [{ role: 'user', content: [block, { type: 'text', text: "Lis cette facture, puis appelle l'outil « enregistrer_facture » avec ses données. N'écris rien d'autre." }] }]
      }),
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'echec', error: 'API Anthropic (' + r.status + ') : ' + ((j.error && j.error.message) || 'erreur') };
    const tu = (j.content || []).find(c => c.type === 'tool_use');
    if (tu && tu.input) return { status: 'ok', data: tu.input };
    // Repli : le modèle a répondu en texte (JSON) au lieu d'appeler l'outil
    const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const mj = txt.match(/\{[\s\S]*\}/);
    if (mj) { try { const d = JSON.parse(mj[0]); if (d && (d.invoice_number != null || d.total != null)) return { status: 'ok', data: d }; } catch (e) { /* ignoré */ } }
    return { status: 'echec', error: 'Aucune donnée extraite.' };
  } catch (e) {
    return { status: 'echec', error: e && e.name === 'AbortError' ? "Délai dépassé pendant la lecture de la facture." : String((e && e.message) || e).slice(0, 300) };
  } finally { clearTimeout(timer); }
}

// ---------- Ligne SQL <-> objet -------------------------------------------------------------------------

const NUM_COLS = ['subtotal', 'tps', 'tvq', 'total', 'retention_pct'];
const DATE_COLS = ['hold_until', 'invoice_date', 'account_date', 'due_date'];

function rowToInv(r) {
  if (!r) return null;
  const o = Object.assign({}, r);
  NUM_COLS.forEach(k => { if (k in o) o[k] = o[k] == null ? null : Number(o[k]); });
  DATE_COLS.forEach(k => { if (k in o) o[k] = isoDate(o[k]); });
  return o;
}

/** Factures « En attente » dont la date de retour est atteinte : retour automatique à « À approuver ». */
async function releaseExpiredHolds() {
  const rows = await q(`UPDATE fin_invoice SET status = 'a_approuver', cp_notified_at = NULL, updated_at = now()
      WHERE status = 'en_attente' AND hold_until IS NOT NULL AND hold_until <= (now() AT TIME ZONE 'America/Toronto')::date RETURNING id, hold_until`);
  for (const r of rows) await logEvent(r.id, 'attente_expiree', 'système', 'Date de retour atteinte : de nouveau à approuver');
  return rows.length;
}

async function logEvent(id, event, actor, detail) {
  try { await q('INSERT INTO fin_invoice_event (invoice_id, event, actor, detail) VALUES ($1,$2,$3,$4)', [id, event, actor || null, detail ? String(detail).slice(0, 500) : null]); }
  catch (e) { console.error('invoice logEvent', e && e.message); }
}

async function getFile(id) {
  const r = await q('SELECT filename, content_type, data_b64 FROM fin_invoice_file WHERE invoice_id = $1', [id]);
  return r[0] ? { filename: r[0].filename, contentType: r[0].content_type, bytes: Buffer.from(r[0].data_b64, 'base64') } : null;
}

/** Crée la facture + son fichier, lance la lecture automatique et le rapprochement. Retourne la ligne créée. */
async function ingest({ bytes, filename, contentType, source, createdBy, email }) {
  const ins = await q(`INSERT INTO fin_invoice (status, source, filename, content_type, created_by, email_from, email_subject, email_received, email_message_id)
                       VALUES ('a_valider',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [source || 'upload', filename, contentType, createdBy || null, email ? email.from : null, email ? email.subject : null, email ? email.received : null, email ? email.messageId : null]);
  const id = ins[0].id;
  await q('INSERT INTO fin_invoice_file (invoice_id, filename, content_type, data_b64) VALUES ($1,$2,$3,$4)', [id, filename, contentType, Buffer.from(bytes).toString('base64')]);
  await logEvent(id, 'recue', createdBy || (email && email.from) || 'systeme', source === 'courriel' ? ('Courriel : ' + (email && email.subject || '')) : filename);

  const ex = await extractInvoice(bytes, contentType);
  if (ex.status !== 'ok') {
    await q('UPDATE fin_invoice SET ocr_status = $2, ocr_error = $3, ocr_at = now(), updated_at = now() WHERE id = $1', [id, ex.status, ex.error || null]);
    await logEvent(id, ex.status === 'non_configure' ? 'ocr_non_configure' : 'ocr_echec', 'systeme', ex.error);
    return id;
  }
  const d = ex.data;
  let m = { project: null, supplier: null, po: null, poNumber: null };
  try { m = await autoMatch(d); } catch (e) { console.error('autoMatch', e && e.message); }

  const subtotal = num(d.subtotal), tps = num(d.tps), tvq = num(d.tvq);
  let total = num(d.total);
  const supplierName = m.supplier ? m.supplier.name : str(d.supplier_name, 200);
  await q(`UPDATE fin_invoice SET ocr_status = 'ok', ocr_error = NULL, ocr_raw = $2::jsonb, ocr_at = now(),
      supplier_id = $3, supplier_name = $4, supplier_avantage_id = $5,
      project_item_id = $6, project_number = $7, project_name = $8, project_avantage = $9, cp_emails = $10,
      po_number = $11, po_id = $12, po_item_id = $13, po_source = $14, gl_expense = $15, activity_code = $16,
      invoice_number = $17, invoice_date = $18, account_date = $18, due_date = $19,
      subtotal = $20, tps = $21, tvq = $22, total = $23, description = $24, updated_at = now()
    WHERE id = $1`,
    [id, JSON.stringify(d),
      m.supplier ? m.supplier.id : null, supplierName, m.supplier ? (m.supplier.avantageId || null) : null,
      m.project ? m.project.id : null, m.project ? m.project.number : null, m.project ? m.project.name : null, m.project ? (m.project.numberAvantage || null) : null,
      cpEmailsOf(m.project),
      m.poNumber || (str(d.po_number, 60) || null), m.po ? (m.po.poId || null) : null, m.po ? (m.po.itemId || null) : null, m.po ? m.po.source : null,
      m.glExpense || null, m.activityCode || null,
      str(d.invoice_number, 80) || null, isoDate(d.invoice_date), isoDate(d.due_date),
      subtotal, tps, tvq, total, cleanDescription(d.description) || null]);
  await logEvent(id, 'ocr_ok', 'systeme', [m.po ? 'bon de commande ' + m.poNumber + ' trouvé (' + (m.po.source === 'monday' ? 'Monday' : 'Finance') + ')' : (m.poNumber ? 'bon de commande ' + m.poNumber + ' introuvable' : 'aucun n° de bon de commande'), m.project ? 'projet ' + m.project.number : 'projet non trouvé', m.supplier ? 'fournisseur reconnu' : 'fournisseur à choisir'].join(' · '));
  return id;
}

// ---------- Copie SharePoint ----------------------------------------------------------------------------

async function pushToSharePoint(inv) {
  if (!sp.isConfigured()) {
    await q("UPDATE fin_invoice SET sharepoint_status = 'non_configure', sharepoint_error = NULL, updated_at = now() WHERE id = $1", [inv.id]);
    return { status: 'non_configure' };
  }
  await q("UPDATE fin_invoice SET sharepoint_status = 'attente', sharepoint_error = NULL WHERE id = $1", [inv.id]);
  try {
    const f = await getFile(inv.id);
    if (!f) throw new Error('Fichier de la facture introuvable.');
    const ext = /\.(pdf|png|jpe?g)$/i.test(f.filename) ? '.' + f.filename.split('.').pop().toLowerCase() : '.pdf';
    const out = await sp.uploadInvoice(inv, f.bytes, f.contentType, ext);
    await q("UPDATE fin_invoice SET sharepoint_status = 'reussi', sharepoint_url = $2, sharepoint_error = NULL, updated_at = now() WHERE id = $1", [inv.id, out.webUrl || null]);
    await logEvent(inv.id, 'sharepoint_ok', 'systeme', out.path);
    return { status: 'reussi', url: out.webUrl };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    await q("UPDATE fin_invoice SET sharepoint_status = 'echec', sharepoint_error = $2, updated_at = now() WHERE id = $1", [inv.id, msg]);
    await logEvent(inv.id, 'sharepoint_echec', 'systeme', msg);
    return { status: 'echec', error: msg };
  }
}

// ---------- Comptabilité (liste de courriels configurable) ----------------------------------------------

async function accountingEmails() {
  let raw = null;
  try { const r = await q("SELECT value FROM fin_settings WHERE key = 'accounting_emails'"); raw = r[0] ? r[0].value : null; } catch (e) { /* table absente : défaut */ }
  if (raw == null) raw = process.env.FINANCE_ACCOUNTING_EMAILS || DEFAULT_ACCOUNTING;
  return Array.from(new Set(String(raw).split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean)));
}

// ---------- Réception par courriel (Microsoft Graph) ----------------------------------------------------

function mailConfigured() {
  return !!(process.env.INVOICE_MAILBOX && process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

const ALLOWED_TYPES = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
const MAX_INGEST_BYTES = 4.3 * 1024 * 1024; // l'aperçu est servi par une fonction Vercel (réponse max. 4,5 Mo)

async function graph(token, path, opts) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, Object.assign({ headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, opts || {}));
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Graph (' + r.status + ') : ' + ((j.error && j.error.message) || 'erreur'));
  return j;
}

/** Lit la boîte : chaque pièce jointe PDF/image d'un courriel non lu devient une facture « à valider ». */
/** Mémorise le dernier passage (cron ou bouton) pour que la comptabilité voie si la lecture automatique tourne. */
async function recordPoll(out, via) {
  try {
    await q("INSERT INTO fin_settings (key, value, updated_by) VALUES ('invoice_mail_poll', $1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
      [JSON.stringify({ at: new Date().toISOString(), via: via || 'cron', messages: out.messages, created: out.created, skipped: out.skipped, unread: out.unread, errors: (out.errors || []).slice(0, 3) }), via || 'cron']);
  } catch (e) { /* facultatif */ }
}
async function lastPoll() {
  try { const r = await q("SELECT value FROM fin_settings WHERE key = 'invoice_mail_poll'"); return r[0] ? JSON.parse(r[0].value) : null; } catch (e) { return null; }
}

async function pollMailbox(maxMessages, via) {
  if (!mailConfigured()) return { configured: false, messages: 0, created: 0, skipped: 0, errors: [] };
  try { return await pollMailboxInner(maxMessages, via); }
  catch (e) { await recordPoll({ messages: 0, created: 0, skipped: 0, unread: null, errors: [String((e && e.message) || e)] }, via); throw e; }
}
async function pollMailboxInner(maxMessages, via) {
  const token = await sp.getToken();
  const box = encodeURIComponent(process.env.INVOICE_MAILBOX);
  // Graph refuse les filtres combinés avec un tri (« too complex ») : filtre simple, puis tri et sélection ici.
  const raw = await graph(token, '/users/' + box + '/mailFolders/inbox/messages?$filter=' + encodeURIComponent('isRead eq false') +
    '&$top=50&$select=id,subject,from,receivedDateTime,hasAttachments');
  const list = { value: (raw.value || []).filter(m => m.hasAttachments)
    .sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime))).slice(0, maxMessages || 10) };
  const out = { configured: true, messages: 0, created: 0, skipped: 0, errors: [], unread: (raw.value || []).length, unreadWithAttachments: (raw.value || []).filter(m => m.hasAttachments).length };
  for (const msg of (list.value || [])) {
    out.messages++;
    try {
      const atts = await graph(token, '/users/' + box + '/messages/' + encodeURIComponent(msg.id) + '/attachments?$top=20');
      const from = msg.from && msg.from.emailAddress ? (msg.from.emailAddress.address || '') : '';
      for (const a of (atts.value || [])) {
        const ct = String(a.contentType || '').toLowerCase();
        const isFile = a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes;
        const type = ALLOWED_TYPES[ct] ? ct : (/\.pdf$/i.test(a.name || '') ? 'application/pdf' : null);
        if (!isFile || !type || a.isInline) { out.skipped++; continue; }
        const bytes = Buffer.from(a.contentBytes, 'base64');
        if (bytes.length > MAX_INGEST_BYTES) { out.skipped++; out.errors.push((a.name || 'pièce jointe') + ' : plus de 4 Mo (à téléverser manuellement après compression)'); continue; }
        const dup = await q('SELECT 1 FROM fin_invoice WHERE email_message_id = $1 AND filename = $2', [msg.id, a.name || 'facture.pdf']);
        if (dup[0]) { out.skipped++; continue; }
        await ingest({ bytes, filename: a.name || 'facture.pdf', contentType: type, source: 'courriel', email: { from, subject: msg.subject || '', received: msg.receivedDateTime, messageId: msg.id } });
        out.created++;
      }
      await graph(token, '/users/' + box + '/messages/' + encodeURIComponent(msg.id), { method: 'PATCH', body: JSON.stringify({ isRead: true }) });
    } catch (e) {
      out.errors.push(String((e && e.message) || e).slice(0, 200));
    }
  }
  await recordPoll(out, via);
  return out;
}

module.exports = {
  lastPoll, releaseExpiredHolds,
  GL, TPS_RATE, TVQ_RATE, computeEntry, computeChecks, extractInvoice, ocrConfigured, autoMatch, rematch, findPo, poBudget, poInvoicesFor, cleanDescription, projectByNumber, ingest,
  rowToInv, logEvent, getFile, pushToSharePoint, accountingEmails, mailConfigured, pollMailbox,
  num, n0, str, isoDate, round2, normInvoiceNumber, normName, parsePoNumber, DEFAULT_ACCOUNTING
};
