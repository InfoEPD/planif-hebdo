// api/invoices.js
//
// Point d'entrée du module Finance — Étape B1 : factures fournisseurs.
//   POST { action, ... }  authentifié par Clerk (comme api/finance.js)
//   GET  ?cron=1&key=...  déclencheur externe : lit la boîte courriel des factures (INVOICE_CRON_SECRET)
//
// Parcours : reçue (téléversement ou courriel) -> lecture automatique (Claude) -> « à valider » (comptabilité)
//            -> « à approuver » (chargé de projet du projet) -> « approuvée » (copie SharePoint, prête pour Avantage).
//
// Règles d'accès (vérifiées côté serveur) :
//   - comptabilité (liste modifiable par l'administrateur + administrateurs) : toutes les factures, saisie / validation
//   - chargé de projet : factures VALIDÉES de ses projets (courriel reconnu dans Monday), approbation / refus
//   - un projet est OBLIGATOIRE pour valider, donc pour approuver

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const mail = require('./_lib/mail');
const inv = require('./_lib/invoice');
const mlive = require('./_lib/mlive');
const poLib = require('./_lib/po');
const pdfLib = require('./_lib/pdf');

const MAX_UPLOAD_BYTES = 3.2 * 1024 * 1024; // corps de requête Vercel 4,5 Mo (base64 = +33 %)
const UPLOAD_TYPES = { 'application/pdf': true, 'image/png': true, 'image/jpeg': true };

function baseUrl(req) {
  if (process.env.FINANCE_BASE_URL) return process.env.FINANCE_BASE_URL.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host;
}

function cpList(r) { return String(r.cp_emails || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }

async function who(user) {
  const acct = await inv.accountingEmails();
  return { isAccounting: user.isAdmin || acct.includes(user.email), accounting: acct };
}

async function loadInvoice(user, id, access) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw { status: 400, message: 'Identifiant invalide.' };
  const rows = await q('SELECT * FROM fin_invoice WHERE id = $1', [id]);
  if (!rows[0]) throw { status: 404, message: 'Facture introuvable.' };
  const r = inv.rowToInv(rows[0]);
  const w = await who(user);
  const isCp = cpList(r).includes(user.email);
  const canSee = w.isAccounting || r.status === 'a_determiner' || (isCp && r.status !== 'a_valider');
  if (!canSee) throw { status: 403, message: "Vous n'avez pas accès à cette facture." };
  if (access === 'accounting' && !w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
  return { r, w, isCp };
}

function summary(r) {
  return {
    id: r.id, status: r.status, source: r.source, supplier_name: r.supplier_name, project_number: r.project_number, project_name: r.project_name,
    invoice_number: r.invoice_number, invoice_date: r.invoice_date, total: r.total, retention_pct: r.retention_pct, po_number: r.po_number,
    created_at: r.created_at, ocr_status: r.ocr_status, sharepoint_status: r.sharepoint_status, avantage_status: r.avantage_status, filename: r.filename,
    hold_until: r.hold_until || null, hold_note: r.hold_note || null, legacy: !!r.legacy, monday_url: r.monday_url || null, has_project: !!r.project_item_id, account_date: r.account_date, avantage_account: r.avantage_account, subtotal: r.subtotal
  };
}

async function duplicatesOf(r) {
  if (!r.invoice_number || !(r.supplier_id || r.supplier_name)) return [];
  const rows = await q(`SELECT id, status, invoice_number, supplier_name, total, invoice_date FROM fin_invoice
      WHERE id <> $1 AND status <> 'rejetee'
        AND regexp_replace(upper(coalesce(invoice_number,'')), '[^A-Z0-9]', '', 'g') = $2
        AND ((supplier_id IS NOT NULL AND supplier_id = $3) OR lower(coalesce(supplier_name,'')) = lower($4))`,
    [r.id, inv.normInvoiceNumber(r.invoice_number), r.supplier_id || '', r.supplier_name || '']);
  return rows.map(x => ({ id: x.id, status: x.status, invoice_number: x.invoice_number, total: x.total == null ? null : Number(x.total), invoice_date: inv.isoDate(x.invoice_date) }));
}

function detail(r, perms, events, dups) {
  const entry = inv.computeEntry(r);
  const out = Object.assign({}, r);
  delete out.ocr_raw;
  out.entry = entry;
  out.checks = inv.computeChecks(r);
  out.duplicates = dups || [];
  out.events = events || [];
  out.perms = perms;
  return out;
}

/** Applique les champs envoyés par le formulaire de la comptabilité. */
async function applyFields(r, b) {
  const sets = [], vals = [r.id];
  const set = (col, v) => {
    const i = sets.findIndex(x => x.startsWith(col + ' = '));
    if (i >= 0) { const n = Number(sets[i].split('$')[1]); vals[n - 1] = v; return; }
    vals.push(v); sets.push(col + ' = $' + vals.length);
  };
  const amount = (key, col, label) => {
    if (!(key in b)) return;
    if (b[key] === '' || b[key] == null) { set(col, null); return; }
    const n = inv.num(b[key]);
    if (n == null || Math.abs(n) > 99999999) throw { status: 400, message: label + ' invalide.' };
    set(col, inv.round2(n));
  };
  const date = (key, col, label) => {
    if (!(key in b)) return;
    if (!b[key]) { set(col, null); return; }
    const d = inv.isoDate(b[key]);
    if (!d) throw { status: 400, message: label + ' invalide (AAAA-MM-JJ).' };
    set(col, d);
  };

  if ('supplierId' in b && String(b.supplierId || '') !== String(r.supplier_id || '')) {
    if (!b.supplierId) { set('supplier_id', null); set('supplier_avantage_id', null); }
    else {
      const s = await monday.fetchSupplier(b.supplierId);
      set('supplier_id', s.id); set('supplier_name', s.name); set('supplier_avantage_id', s.avantageId || null);
    }
  } else if ('supplierName' in b && !r.supplier_id) set('supplier_name', inv.str(b.supplierName, 200) || null);

  if ('projectItemId' in b && String(b.projectItemId || '') !== String(r.project_item_id || '')) {
    if (!b.projectItemId) {
      set('project_item_id', null); set('project_number', null); set('project_name', null); set('project_avantage', null); set('cp_emails', null);
    } else {
      const p = await monday.fetchProject(b.projectItemId);
      set('project_item_id', p.id); set('project_number', p.number); set('project_name', p.name); set('project_avantage', p.numberAvantage || null);
      set('cp_emails', p.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean).join(',') || null);
    }
  }

  if ('poNumber' in b) {
    const raw = inv.str(b.poNumber, 60);
    const parsed = inv.parsePoNumber(raw);
    const num = parsed ? parsed.poNumber : raw;
    set('po_number', num || null);
    let po = null;
    if (num && num !== r.po_number) { try { po = await inv.findPo(num); } catch (e) { console.error('findPo', e && e.message); } }
    else if (num) { po = { source: r.po_source, itemId: r.po_item_id, poId: r.po_id }; }
    set('po_id', po && po.poId ? po.poId : null);
    set('po_item_id', po && po.itemId ? po.itemId : null);
    set('po_source', po && po.source ? po.source : null);
    // Projet déduit du n° de bon de commande (25113-044 -> projet 25113) si la comptabilité n'en a pas choisi
    if (parsed && !('projectItemId' in b && b.projectItemId) && !r.project_item_id) {
      try {
        const p = inv.projectByNumber(await monday.fetchProjects(), parsed.projectNumber);
        if (p) {
          set('project_item_id', p.id); set('project_number', p.number); set('project_name', p.name); set('project_avantage', p.numberAvantage || null);
          set('cp_emails', p.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean).join(',') || null);
        }
      } catch (e) { console.error('projectByNumber', e && e.message); }
    }
  }
  if ('invoiceNumber' in b) set('invoice_number', inv.str(b.invoiceNumber, 80) || null);
  date('invoiceDate', 'invoice_date', 'Date de facture');
  date('accountDate', 'account_date', 'Date comptable');
  date('dueDate', 'due_date', "Date d'échéance");
  amount('subtotal', 'subtotal', 'Sous-total');
  amount('tps', 'tps', 'TPS');
  amount('tvq', 'tvq', 'TVQ');
  amount('total', 'total', 'Total');
  if ('retentionPct' in b) {
    if (b.retentionPct === '' || b.retentionPct == null) set('retention_pct', null);
    else {
      const n = inv.num(b.retentionPct);
      if (n == null || n < 0 || n > 100) throw { status: 400, message: 'Retenue invalide (0 à 100 %).' };
      set('retention_pct', inv.round2(n));
    }
  }
  if ('glExpense' in b) set('gl_expense', inv.str(b.glExpense, 20) || null);
  if ('activityCode' in b) {
    const code = inv.str(b.activityCode, 20) || null;
    set('activity_code', code);
    // Le compte G/L de la dépense découle du code d'activité (poste budgétaire Monday)
    if (code) {
      let items = null;
      try { items = await monday.fetchBudgetItems(); } catch (e) { items = null; }
      if (items) {
        const it = items.find(x => String(x.code).trim() === code);
        if (!it) throw { status: 400, message: "Code d'activité inconnu : choisissez-le dans la liste." };
        if (it.gl) set('gl_expense', it.gl);
      }
    }
  }
  if ('description' in b) set('description', inv.cleanDescription(b.description) || null);
  if ('comment' in b) set('comment', inv.str(b.comment, 600) || null);

  if (!sets.length) return;
  await q('UPDATE fin_invoice SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1', vals);
}

async function reload(id) {
  const rows = await q('SELECT * FROM fin_invoice WHERE id = $1', [id]);
  return inv.rowToInv(rows[0]);
}

function permsFor(r, w, isCp, user) {
  return {
    isAccounting: w.isAccounting,
    canEdit: w.isAccounting && r.status === 'a_valider',
    canRecall: w.isAccounting && r.status === 'a_approuver',
    canReject: w.isAccounting && r.status === 'a_valider',
    canDelete: w.isAccounting && ['a_valider', 'a_determiner', 'rejetee'].includes(r.status),
    canReopen: w.isAccounting && r.status === 'rejetee',
    canApprove: (isCp || user.isAdmin) && r.status === 'a_approuver',
    canHold: (isCp || w.isAccounting) && r.status === 'a_approuver',
    canRelease: (isCp || w.isAccounting) && r.status === 'en_attente',
    canDetermine: w.isAccounting && r.status === 'a_valider',
    canAssign: r.status === 'a_determiner',
    canTakeBack: w.isAccounting && r.status === 'a_determiner',
    canRetrySharepoint: w.isAccounting && r.status === 'approuvee' && r.sharepoint_status !== 'reussi',
    canRetryAvantage: w.isAccounting && r.status === 'approuvee' && (r.avantage_status === 'echec' || r.avantage_status === 'en_cours'),
    canFixAvantage: w.isAccounting && r.status === 'approuvee' && r.avantage_status === 'echec'
  };
}

/** Lien Monday vers le bon de commande (bons créés dans Monday seulement) — nécessite MONDAY_BASE_URL (ex. https://epd.monday.com). */
function poMondayUrl(r, budget) {
  const base = String(process.env.MONDAY_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !r.po_item_id || !(budget ? budget.source === 'monday' : r.po_source === 'monday')) return null;
  return base + '/boards/' + monday.PO_BOARD + '/pulses/' + r.po_item_id;
}

/** PDF du bon de commande lié : version signée si elle existe, sinon le PDF à jour. */
async function poPdfFor(r) {
  let poId = r.po_id;
  if (!poId && r.po_number) { const f = await inv.findPo(r.po_number); if (f && f.poId) poId = f.poId; }
  if (!poId) throw { status: 404, message: "Ce bon de commande n'a pas de PDF dans Finance." + (r.po_source === 'monday' ? ' Il a été créé dans Monday.' : '') };
  const signed = await poLib.getFile(poId, 'signed');
  if (signed) return { filename: signed.filename, bytes: signed.bytes };
  const rows = await q('SELECT * FROM fin_po WHERE id = $1', [poId]);
  if (!rows[0]) throw { status: 404, message: 'Bon de commande introuvable.' };
  const po = poLib.rowToPo(rows[0]);
  const rev = await q("SELECT count(*)::int AS n FROM fin_po_event WHERE po_id = $1 AND event = 'rouvert'", [poId]);
  po.revision = rev[0] ? rev[0].n : 0;
  const quote = await poLib.getFile(poId, 'quote');
  const bytes = await pdfLib.buildPoPdf(Object.assign({}, po), { quoteBytes: quote ? quote.bytes : null });
  return { filename: poLib.safeFilename(po), bytes: Buffer.from(bytes) };
}

/** Champs obligatoires pour sortir de « à valider » (et pour qu'un projet déterminé puisse partir à l'approbation). */
function missingFields(cur) {
  const miss = [];
  if (!cur.supplier_name) miss.push('le fournisseur');
  if (!cur.project_item_id) miss.push('le projet');
  if (!cur.invoice_number) miss.push('le numéro de facture');
  if (!cur.invoice_date) miss.push('la date de facture');
  if (!cur.activity_code) miss.push("le code d'activité");
  else if (!cur.gl_expense) miss.push("le compte G/L (aucun compte associé à ce code d'activité)");
  if (cur.subtotal == null) miss.push('le sous-total');
  if (cur.total == null) miss.push('le total');
  return miss;
}

const ACTIONS = {
  async me(user) {
    const w = await who(user);
    return {
      email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting,
      ocr: inv.ocrConfigured(), mailbox: inv.mailConfigured(), tps: inv.TPS_RATE, tvq: inv.TVQ_RATE,
      lastPoll: w.isAccounting ? await inv.lastPoll() : null
    };
  },

  async list(user) {
    try { await inv.releaseExpiredHolds(); } catch (e) { console.error('releaseExpiredHolds', e && e.message); }
    const w = await who(user);
    let rows;
    if (w.isAccounting) rows = await q('SELECT * FROM fin_invoice WHERE ' + mlive.NOT_LEGACY_PENDING + ' ORDER BY created_at DESC LIMIT 600');
    else rows = await q("SELECT * FROM fin_invoice WHERE " + mlive.NOT_LEGACY_PENDING + " AND (status = 'a_determiner' OR (status <> 'a_valider' AND $1 = ANY(string_to_array(coalesce(cp_emails,''), ',')))) ORDER BY created_at DESC LIMIT 600", [user.email]);
    return { invoices: rows.map(x => summary(inv.rowToInv(x))), isAccounting: w.isAccounting };
  },

  async get(user, b) {
    let { r, w, isCp } = await loadInvoice(user, b.id);
    if (w.isAccounting && r.status === 'a_valider') {
      try { if (await inv.rematch(r)) r = await reload(r.id); } catch (e) { console.error('rematch', e && e.message); }
    }
    const ev = await q('SELECT at, event, actor, detail FROM fin_invoice_event WHERE invoice_id = $1 ORDER BY at ASC, id ASC', [r.id]);
    const dups = w.isAccounting ? await duplicatesOf(r) : [];
    let budget = null;
    if (r.po_number) { try { budget = await inv.poBudget(r.po_number, r); } catch (e) { console.error('poBudget', e && e.message); } }
    const out = detail(r, permsFor(r, w, isCp, user), ev, dups);
    out.budget = budget;
    out.poInvoices = [];
    if (r.po_number) { try { out.poInvoices = await inv.poInvoicesFor(r.po_number, r.id, w.isAccounting); } catch (e) { console.error('poInvoices', e && e.message); } }
    out.poHasPdf = !!(r.po_id) || !!(budget && budget.source === 'finance');
    out.poMondayUrl = poMondayUrl(r, budget);
    return { invoice: out };
  },

  /** Suivi du bon de commande en direct (le formulaire envoie le n° de BC et le sous-total en cours de saisie). */
  /** Liste des codes d'activité (postes budgétaires Monday) avec le compte G/L associé. */
  async activityCodes(user, b) {
    await who(user);
    const items = await monday.fetchBudgetItems(!!(b && b.refresh));
    return { codes: items.filter(x => String(x.code || '').trim()).map(x => ({ code: String(x.code).trim(), name: x.name, gl: x.gl || '', glLabel: x.glLabel || '' })) };
  },

  async poInfo(user, b) {
    const { r } = await loadInvoice(user, b.id);
    const parsed = inv.parsePoNumber(b.poNumber);
    if (!parsed) return { budget: null, project: null };
    const sub = b.subtotal === '' || b.subtotal == null ? r.subtotal : inv.num(b.subtotal);
    const budget = await inv.poBudget(parsed.poNumber, Object.assign({}, r, { subtotal: sub }));
    let project = null;
    try { const p = inv.projectByNumber(await monday.fetchProjects(), parsed.projectNumber); if (p) project = { id: p.id, number: p.number, name: p.name }; } catch (e) {}
    let poInvoices = [];
    try { const w = await who(user); poInvoices = await inv.poInvoicesFor(parsed.poNumber, r.id, w.isAccounting); } catch (e) {}
    return { poNumber: parsed.poNumber, budget, project, poInvoices, poHasPdf: !!(budget && budget.source === 'finance'), poMondayUrl: poMondayUrl(r, budget) };
  },

  /** Vue par bon de commande : valeur des factures liées vs montant du bon. */
  async poSummary(user, b) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    const rows = await q(`SELECT po_number,
        count(*)::int AS n,
        coalesce(sum(subtotal) FILTER (WHERE status = 'approuvee'), 0) AS approved,
        coalesce(sum(subtotal) FILTER (WHERE status IN ('a_valider','a_approuver','en_attente')), 0) AS pending,
        max(project_number) AS project_number, max(supplier_name) AS supplier_name
      FROM fin_invoice WHERE po_number IS NOT NULL AND po_number <> '' AND status <> 'rejetee'
      GROUP BY po_number ORDER BY max(updated_at) DESC LIMIT 80`);
    const out = [];
    for (let i = 0; i < rows.length; i += 6) {
      const part = await Promise.all(rows.slice(i, i + 6).map(async x => {
        let bud = null;
        try { bud = await inv.poBudget(x.po_number, null); } catch (e) {}
        return {
          poNumber: x.po_number, projectNumber: x.project_number, supplier: x.supplier_name, invoices: x.n,
          poSubtotal: bud ? bud.poSubtotal : null, mondayInvoiced: bud ? bud.mondayInvoiced : null,
          financeApproved: bud ? bud.financeApproved : Number(x.approved), financePending: bud ? bud.financePending : Number(x.pending),
          remaining: bud ? bud.remaining : null, over: bud ? bud.over : false, known: !!bud
        };
      }));
      out.push.apply(out, part);
    }
    return { pos: out };
  },

  async projects(user, b) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    const list = await monday.fetchProjects(!!(b && b.refresh));
    return { projects: list.map(p => ({ id: p.id, name: p.name, number: p.number, status: p.status, avantage: p.numberAvantage, cp: p.cp.map(c => c.name) })) };
  },

  async suppliers(user, b) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    const list = await monday.fetchSuppliers(!!(b && b.refresh));
    return { suppliers: list.map(s => ({ id: s.id, name: s.name, avantageId: s.avantageId, active: s.active, blacklisted: s.blacklisted })) };
  },

  async upload(user, b, req) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    const contentType = String(b.contentType || '').toLowerCase();
    if (!UPLOAD_TYPES[contentType]) throw { status: 400, message: 'Format accepté : PDF, PNG ou JPG.' };
    const bytes = Buffer.from(String(b.dataBase64 || ''), 'base64');
    if (bytes.length < 100) throw { status: 400, message: 'Fichier vide ou illisible.' };
    if (bytes.length > MAX_UPLOAD_BYTES) throw { status: 413, message: 'Le fichier dépasse 3,2 Mo. Compressez-le avant de le téléverser.' };
    if (contentType === 'application/pdf' && bytes.slice(0, 5).toString('latin1') !== '%PDF-') throw { status: 400, message: 'Le fichier doit être un PDF.' };
    const filename = inv.str(b.filename, 200).replace(/[\\/:*?"<>|]+/g, ' ') || 'facture.pdf';
    const id = await inv.ingest({ bytes, filename, contentType, source: 'upload', createdBy: user.email });
    return { id };
  },

  async save(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'a_valider') throw { status: 409, message: 'Cette facture a déjà été validée : rappelez-la pour la modifier.' };
    await applyFields(r, b);
    return { ok: true };
  },

  async validate(user, b, req) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'a_valider') throw { status: 409, message: 'Cette facture a déjà été validée.' };
    await applyFields(r, b);
    let cur = await reload(r.id);

    const miss = missingFields(cur);
    if (miss.length) throw { status: 400, message: 'Il manque : ' + miss.join(', ') + '. Ces champs sont obligatoires pour envoyer la facture au chargé de projet.' };

    const dups = await duplicatesOf(cur);
    if (dups.length && !b.confirmDuplicate) throw { status: 409, code: 'duplicate', message: 'DOUBLON POSSIBLE : une facture « ' + cur.invoice_number + ' » existe déjà pour ce fournisseur.' };

    // Les chargés de projet viennent toujours de Monday (source d'autorité), relus à la validation.
    let proj = null;
    try { proj = await monday.fetchProject(cur.project_item_id); } catch (e) { throw { status: 502, message: 'Impossible de relire le projet dans Monday : ' + (e.message || e) }; }
    const cps = proj.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean);
    await q('UPDATE fin_invoice SET project_number = $2, project_name = $3, project_avantage = $4, cp_emails = $5, account_date = COALESCE(account_date, invoice_date) WHERE id = $1',
      [cur.id, proj.number, proj.name, proj.numberAvantage || null, cps.join(',') || null]);
    cur = await reload(cur.id);

    const upd = await q(`UPDATE fin_invoice SET status = 'a_approuver', cp_notified_at = NULL, acct_user = $2, acct_at = now(), reject_note = NULL, updated_at = now()
                          WHERE id = $1 AND status = 'a_valider' RETURNING id`, [cur.id, user.email]);
    if (!upd[0]) throw { status: 409, message: 'La facture vient de changer de statut. Actualisez.' };
    const checks = inv.computeChecks(cur);
    await inv.logEvent(cur.id, 'validee', user.email, checks.length ? checks.length + ' écart(s) signalé(s) : ' + checks.map(c => c.code).join(', ') : null);

    const notified = []; // l'avis au chargé de projet est maintenant un courriel récapitulatif quotidien (13 h)
    return { ok: true, notified, warning: cps.length ? null : "Aucun chargé de projet (ou courriel manquant) pour ce projet dans Monday : seul un administrateur peut approuver." };
  },

  async recall(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'a_approuver') throw { status: 409, message: "Seule une facture en attente d'approbation peut être rappelée." };
    await q("UPDATE fin_invoice SET status = 'a_valider', updated_at = now() WHERE id = $1 AND status = 'a_approuver'", [r.id]);
    await inv.logEvent(r.id, 'rappelee', user.email, null);
    return { ok: true };
  },

  async reject(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'a_valider') throw { status: 409, message: 'Seule une facture « à valider » peut être rejetée.' };
    const reason = inv.str(b.reason, 400);
    if (!reason) throw { status: 400, message: 'Indiquez le motif du rejet.' };
    await q("UPDATE fin_invoice SET status = 'rejetee', reject_note = $2, updated_at = now() WHERE id = $1", [r.id, reason]);
    await inv.logEvent(r.id, 'rejetee', user.email, reason);
    return { ok: true };
  },

  /** Suppression complète (fichier, historique, fiche) : seulement tant que la facture n'a pas été envoyée au chargé de projet. */
  async remove(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (!['a_valider', 'a_determiner', 'rejetee'].includes(r.status)) throw { status: 409, message: "Cette facture a déjà été envoyée au chargé de projet : elle ne peut plus être supprimée. Utilisez « Rappeler pour correction » puis supprimez-la." };
    console.log('Facture supprimée', r.id, r.supplier_name || '', r.invoice_number || '', 'par', user.email);
    await q('DELETE FROM fin_invoice_file WHERE invoice_id = $1', [r.id]);
    await q('DELETE FROM fin_invoice_event WHERE invoice_id = $1', [r.id]);
    await q('DELETE FROM fin_invoice WHERE id = $1', [r.id]);
    return { ok: true };
  },

  async reopen(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'rejetee') throw { status: 409, message: "Cette facture n'est pas rejetée." };
    await q("UPDATE fin_invoice SET status = 'a_valider', updated_at = now() WHERE id = $1", [r.id]);
    await inv.logEvent(r.id, 'reouverte', user.email, null);
    return { ok: true };
  },

  async approve(user, b, req) {
    const { r, isCp } = await loadInvoice(user, b.id);
    if (!(isCp || user.isAdmin)) throw { status: 403, message: "Seul le chargé de projet de ce projet peut approuver cette facture." };
    if (r.status !== 'a_approuver') throw { status: 409, message: "Cette facture n'est pas en attente d'approbation." };
    if (!r.project_item_id) throw { status: 400, message: 'Aucun projet associé : la facture ne peut pas être approuvée.' };
    if (r.po_number && !b.confirmOver) {
      let bud = null;
      try { bud = await inv.poBudget(r.po_number, r); } catch (e) { console.error('poBudget', e && e.message); }
      if (bud && bud.over) throw { status: 409, code: 'over_budget', message: 'Cette facture fait dépasser le bon de commande ' + r.po_number + ' de ' + bud.overBy.toFixed(2) + ' $ (avant taxes).' };
    }
    const upd = await q(`UPDATE fin_invoice SET status = 'approuvee', cp_user = $2, cp_at = now(), cp_comment = $3, avantage_status = 'en_attente', updated_at = now()
                          WHERE id = $1 AND status = 'a_approuver' RETURNING id`, [r.id, user.email, inv.str(b.comment, 500) || null]);
    if (!upd[0]) throw { status: 409, message: 'La facture vient de changer de statut. Actualisez.' };
    await inv.logEvent(r.id, 'approuvee', user.email, (b.confirmOver ? '[Dépassement du BC confirmé] ' : '') + (inv.str(b.comment, 300) || ''));
    const cur = await reload(r.id);
    const sp = await inv.pushToSharePoint(cur);
    return { ok: true, sharepoint: sp.status };
  },

  /** Met une facture « À approuver » en attente jusqu'à une date : elle revient seule à « À approuver » ensuite. */
  async hold(user, b) {
    const { r, w, isCp } = await loadInvoice(user, b.id);
    if (!(isCp || w.isAccounting)) throw { status: 403, message: "Seul le chargé de projet ou la comptabilité peut mettre cette facture en attente." };
    if (r.status !== 'a_approuver') throw { status: 409, message: "Seule une facture « À approuver » peut être mise en attente." };
    const until = inv.isoDate(b.until);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
    if (!until || until <= today) throw { status: 400, message: "Choisissez une date de retour future." };
    const note = inv.str(b.note, 500) || null;
    const upd = await q("UPDATE fin_invoice SET status = 'en_attente', hold_until = $2, hold_note = $3, hold_by = $4, hold_at = now(), updated_at = now() WHERE id = $1 AND status = 'a_approuver' RETURNING id", [r.id, until, note, user.email]);
    if (!upd[0]) throw { status: 409, message: 'La facture vient de changer de statut. Actualisez.' };
    await inv.logEvent(r.id, 'mise_en_attente', user.email, 'Jusqu\'au ' + until + (note ? ' — ' + note : ''));
    return { ok: true };
  },

  /** Retour manuel à « À approuver » avant la date prévue. */
  async release(user, b) {
    const { r, w, isCp } = await loadInvoice(user, b.id);
    if (!(isCp || w.isAccounting)) throw { status: 403, message: 'Action non permise.' };
    if (r.status !== 'en_attente') throw { status: 409, message: "Cette facture n'est pas en attente." };
    await q("UPDATE fin_invoice SET status = 'a_approuver', cp_notified_at = NULL, updated_at = now() WHERE id = $1 AND status = 'en_attente'", [r.id]);
    await inv.logEvent(r.id, 'attente_levee', user.email, null);
    return { ok: true };
  },

  async refuse(user, b, req) {
    const { r, isCp } = await loadInvoice(user, b.id);
    if (!(isCp || user.isAdmin)) throw { status: 403, message: "Seul le chargé de projet de ce projet peut refuser cette facture." };
    if (r.status !== 'a_approuver') throw { status: 409, message: "Cette facture n'est pas en attente d'approbation." };
    const comment = inv.str(b.comment, 500);
    if (!comment) throw { status: 400, message: 'Indiquez le motif du refus.' };
    await q("UPDATE fin_invoice SET status = 'a_valider', reject_note = $2, updated_at = now() WHERE id = $1 AND status = 'a_approuver'", [r.id, 'Refusée par ' + (user.name || user.email) + ' : ' + comment]);
    await inv.logEvent(r.id, 'refusee', user.email, comment);
    try {
      const acct = await inv.accountingEmails();
      if (acct.length) {
        const m = mail.invoiceRefusedMail({ inv: r, by: user.name || user.email, comment, url: baseUrl(req) + '/factures' });
        await mail.sendMail({ to: acct.join(', '), replyTo: user.email, subject: m.subject, html: m.html, text: m.text });
      }
    } catch (e) { console.error('avis refus', e && e.message); }
    return { ok: true };
  },


  // ---- Facture à déterminer : la comptabilité ne sait pas à quel projet va la facture ; tout le monde peut la classer ----
  async toDetermine(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'a_valider') throw { status: 409, message: 'Seule une facture « à valider » peut être classée « à déterminer ».' };
    await applyFields(r, b);
    const note = inv.str(b.note, 300);
    await q("UPDATE fin_invoice SET status = 'a_determiner', reject_note = NULL, updated_at = now() WHERE id = $1 AND status = 'a_valider'", [r.id]);
    await inv.logEvent(r.id, 'a_determiner', user.email, note || null);
    return { ok: true };
  },

  async takeBack(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'a_determiner') throw { status: 409, message: "Cette facture n'est pas « à déterminer »." };
    await q("UPDATE fin_invoice SET status = 'a_valider', updated_at = now() WHERE id = $1 AND status = 'a_determiner'", [r.id]);
    await inv.logEvent(r.id, 'reprise', user.email, null);
    return { ok: true };
  },

  /** Liste des projets pour choisir le projet d'une facture « à déterminer » (ouvert à tous les utilisateurs de Finance). */
  async projectsForAssign(user, b) {
    const list = await monday.fetchProjects(!!(b && b.refresh));
    return { projects: list.map(p => ({ id: p.id, name: p.name, number: p.number, status: p.status, avantage: p.numberAvantage, cp: p.cp.map(c => c.name) })) };
  },

  async assignProject(user, b, req) {
    const { r } = await loadInvoice(user, b.id);
    if (r.status !== 'a_determiner') throw { status: 409, message: "Cette facture n'est plus « à déterminer » : actualisez." };
    if (!b.projectItemId) throw { status: 400, message: 'Choisissez le projet.' };
    let proj;
    try { proj = await monday.fetchProject(b.projectItemId); } catch (e) { throw { status: 502, message: 'Projet introuvable dans Monday : ' + (e.message || e) }; }
    const cps = proj.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean);
    await q('UPDATE fin_invoice SET project_item_id = $2, project_number = $3, project_name = $4, project_avantage = $5, cp_emails = $6, account_date = COALESCE(account_date, invoice_date), updated_at = now() WHERE id = $1',
      [r.id, proj.id, proj.number, proj.name, proj.numberAvantage || null, cps.join(',') || null]);
    let cur = await reload(r.id);
    const miss = missingFields(cur);
    const who_ = user.name || user.email;
    if (miss.length) {
      // Il manque des informations : retour à la comptabilité, qui complète puis valide.
      await q("UPDATE fin_invoice SET status = 'a_valider', reject_note = $2, updated_at = now() WHERE id = $1 AND status = 'a_determiner'",
        [r.id, 'Projet ' + proj.number + ' déterminé par ' + who_ + '. À compléter : ' + miss.join(', ') + '.']);
      await inv.logEvent(r.id, 'projet_determine', user.email, 'Projet ' + proj.number + ' — retour à la comptabilité (manque : ' + miss.join(', ') + ')');
      try {
        const acct = await inv.accountingEmails();
        if (acct.length) await mail.sendMail({ to: acct.join(', '), replyTo: user.email, subject: 'Facture ' + (cur.invoice_number || '') + ' — projet déterminé (' + proj.number + ')', text: who_ + ' a choisi le projet ' + proj.number + ' — ' + proj.name + ' pour la facture ' + (cur.invoice_number || '') + ' de ' + (cur.supplier_name || '') + '. Il manque encore : ' + miss.join(', ') + '.\n' + baseUrl(req) + '/factures', html: '<p>' + who_ + ' a choisi le projet <b>' + proj.number + ' — ' + proj.name + '</b> pour la facture ' + (cur.invoice_number || '') + ' de ' + (cur.supplier_name || '') + '.</p><p>Il manque encore : ' + miss.join(', ') + '.</p><p><a href="' + baseUrl(req) + '/factures">Ouvrir Finance</a></p>' });
      } catch (e) { console.error('avis projet déterminé', e && e.message); }
      return { ok: true, status: 'a_valider', message: 'Projet enregistré. Il manque encore : ' + miss.join(', ') + ' — la facture retourne à la comptabilité.' };
    }
    await q("UPDATE fin_invoice SET status = 'a_approuver', cp_notified_at = NULL, acct_user = COALESCE(acct_user, $2), acct_at = COALESCE(acct_at, now()), reject_note = NULL, updated_at = now() WHERE id = $1 AND status = 'a_determiner'", [r.id, user.email]);
    await inv.logEvent(r.id, 'projet_determine', user.email, 'Projet ' + proj.number + ' — envoyée au chargé de projet');
    cur = await reload(r.id);
    const notified = []; // l'avis au chargé de projet est maintenant un courriel récapitulatif quotidien (13 h)
    return { ok: true, status: 'a_approuver', notified, message: 'Projet enregistré : la facture est maintenant à approuver par le chargé de projet' + ' (le chargé de projet sera avisé dans le récapitulatif de 13 h).' };
  },

  // ---- Mois fermé dans Avantage : changer la date comptable de plusieurs factures d'un coup ----
  async batchAccountDate(user, b) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    const date = inv.isoDate(b.date);
    if (!date) throw { status: 400, message: 'Date invalide (AAAA-MM-JJ).' };
    const ids = Array.from(new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^[0-9a-f-]{36}$/i.test(x)))).slice(0, 200);
    if (!ids.length) throw { status: 400, message: 'Aucune facture sélectionnée.' };
    const rows = await q(`UPDATE fin_invoice SET account_date = $2, updated_at = now() WHERE id = ANY($1::uuid[])
        AND (status IN ('a_valider','a_approuver','a_determiner') OR (status = 'approuvee' AND avantage_status IN ('en_attente','echec')))
        RETURNING id, invoice_number`, [ids, date]);
    for (const x of rows) await inv.logEvent(x.id, 'date_comptable', user.email, 'Nouvelle date comptable : ' + date);
    return { ok: true, updated: rows.length, skipped: ids.length - rows.length };
  },

  async sharepointRetry(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'approuvee') throw { status: 409, message: "La facture n'est pas approuvée." };
    return inv.pushToSharePoint(r);
  },

  /** Facture en erreur d'export Avantage : la comptabilité corrige les champs dans Exacto.
   *  Montants (sous-total, taxes, total, retenue) inchangés → pas de nouvelle approbation : on peut la renvoyer à Avantage directement.
   *  Montants modifiés → la facture retourne « À approuver » (confirmation exigée). */
  async avantageFix(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'approuvee' || r.avantage_status !== 'echec') throw { status: 409, message: "Seule une facture en erreur d'export Avantage peut être corrigée ici." };
    const pairs = [['subtotal', 'subtotal', 'sous-total'], ['tps', 'tps', 'TPS'], ['tvq', 'tvq', 'TVQ'], ['total', 'total', 'total'], ['retentionPct', 'retention_pct', 'retenue']];
    const changed = [];
    pairs.forEach(([key, col, label]) => {
      if (!(key in b)) return;
      const nv = (b[key] === '' || b[key] == null) ? null : inv.num(b[key]);
      const ov = r[col] == null ? null : Number(r[col]);
      if ((nv == null) !== (ov == null) || (nv != null && Math.abs(nv - ov) > 0.004)) changed.push(label);
    });
    if (changed.length && !b.confirmReapprove) throw { status: 409, code: 'needs_reapproval', message: 'Ces montants ont changé (' + changed.join(', ') + ') : la facture retournera à l\u2019approbation du chargé de projet avant d\u2019être renvoyée à Avantage.' };
    await applyFields(r, b);
    await refreshProjectSnapshot(await reload(r.id));
    const cur = await reload(r.id);
    const miss = missingFields(cur);
    if (miss.length) throw { status: 400, message: 'Il manque : ' + miss.join(', ') + '.' };
    if (changed.length) {
      await q(`UPDATE fin_invoice SET status = 'a_approuver', cp_notified_at = NULL, cp_user = NULL, cp_at = NULL, cp_comment = NULL,
          avantage_status = NULL, avantage_result = NULL, avantage_claimed_at = NULL, updated_at = now() WHERE id = $1 AND status = 'approuvee'`, [r.id]);
      await inv.logEvent(r.id, 'modifiee_reapprobation', user.email, 'Montants modifiés : ' + changed.join(', '));
      return { ok: true, status: 'a_approuver', message: 'Montants modifiés : la facture est retournée à l\u2019approbation du chargé de projet.' };
    }
    await inv.logEvent(r.id, 'modifiee_avantage', user.email, "Champs corrigés après erreur d'export (montants inchangés)");
    if (b.resend) {
      await q("UPDATE fin_invoice SET avantage_status = 'en_attente', avantage_claimed_at = NULL, avantage_result = NULL, updated_at = now() WHERE id = $1 AND status = 'approuvee' AND avantage_status = 'echec'", [r.id]);
      await inv.logEvent(r.id, 'avantage_renvoi', user.email, null);
    }
    return { ok: true, status: 'approuvee', resent: !!b.resend, message: b.resend ? 'Corrigée et remise en attente : le pont la reprendra.' : 'Corrections enregistrées.' };
  },

  /** Remet une facture « en attente » pour le pont (échec, ou envoi resté « en cours »). */
  async avantageRetry(user, b) {
    const { r } = await loadInvoice(user, b.id, 'accounting');
    if (r.status !== 'approuvee') throw { status: 409, message: "La facture n'est pas approuvée." };
    if (r.avantage_status === 'reussi') throw { status: 409, message: 'Cette facture est déjà dans Avantage.' };
    if (r.avantage_status === 'en_cours' && !b.confirmCheckedAvantage) throw { status: 409, code: 'check_avantage', message: "L'envoi est resté « en cours » : la facture est peut-être DÉJÀ dans Avantage. Vérifiez dans Avantage (comptes fournisseurs) avant de renvoyer, sinon elle serait inscrite en double." };
    await refreshProjectSnapshot(r);
    await q("UPDATE fin_invoice SET avantage_status = 'en_attente', avantage_claimed_at = NULL, avantage_result = NULL, updated_at = now() WHERE id = $1", [r.id]);
    await inv.logEvent(r.id, 'avantage_renvoi', user.email, null);
    return { ok: true };
  },

  async settingsGet(user) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    return { accountingEmails: w.accounting, canEdit: user.isAdmin, mailbox: process.env.INVOICE_MAILBOX || '', mailboxConfigured: inv.mailConfigured(), ocrConfigured: inv.ocrConfigured() };
  },

  async settingsSave(user, b) {
    if (!user.isAdmin) throw { status: 403, message: "Réservé aux administrateurs." };
    const list = Array.from(new Set((Array.isArray(b.accountingEmails) ? b.accountingEmails : String(b.accountingEmails || '').split(/[\s,;]+/))
      .map(s => String(s).trim().toLowerCase()).filter(Boolean)));
    if (!list.length) throw { status: 400, message: 'Indiquez au moins un courriel.' };
    const bad = list.find(e => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e));
    if (bad) throw { status: 400, message: 'Courriel invalide : ' + bad };
    await q(`INSERT INTO fin_settings (key, value, updated_by) VALUES ('accounting_emails', $1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [list.join(','), user.email]);
    return { ok: true, accountingEmails: list };
  },

  /** Utilisateurs et profils (administrateur seulement). Les chargés de projets sont reconnus automatiquement via Monday. */
  async rolesGet(user) {
    if (!user.isAdmin) throw { status: 403, message: "Réservé aux administrateurs." };
    const auth = require('./_lib/auth');
    auth.resetAdminCache();
    return { admins: await auth.dbAdminEmails(), envAdmins: auth.adminEmails(), accounting: (await who(user)).accounting, me: user.email };
  },
  async rolesSave(user, b) {
    if (!user.isAdmin) throw { status: 403, message: "Réservé aux administrateurs." };
    const auth = require('./_lib/auth');
    const list = Array.from(new Set((Array.isArray(b.admins) ? b.admins : String(b.admins || '').split(/[\s,;]+/)).map(s => String(s).trim().toLowerCase()).filter(Boolean)));
    const bad = list.find(e => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e));
    if (bad) throw { status: 400, message: 'Courriel invalide : ' + bad };
    const finalSet = new Set(auth.adminEmails().concat(list));
    if (!finalSet.has(user.email)) throw { status: 400, message: "Vous ne pouvez pas vous retirer vous-même des administrateurs (ajoutez votre courriel ou demandez à un autre administrateur)." };
    await q(`INSERT INTO fin_settings (key, value, updated_by) VALUES ('admin_emails', $1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [list.join(','), user.email]);
    auth.resetAdminCache();
    return { ok: true, admins: list };
  },

  async accessGet(user) { if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' }; return require('./_lib/modaccess').get(user); },
  async accessSave(user, b) { if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' }; return require('./_lib/modaccess').save(user, b); },
  async accessImport(user) { if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' }; return require('./_lib/modaccess').importClerk(); },
  async accessCreateLogin(user, b) { if (!user.isAdmin) throw { status: 403, message: 'Réservé aux administrateurs.' }; return require('./_lib/modaccess').createLogin(user, b); },

  async pollNow(user) {
    const w = await who(user);
    if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité.' };
    return inv.pollMailbox(10, w.isAdmin ? 'manuel' : 'manuel');
  }
};


// ---------- Exacto-Bridge (service Windows sur le serveur Avantage) ----------------------------------------
// Authentification par clé secrète (EXACTO_BRIDGE_KEY), jamais par compte Clerk. Le pont ne fait que des
// appels SORTANTS vers Finance : il demande les factures approuvées, les envoie à Avantage (MainTCP, W01/PYB)
// puis rapporte « reussi » ou « echec ». Une facture prise en charge n'est JAMAIS renvoyée automatiquement
// (risque de double écriture comptable) : seul un clic de la comptabilité la remet « en attente ».

/** Relit le projet (n° Avantage, n°, nom) : la facture n'en garde qu'une copie prise à la validation — si le n° Avantage a été ajouté ensuite à la fiche du projet, la copie est périmée. */
async function refreshProjectSnapshot(row) {
  if (!row || !row.project_item_id) return row;
  try {
    const p = await monday.fetchProject(row.project_item_id);
    const av = p.numberAvantage || null;
    if (av !== (row.project_avantage || null) || (p.number && p.number !== row.project_number) || (p.name && p.name !== row.project_name)) {
      await q('UPDATE fin_invoice SET project_avantage = $2, project_number = COALESCE($3, project_number), project_name = COALESCE($4, project_name), updated_at = now() WHERE id = $1', [row.id, av, p.number || null, p.name || null]);
      row = Object.assign({}, row, { project_avantage: av, project_number: p.number || row.project_number, project_name: p.name || row.project_name });
    }
  } catch (e) { console.error('refreshProjectSnapshot', e && e.message); }
  return row;
}

function bridgeAuth(req) {
  const key = process.env.EXACTO_BRIDGE_KEY || process.env.AVANTAGE_BRIDGE_KEY || '';
  const given = String(req.headers['x-bridge-key'] || '');
  const a = Buffer.from(key), b = Buffer.from(given);
  if (!key || a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) throw { status: 401, message: 'Clé du pont invalide.' };
}

function bridgePayload(r) {
  const entry = inv.computeEntry(r);
  return {
    id: r.id, invoiceNumber: r.invoice_number, supplierName: r.supplier_name, supplierAvantageId: r.supplier_avantage_id || '',
    projectNumber: r.project_number, projectAvantage: r.project_avantage || '', poNumber: r.po_number || '',
    accountDate: r.account_date || r.invoice_date, invoiceDate: r.invoice_date, dueDate: r.due_date || null,
    description: inv.cleanDescription(r.description || ''), activityCode: r.activity_code || '', glExpense: r.gl_expense || '',
    subtotal: r.subtotal, tps: r.tps, tvq: r.tvq, total: entry.total,
    retentionPct: entry.retention_pct, retention: entry.retention, net: entry.net,
    lines: entry.lines.filter(l => l.amount !== 0).map(l => ({ description: l.description, poste: l.poste, amount: l.amount })),
    credits: entry.credits, balanced: entry.balanced
  };
}

const BRIDGE_ACTIONS = {
  /** Lecture seule : factures en attente (mode simulation, aucun changement d'état). */
  async bridgePeek(b) {
    const rows = await q("SELECT * FROM fin_invoice WHERE status = 'approuvee' AND avantage_status = 'en_attente' ORDER BY cp_at ASC LIMIT $1", [Math.min(Math.max(parseInt(b.limit, 10) || 10, 1), 25)]);
    const fresh = []; for (const x of rows) fresh.push(await refreshProjectSnapshot(x));
    return { invoices: fresh.map(x => bridgePayload(inv.rowToInv(x))) };
  },

  /** Prend en charge les factures en attente : elles passent « en_cours » et ne seront plus proposées. */
  async bridgeClaim(b) {
    const lim = Math.min(Math.max(parseInt(b.limit, 10) || 5, 1), 10);
    const rows = await q(`UPDATE fin_invoice SET avantage_status = 'en_cours', avantage_claimed_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM fin_invoice WHERE status = 'approuvee' AND avantage_status = 'en_attente' ORDER BY cp_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING *`, [lim]);
    const fresh = [];
    for (const x of rows) { await inv.logEvent(x.id, 'avantage_pris', 'Exacto-Bridge', null); fresh.push(await refreshProjectSnapshot(x)); }
    return { invoices: fresh.map(x => bridgePayload(inv.rowToInv(x))) };
  },

  /** Résultat de l'envoi à Avantage. */
  async bridgeReport(b) {
    if (!/^[0-9a-f-]{36}$/i.test(String(b.id || ''))) throw { status: 400, message: 'Identifiant invalide.' };
    const ok = b.status === 'reussi';
    if (!ok && b.status !== 'echec') throw { status: 400, message: 'Statut invalide (reussi | echec).' };
    const upd = await q(`UPDATE fin_invoice SET avantage_status = $2, avantage_result = $3, avantage_account = $4, avantage_request = $5,
        avantage_sent_at = now(), updated_at = now() WHERE id = $1 AND avantage_status = 'en_cours' RETURNING id`,
      [b.id, ok ? 'reussi' : 'echec', inv.str(b.result, 600) || null, ok ? (inv.str(b.account, 40) || null) : null, inv.str(b.request, 4000) || null]);
    if (!upd[0]) throw { status: 409, message: "Cette facture n'est pas en cours d'envoi." };
    await inv.logEvent(b.id, ok ? 'avantage_ok' : 'avantage_echec', 'Exacto-Bridge', ok ? 'Compte ' + (b.account || '') : inv.str(b.result, 300));
    return { ok: true };
  },

  async bridgePing() { return { ok: true, at: new Date().toISOString() }; },

  /** Synchronisation des fournisseurs d'Avantage (FOURNI.DBF) — lot de fournisseurs nouveaux ou modifiés. */
  async bridgeSuppliers(b) { return require('./_lib/supplier-sync').upsertBatch(b.records); },
  /** Liste complète des numéros présents dans Avantage (marque « retiré » les absents). */
  /** Le pont consulte (et consomme) une demande de synchronisation manuelle. */
  async bridgeSyncClaim() {
    const { q } = require('./_lib/db');
    const r = await q("DELETE FROM fin_settings WHERE key = 'avantage_sup_sync_request' RETURNING value");
    return { requested: !!r[0] };
  },
  async bridgeSuppliersPresent(b) { return require('./_lib/supplier-sync').markPresent(b.present); }
};

/** Courriel récapitulatif aux chargés de projet : factures en attente d'approbation (envoyé seulement s'il y a au moins une NOUVELLE facture). */
async function sendApprovalDigest(req) {
  const rows = await q(`SELECT id, invoice_number, invoice_date, supplier_name, subtotal, project_number, project_name, cp_emails, cp_notified_at, created_at
      FROM fin_invoice WHERE status = 'a_approuver' AND NOT (legacy IS TRUE) AND cp_emails IS NOT NULL AND cp_emails <> ''
      ORDER BY project_number, invoice_date NULLS LAST, created_at`);
  const byCp = new Map();
  rows.forEach(r => String(r.cp_emails).split(',').map(x => x.trim().toLowerCase()).filter(Boolean).forEach(e => { if (!byCp.has(e)) byCp.set(e, []); byCp.get(e).push(r); }));
  const url = baseUrl(req) + '/factures';
  const sent = [], skipped = [];
  for (const [email, list] of byCp) {
    if (!list.some(r => !r.cp_notified_at)) { skipped.push(email); continue; }
    try {
      const m = mail.invoiceDigestMail({ invoices: list, url });
      await mail.sendMail({ to: email, subject: m.subject, html: m.html, text: m.text });
      sent.push(email);
    } catch (e) { console.error('récapitulatif CP', email, e && e.message); }
  }
  const sentSet = new Set(sent);
  const ids = rows.filter(r => !r.cp_notified_at && String(r.cp_emails).split(',').some(e => sentSet.has(e.trim().toLowerCase()))).map(r => r.id);
  if (ids.length) await q('UPDATE fin_invoice SET cp_notified_at = now() WHERE id = ANY($1::uuid[])', [ids]);
  return { ok: true, sent, skipped, invoicesMarked: ids.length };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Déclencheur externe (cron-job.org, etc.) : lecture de la boîte courriel des factures
  if (req.method === 'GET') {
    const secret = process.env.INVOICE_CRON_SECRET;
    const key = String((req.query && req.query.key) || req.headers['x-cron-secret'] || '');
    if (!secret || key !== secret) { res.status(401).json({ error: 'Non autorisé.' }); return; }
    if (String((req.query && req.query.suppliers) || '') === '1') {   // rappels de conformité des fournisseurs (inactif tant que non activé dans Finance)
      try { res.status(200).json(await require('./_lib/supplier-reminders').runAuto()); }
      catch (e) { console.error('cron suppliers', e); res.status(500).json({ error: String((e && e.message) || e) }); }
      return;
    }
    if (String((req.query && req.query.digest) || '') === '1') {
      try {
        // Garde-fou : un seul récapitulatif par jour ouvrable, à partir de 13 h (Toronto), peu importe la fréquence du cron. &force=1 contourne.
        if (String(req.query.force || '') !== '1') {
          const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
          const g = k => (p.find(x => x.type === k) || {}).value;
          const day = g('year') + '-' + g('month') + '-' + g('day'), hour = parseInt(g('hour'), 10) % 24;
          if (/^(Sat|Sun)/.test(g('weekday'))) { res.status(200).json({ ok: true, skipped: 'fin de semaine' }); return; }
          if (hour < 13) { res.status(200).json({ ok: true, skipped: 'avant 13 h' }); return; }
          const last = await q("SELECT value FROM fin_settings WHERE key = 'digest_last_run'");
          let lv = last[0] && last[0].value; if (typeof lv === 'string') { try { lv = JSON.parse(lv); } catch (e) { lv = null; } }
          if (lv && lv.day === day) { res.status(200).json({ ok: true, skipped: 'déjà envoyé aujourd\'hui' }); return; }
          await q("INSERT INTO fin_settings (key, value, updated_by) VALUES ('digest_last_run', $1, 'système') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify({ day })]);
        }
        res.status(200).json(await sendApprovalDigest(req));
      }
      catch (e) { console.error('cron digest', e); res.status(500).json({ error: String((e && e.message) || e) }); }
      return;
    }
    if (String((req.query && req.query.relances) || '') === '1') {   // relances automatiques (forçage manuel : &force=1)
      try { res.status(200).json(await require('./_lib/relances').runAuto(String(req.query.force || '') === '1')); }
      catch (e) { console.error('cron relances', e); res.status(500).json({ error: String((e && e.message) || e) }); }
      return;
    }
    try { await inv.releaseExpiredHolds(); } catch (e) { console.error('holds', e && e.message); }
    try { await require('./_lib/relances').runAuto(false); } catch (e) { console.error('relances', e && e.message); }   // au plus 1 fois / jour
    try { res.status(200).json(await inv.pollMailbox(10, 'cron')); }
    catch (e) { console.error('cron invoices', e); res.status(500).json({ error: String((e && e.message) || e) }); }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  // Appels d'Exacto-Bridge (clé secrète, pas de compte Clerk)
  if (req.headers['x-bridge-key'] !== undefined) {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      bridgeAuth(req);
      const bf = BRIDGE_ACTIONS[b.action];
      if (!bf) throw { status: 400, message: 'Action inconnue.' };
      res.status(200).json(await bf(b));
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('bridge', b.action, e);
      res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
    }
    return;
  }
  let user;
  try { user = await requireUser(req); }
  catch (e) { res.status(e.status || 401).json({ error: e.message || 'Non authentifié.' }); return; }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Fichier de la facture : réponse binaire (aperçu / téléchargement)
  if (body.action === 'file') {
    try {
      const { r } = await loadInvoice(user, body.id);
      const f = await inv.getFile(r.id);
      if (!f) { res.status(404).json({ error: 'Fichier introuvable.' }); return; }
      res.setHeader('Content-Type', f.contentType);
      res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(f.filename) + '"');
      res.status(200).send(f.bytes);
    } catch (e) { res.status(e.status || 500).json({ error: (e && e.message) || 'Erreur serveur.' }); }
    return;
  }

  // PDF du bon de commande lié à la facture (aperçu pour l'approbateur)
  if (body.action === 'poFile') {
    try {
      const { r } = await loadInvoice(user, body.id);
      const f = await poPdfFor(r);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(f.filename) + '"');
      res.status(200).send(f.bytes);
    } catch (e) { res.status(e.status || 500).json({ error: (e && e.message) || 'Erreur serveur.' }); }
    return;
  }

  const fn = ACTIONS[body.action];
  if (!fn) { res.status(400).json({ error: 'Action inconnue.' }); return; }
  try {
    res.status(200).json(await fn(user, body, req));
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('invoices.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.', code: e && e.code });
  }
};
module.exports.ACTIONS = ACTIONS;
