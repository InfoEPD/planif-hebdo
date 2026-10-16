// api/changes.js
//
// Module « Demandes de changement » (DDC) / avis de changement de Finance.
//   POST { action, ... }  authentifié par Clerk. Accès : comptabilité + admins (tous les projets) ; chargé de projet (ses projets).
//
// Cycle : brouillon -> envoye -> (en_revision -> envoye ...) -> approuve (avis signé reçu) | refuse | annule.
// À l'approbation : copie du document signé dans SharePoint (Directives) + bons de commande brouillons aux sous-traitants.

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const mail = require('./_lib/mail');
const inv = require('./_lib/invoice');
const po = require('./_lib/po');
const sp = require('./_lib/sharepoint');
const pdf = require('./_lib/pdf');
const dash = require('./dashboard');
const DEFAULT_TERMS = require('./_lib/default-terms');
const { buildChangePdf, computeChange } = require('./_lib/cdpdf');

const isId = v => /^\d+$/.test(String(v || ''));
const isUuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const str = po.str;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const PRICE = ['augmentation', 'reduction', 'inchange', 'inconnu'];
const CHUNK_B64 = 2097152;            // taille d'un bloc base64 au téléchargement (multiple de 4)
const MAX_FILE = 20 * 1024 * 1024;
// Cycle (v2) : brouillon -> attente_prix (prix demandés aux sous-traitants) -> envoye -> en_revision -> attente_avenant (approuvée par les professionnels) -> avenant_recu.
// « approuve » = ancien statut (demandes déjà approuvées avant le nouveau flux) : traité comme approuvé.
const APPROVED = ['approuve', 'attente_avenant', 'avenant_recu'];
const LOCKED = APPROVED.concat(['refuse', 'annule']);
const isApproved = s => APPROVED.includes(s);

async function who(user) {
  const acct = await inv.accountingEmails();
  return { isAccounting: user.isAdmin || acct.includes(user.email) };
}
async function projectAccess(user, projectItemId) {
  if (!isId(projectItemId)) throw { status: 400, message: 'Projet invalide.' };
  const w = await who(user);
  const project = await monday.fetchProject(projectItemId);
  const isCp = project.cp.some(c => (c.email || '').toLowerCase() === user.email);
  if (!w.isAccounting && !isCp) throw { status: 403, message: "Vous n'avez pas accès à ce projet." };
  return { project, isAccounting: w.isAccounting, isCp };
}
async function loadChange(user, id) {
  if (!isUuid(id)) throw { status: 400, message: 'Identifiant invalide.' };
  const rows = await q('SELECT * FROM fin_change WHERE id = $1', [id]);
  if (!rows[0]) throw { status: 404, message: 'Demande de changement introuvable.' };
  const ctx = await projectAccess(user, rows[0].project_item_id);
  return Object.assign({ ch: rows[0] }, ctx);
}
async function logEvent(id, event, actor, detail) {
  await q('INSERT INTO fin_change_event (change_id, event, actor, detail) VALUES ($1,$2,$3,$4)', [id, event, actor || null, detail ? String(detail).slice(0, 4000) : null]);
}
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const safe = s => String(s || '').replace(/[\\/:*?"<>|#%~&{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
/** Nettoie un libellé pour un nom de fichier SharePoint : sans accents, seulement lettres/chiffres/espace/tiret/point/souligné. */
const spName = v => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 40).trim();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normLines(arr) {
  if (!Array.isArray(arr)) return [];
  if (arr.length > 60) throw { status: 400, message: 'Maximum 60 lignes.' };
  return arr.map((l, i) => {
    const name = str(l.name, 400);
    const qty = Math.round((Number(l.qty) || 0) * 1000) / 1000;
    const price = r2(l.price);
    const feePct = Math.min(100, Math.max(0, r2(l.feePct)));
    if (!name && !qty && !price) return null;
    if (!name) throw { status: 400, message: 'Ligne ' + (i + 1) + ' : la description est obligatoire.' };
    return { name, qty, price, feePct, activityCode: str(l.activityCode, 20), budgetItemId: isId(l.budgetItemId) ? String(l.budgetItemId) : '',
      activityLabel: str(l.activityLabel, 160), supplierItemId: isId(l.supplierItemId) ? String(l.supplierItemId) : '',
      supplierName: str(l.supplierName, 200), supplierEmail: str(l.supplierEmail, 200), quoteFileId: isUuid(l.quoteFileId) ? String(l.quoteFileId) : '' };
  }).filter(Boolean);
}
function applyTotals(row) {
  const c = computeChange(row.lines, row.insurance_pct, row.bond_pct);
  row.total_before_tax = r2(c.subtotal); row.tps = r2(c.tps); row.tvq = r2(c.tvq); row.total = r2(c.total);
  return c;
}
function parseRow(r) {
  const o = Object.assign({}, r);
  o.lines = Array.isArray(r.lines) ? r.lines : (typeof r.lines === 'string' ? JSON.parse(r.lines) : []);
  o.price_requests = Array.isArray(r.price_requests) ? r.price_requests : (typeof r.price_requests === 'string' ? JSON.parse(r.price_requests) : []);
  o.po_ids = Array.isArray(r.po_ids) ? r.po_ids : (typeof r.po_ids === 'string' ? JSON.parse(r.po_ids) : []);
  ['insurance_pct', 'bond_pct', 'total_before_tax', 'tps', 'tvq', 'total'].forEach(k => { o[k] = Number(r[k]) || 0; });
  return o;
}
const numOf = c => String((c && c.ddc_number) || '').trim() || ((c && c.legacy) ? (c.avc_number || '') : '');
async function nextAvc(projectItemId) {
  const r = await q('SELECT avc_number FROM fin_change WHERE project_item_id = $1', [projectItemId]);
  let max = 0;
  r.forEach(x => { const m = /^C(\d+)$/i.exec(x.avc_number || ''); if (m) max = Math.max(max, Number(m[1])); });
  return 'C' + String(max + 1).padStart(2, '0');
}
async function defaultTerms() {
  const r = await q("SELECT value FROM fin_settings WHERE key = 'terms_default'");
  return r[0] ? r[0].value : DEFAULT_TERMS;
}
async function fileBytes(id, changeId) {
  const r = await q('SELECT data_b64, filename FROM fin_change_file WHERE id = $1 AND change_id = $2', [id, changeId]);
  if (!r[0]) return null;
  return { bytes: Buffer.from(r[0].data_b64, 'base64'), filename: r[0].filename };
}

// ---------- Bons de commande brouillons ------------------------------------------------------------------

async function createDraftPos(user, ch, project) {
  const groups = new Map();
  const warnings = [];
  ch.lines.forEach(l => {
    const cost = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
    if (!l.supplierItemId && !l.supplierName) return;            // ligne sans sous-traitant : aucun bon
    if (!cost) return;
    if (!l.budgetItemId) { warnings.push('« ' + String(l.name).slice(0, 40) + " » : aucun code d'activité, bon non créé."); return; }
    const key = (l.supplierItemId || l.supplierName) + '|' + l.budgetItemId;
    if (!groups.has(key)) groups.set(key, { l, lines: [] });
    groups.get(key).lines.push({ name: l.name, qty: l.qty, price: l.price });
  });
  const pick = (arr, role) => { const x = (arr || [])[0]; return { role, name: x ? x.name : '', phone: x ? x.phone : '', email: x ? x.email : '' }; };
  const contacts = po.normalizeContacts([pick(project.cm, 'Contremaître'), pick(project.coordo, 'Coordonnateur'), pick(project.cp, 'Chargé de projet')]);
  const owner = po.normalizeOwner(project.owner);
  const terms = groups.size ? await defaultTerms() : '';
  const cpClean = project.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean).join(',');
  const created = [];
  for (const g of groups.values()) {
    try {
      let sup = null;
      if (g.l.supplierItemId) sup = await monday.fetchSupplier(g.l.supplierItemId);
      const supplierName = str(sup ? sup.name : g.l.supplierName, 200);
      const bud = await monday.fetchBudgetItem(g.l.budgetItemId);
      if (!bud.gl) { warnings.push(supplierName + ' : le poste « ' + bud.name + " » n'a pas de compte G/L, bon non créé."); continue; }
      const email = str(sup ? (sup.emails && sup.emails[0]) : g.l.supplierEmail, 200);
      const lines = po.normalizeLines(g.lines);
      const totals = pdf.computeTotals(lines);
      const cnt = await q(`INSERT INTO fin_po_counter (project_number, last_seq) VALUES ($1, $2 + 1)
          ON CONFLICT (project_number) DO UPDATE SET last_seq = GREATEST(fin_po_counter.last_seq, $2) + 1 RETURNING last_seq`, [project.number, project.maxPo || 0]);
      const seq = Number(cnt[0].last_seq);
      const poNumber = project.number + '-' + String(seq).padStart(3, '0');
      const info = 'Directive de changement ' + (numOf(ch) || ch.avc_number) + (ch.title ? ' — ' + ch.title : '');
      const ins = await q(`INSERT INTO fin_po (po_number, project_number, seq, doc_ref, status, project_item_id, project_name, cp_emails,
          supplier_item_id, supplier_name, supplier_email, supplier_phone, supplier_avantage_id,
          issuer_user_id, issuer_email, issuer_name, po_date, soumission_number, project_link, info_additional,
          contacts, owner, lines, subtotal, tps, tvq, total, retention_pct, terms_text,
          budget_item_id, budget_label, budget_code, gl_account, gl_label)
        VALUES ($1,$2,$3,$4,'brouillon',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
        RETURNING id`,
        [poNumber, project.number, seq, po.newDocRef(), project.id, project.name, cpClean,
          sup ? sup.id : null, supplierName, email || null, (sup && sup.phone) || null, sup ? (sup.avantageId || null) : null,
          user.userId, user.email, user.name, new Date().toISOString().slice(0, 10), str(numOf(ch) || ch.avc_number, 80), str(project.link, 400), str(info, 1500),
          JSON.stringify(contacts), JSON.stringify(owner), JSON.stringify(lines), totals.subtotal, totals.tps, totals.tvq, totals.total, 10, terms,
          bud.id, bud.name, bud.code || null, bud.gl, bud.glLabel || null]);
      await po.logEvent(ins[0].id, 'cree', user.email, null, poNumber + ' (directive ' + (numOf(ch) || ch.avc_number) + ')');
      await monday.setMaxPo(project.id, seq);
      created.push({ id: ins[0].id, po_number: poNumber, supplier: supplierName, subtotal: totals.subtotal });
    } catch (e) { warnings.push('Bon non créé pour ' + (g.l.supplierName || 'un sous-traitant') + ' : ' + ((e && e.message) || 'erreur')); }
  }
  return { created, warnings };
}


// ---------- Soumissions des sous-traitants jointes aux lignes de coût ---------------------------------------

/** Ajoute à la suite de l'avis les soumissions PDF rattachées aux lignes (quoteFileId) ; les autres formats partent en pièces jointes. */
async function withQuotes(bytes, row, changeId) {
  const quotes = [], extra = [];
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const lines = Array.isArray(row.lines) ? row.lines : [];
  const seen = new Set();
  // 1) Tous les documents déposés dans « Demande du professionnel » (ordre de dépôt), à la suite de l'avis
  const ddcFiles = await q("SELECT id FROM fin_change_file WHERE change_id = $1 AND kind = 'ddc' ORDER BY created_at", [changeId]);
  for (const d of ddcFiles) {
    if (seen.has(String(d.id))) continue;
    seen.add(String(d.id));
    const f = await fileBytes(d.id, changeId);
    if (!f) continue;
    if (/\.pdf$/i.test(f.filename)) quotes.push({ f, label: 'Demande du professionnel — ' + f.filename });
    else extra.push({ filename: f.filename, content: f.bytes });
  }
  // 2) Soumissions des sous-traitants rattachées aux lignes
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].quoteFileId;
    if (!isUuid(id) || seen.has(id)) continue;
    seen.add(id);
    const f = await fileBytes(id, changeId);
    if (!f) continue;
    if (/\.pdf$/i.test(f.filename)) quotes.push({ f, label: 'Soumission — ' + (lines[i].supplierName ? lines[i].supplierName + ' — ' : '') + lines[i].name });
    else extra.push({ filename: f.filename, content: f.bytes });
  }
  if (!quotes.length) return { bytes, extra };
  const out = await PDFDocument.load(bytes);
  const font = await out.embedFont(StandardFonts.Helvetica);
  for (const qt of quotes) {
    try {
      const src = await PDFDocument.load(qt.f.bytes, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((pg, k) => {
        out.addPage(pg);
        if (k === 0) {   // petite étiquette en haut de la première page de la soumission
          const clean = String(qt.label).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, ' ').slice(0, 110);
          const { height } = pg.getSize();
          pg.drawText(clean, { x: 28, y: height - 16, size: 8, font, color: rgb(0.3, 0.35, 0.45) });
        }
      });
    } catch (e) { extra.push({ filename: qt.f.filename, content: qt.f.bytes }); }
  }
  return { bytes: await out.save(), extra };
}

// ---------- SharePoint ------------------------------------------------------------------------------------

async function pushToSharePoint(ch) {
  if (!sp.isConfigured()) {
    await q("UPDATE fin_change SET sharepoint_status = 'non_configure', sharepoint_error = NULL, updated_at = now() WHERE id = $1", [ch.id]);
    return { status: 'non_configure' };
  }
  await q("UPDATE fin_change SET sharepoint_status = 'attente', sharepoint_error = NULL WHERE id = $1", [ch.id]);
  try {
    const f = await q("SELECT id, filename FROM fin_change_file WHERE change_id = $1 AND kind = 'signed' ORDER BY created_at DESC LIMIT 1", [ch.id]);
    if (!f[0]) throw new Error('Document signé introuvable.');
    const b = await fileBytes(f[0].id, ch.id);
    const ext = (/\.[A-Za-z0-9]{2,5}$/.exec(f[0].filename) || ['.pdf'])[0].toLowerCase();
    // Nom court et sûr pour SharePoint : « [N° de DDC] - Approuvé » (lettres, chiffres, espace, tiret; sans accents ni caractères spéciaux)
    const base = spName(ch.ddc_number) || spName(ch.avc_number) || 'DDC';
    const name = base + ' - Approuvé' + ext;
    const out = await sp.uploadDirective(ch, b.bytes, name);
    await q("UPDATE fin_change SET sharepoint_status = 'reussi', sharepoint_url = $2, sharepoint_error = NULL, updated_at = now() WHERE id = $1", [ch.id, (out && out.webUrl) || null]);
    await logEvent(ch.id, 'sharepoint_ok', 'systeme', out && out.path);
    return { status: 'reussi', url: out && out.webUrl, path: out && out.path };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    await q("UPDATE fin_change SET sharepoint_status = 'echec', sharepoint_error = $2, updated_at = now() WHERE id = $1", [ch.id, msg]);
    await logEvent(ch.id, 'sharepoint_echec', 'systeme', msg);
    return { status: 'echec', error: msg };
  }
}

// ---------- Actions ---------------------------------------------------------------------------------------

function distinctProjects(rows) {
  const m = new Map();
  rows.forEach(r => { if (r.project_item_id && !m.has(r.project_item_id)) m.set(r.project_item_id, { id: String(r.project_item_id), number: r.project_number, name: r.project_name || '' }); });
  return Array.from(m.values());
}

const ACTIONS = {
  async projects(user, b) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(!!(b && b.refresh))]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    return { me: { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting }, projects: mine.map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status, cp: p.cp.map(c => c.name) })) };
  },

  async list(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = await q(`SELECT id, legacy, monday_url, price_requests, avc_number, ddc_number, title, status, rev, issuer, received_date, affects_price, affects_delay, total, sent_at, approved_at, sharepoint_status, po_ids
        FROM fin_change WHERE project_item_id = $1 ORDER BY avc_number DESC`, [project.id]);
    return { project: { id: project.id, number: project.number, name: project.name, insurancePct: project.insurancePct, bondPct: project.bondPct },
      changes: rows.map(r => Object.assign({}, r, { total: Number(r.total) || 0, nPos: Array.isArray(r.po_ids) ? r.po_ids.length : 0, po_ids: undefined })) };
  },

  /** Tableau sommaire PDF des demandes de changement (à transmettre aux professionnels et au client). */
  async summary(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = await q(`SELECT legacy, avc_number, ddc_number, title, status, issuer, received_date, affects_price, affects_delay, extra_days, sent_at, approved_at, legacy
        FROM fin_change WHERE project_item_id = $1 AND status NOT IN ('brouillon','annule') ORDER BY avc_number`, [project.id]);
    if (!rows.length) throw { status: 400, message: "Aucune demande de changement envoyée à inclure dans le sommaire." };
    const d = v => v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '';
    const PR = { augmentation: 'Augmentation', reduction: 'Réduction', inchange: 'Sans impact', inconnu: 'À déterminer' };
    const items = rows.map(r => ({ avc: String(r.ddc_number || '').trim() || (r.legacy ? r.avc_number : ''), ddc: '', title: r.title || '', issuer: r.issuer || '', received: d(r.received_date), sent: d(r.sent_at), decided: d(r.approved_at),
      price: PR[r.affects_price] || '', delay: r.affects_delay === 'oui' ? (r.extra_days ? '+' + r.extra_days + ' j' : 'Oui') : (r.affects_delay === 'non' ? 'Non' : ''), status: r.status,
      st: ({ attente_prix: 'En attente de prix', envoye: 'Envoyé', en_revision: 'En révision', approuve: 'Approuvé', attente_avenant: "Approuvé — en attente de l'avenant", avenant_recu: 'Avenant reçu', refuse: 'Refusé' })[r.status] || r.status }));
    const ap = items.filter(i => isApproved(i.status)).length, rf = items.filter(i => i.status === 'refuse').length, pend = items.length - ap - rf;
    const bytes = await require('./_lib/sumpdf').buildGenericSummary({
      docTitle: 'Sommaire DDC', titleLines: ['Sommaire des demandes', 'de changement'], project: { number: project.number, name: project.name },
      headline: 'Avancement global : ' + (ap + rf) + ' traitée' + ((ap + rf) > 1 ? 's' : '') + ' sur ' + items.length + ' demande' + (items.length > 1 ? 's' : ''),
      subline: 'En attente : ' + pend + '   |   Approuvées : ' + ap + '   |   Refusées : ' + rf,
      groups: [{ name: "En attente d'approbation", items: items.filter(i => ['attente_prix', 'envoye', 'en_revision'].includes(i.status)) }, { name: 'Approuvées', items: items.filter(i => isApproved(i.status)) }, { name: 'Refusées', items: items.filter(i => i.status === 'refuse') }],
      cols: [{ k: 'avc', t: 'N° demande', w: 84, bold: true }, { k: 'title', t: 'Objet', w: 120 }, { k: 'issuer', t: 'Émetteur', w: 58 }, { k: 'received', t: 'Reçue', w: 60, date: true }, { k: 'sent', t: 'Envoyée', w: 60, date: true }, { k: 'price', t: 'Prix', w: 56 }, { k: 'delay', t: 'Délai', w: 34 }, { k: 'decided', t: 'Décision', w: 60, date: true }, { k: 'st', t: 'Statut', w: 56, status: true }],
      statusKey: 'status', good: ['approuve', 'attente_avenant', 'avenant_recu'], bad: ['refuse'], emptyText: 'Aucune demande de changement.' });
    return { pdfBase64: Buffer.from(bytes).toString('base64'), filename: 'Sommaire DDC - ' + String(project.number || '').replace(/[^\w.-]+/g, '_') + '.pdf' };
  },

  /** Toutes les demandes des projets accessibles (affichage « Par projets »). */
  async listAll(user) {
    const w = await who(user);
    // Comptabilité/admin : tout est lu dans Neon (aucun appel à Monday => affichage rapide). Chargé de projet : ses projets selon Monday.
    const mine = w.isAccounting ? null : (await monday.fetchProjectsLite(false)).filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    const ids = mine ? mine.map(p => String(p.id)) : [];
    const all = !mine;
    const rows = (all || ids.length) ? await q(`SELECT id, legacy, monday_url, price_requests, project_item_id, project_number, project_name, avc_number, ddc_number, title, status, rev, issuer, received_date, affects_price, affects_delay, total, sent_at, approved_at, sharepoint_status, po_ids
        FROM fin_change WHERE ($2::boolean OR project_item_id = ANY($1::text[])) ORDER BY project_number, avc_number DESC`, [ids, all]) : [];
    return { projects: mine ? mine.map(p => ({ id: String(p.id), number: p.number, name: p.name })) : distinctProjects(rows),
      changes: rows.map(r => Object.assign({}, r, { total: Number(r.total) || 0, nPos: Array.isArray(r.po_ids) ? r.po_ids.length : 0, po_ids: undefined })) };
  },

  async lookups() {
    const [items, sups] = await Promise.all([monday.fetchBudgetItems(), monday.fetchSuppliers()]);
    return {
      activities: items.filter(i => i.code).map(i => ({ id: i.id, code: i.code, name: i.name, gl: i.gl })),
      suppliers: sups.filter(s => !s.blacklisted).map(s => ({ id: s.id, name: s.name, email: (s.emails && s.emails[0]) || '' }))
    };
  },

  async create(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const iv = await dash.buildInterv(project).catch(() => null);
    const owner = iv && iv.owner ? iv.owner : { name: (project.owner && project.owner.name) || '', phone: '', email: (project.owner && project.owner.email) || '' };
    let avc = await nextAvc(project.id), id = null;
    for (let t = 0; t < 4 && !id; t++) {
      try {
        const r = await q(`INSERT INTO fin_change (project_item_id, project_number, project_name, avc_number, status, dest_name, dest_email, dest_phone, insurance_pct, bond_pct, received_date, created_by, updated_by)
          VALUES ($1,$2,$3,$4,'brouillon',$5,$6,$7,$8,$9,CURRENT_DATE,$10,$10) RETURNING id`,
          [project.id, project.number, project.name, avc, owner.name || null, owner.email || null, owner.phone || null, project.insurancePct || 0, project.bondPct || 0, user.email]);
        id = r[0].id;
      } catch (e) { if (!/duplicate|unique/i.test(String(e && e.message))) throw e; avc = await nextAvc(project.id); }
    }
    if (!id) throw { status: 409, message: 'Impossible de réserver un numéro. Réessayez.' };
    await logEvent(id, 'cree', user.email, avc);
    return { id, avc_number: avc };
  },

  async get(user, b) {
    const { ch, project } = await loadChange(user, b.id);
    const row = parseRow(ch);
    const [versions, files, events] = await Promise.all([
      q('SELECT id, rev, sent_at, sent_by, recipients, cc, subject, message, total, filename FROM fin_change_version WHERE change_id = $1 ORDER BY rev DESC, sent_at DESC', [ch.id]),
      q('SELECT id, kind, filename, size_bytes, note, uploaded_by, created_at FROM fin_change_file WHERE change_id = $1 ORDER BY created_at', [ch.id]),
      q('SELECT event, actor, detail, at FROM fin_change_event WHERE change_id = $1 ORDER BY at DESC, id DESC LIMIT 200', [ch.id])
    ]);
    applyTotals(row);
    return { change: row, versions, files, events, projectDefaults: { insurancePct: project.insurancePct, bondPct: project.bondPct }, sharepointConfigured: sp.isConfigured() };
  },

  async save(user, b) {
    const { ch } = await loadChange(user, b.id);
    if (LOCKED.includes(ch.status)) throw { status: 409, message: 'Cette demande est ' + ch.status + ' : elle ne peut plus être modifiée.' };
    const row = parseRow(ch);
    const f = b.fields || {};
    if ('ddcNumber' in f) row.ddc_number = str(f.ddcNumber, 60) || null;
    if ('title' in f) row.title = str(f.title, 200) || null;
    if ('changeType' in f) row.change_type = str(f.changeType, 80) || null;
    if ('issuer' in f) row.issuer = str(f.issuer, 120) || null;
    if ('receivedDate' in f) row.received_date = dateOrNull(f.receivedDate);
    if ('affectsPrice' in f) row.affects_price = PRICE.includes(f.affectsPrice) ? f.affectsPrice : null;
    if ('affectsDelay' in f) row.affects_delay = PRICE.includes(f.affectsDelay) ? f.affectsDelay : null;
    if ('extraDays' in f) { const n = parseInt(f.extraDays, 10); row.extra_days = isFinite(n) && n >= 0 && n < 5000 ? n : null; }
    if ('description' in f) row.description = String(f.description || '').replace(/\r/g, '').slice(0, 6000);
    if ('destName' in f) row.dest_name = str(f.destName, 160) || null;
    if ('destEmail' in f) row.dest_email = str(f.destEmail, 200) || null;
    if ('destPhone' in f) row.dest_phone = str(f.destPhone, 60) || null;
    if ('notesText' in f) row.notes_text = String(f.notesText || '').trim() ? String(f.notesText).replace(/\r/g, '').slice(0, 8000) : null;
    if ('insurancePct' in f) row.insurance_pct = Math.min(100, Math.max(0, Number(f.insurancePct) || 0));
    if ('bondPct' in f) row.bond_pct = Math.min(100, Math.max(0, Number(f.bondPct) || 0));
    if ('lines' in f) row.lines = normLines(f.lines);
    const c = applyTotals(row);
    await q(`UPDATE fin_change SET ddc_number=$2, title=$3, change_type=$4, issuer=$5, received_date=$6, affects_price=$7, affects_delay=$8, extra_days=$9, description=$10,
        dest_name=$11, dest_email=$12, dest_phone=$13, notes_text=$14, insurance_pct=$15, bond_pct=$16, lines=$17::jsonb, total_before_tax=$18, tps=$19, tvq=$20, total=$21,
        updated_by=$22, updated_at=now() WHERE id=$1`,
      [ch.id, row.ddc_number, row.title, row.change_type, row.issuer, row.received_date, row.affects_price, row.affects_delay, row.extra_days, row.description,
        row.dest_name, row.dest_email, row.dest_phone, row.notes_text, row.insurance_pct, row.bond_pct, JSON.stringify(row.lines), row.total_before_tax, row.tps, row.tvq, row.total, user.email]);
    return { ok: true, totals: { sumTotal: r2(c.sumTotal), ins: r2(c.ins), bond: r2(c.bond), subtotal: row.total_before_tax, tps: row.tps, tvq: row.tvq, total: row.total } };
  },

  async preview(user, b) {
    const { ch } = await loadChange(user, b.id);
    const row = parseRow(ch);
    applyTotals(row);
    const rev = ch.sent_at ? (Number(ch.rev) || 0) + 1 : 0;
    let bytes = await buildChangePdf(Object.assign({}, row, { rev, sent_at: new Date().toISOString() }));
    bytes = (await withQuotes(bytes, row, ch.id)).bytes;
    return { pdfBase64: Buffer.from(bytes).toString('base64'), filename: 'Avis de changement ' + (numOf(ch) || 'brouillon') + '.pdf' };
  },

  async recipients(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const iv = await dash.buildInterv(project);
    const list = [];
    const seen = new Set();
    const add = (group, name, company, email) => { const e = String(email || '').trim().toLowerCase(); if (!e || seen.has(e)) return; seen.add(e); list.push({ group, name: name || '', company: company || '', email: e }); };
    if (iv.owner) add("Maître de l'ouvrage", iv.owner.name, '', iv.owner.email);
    (iv.pros || []).forEach(p => add('Professionnels', p.contact, p.company + (p.specialty ? ' — ' + p.specialty : ''), p.email));
    const cc = [user.email].concat(project.cp.map(c => (c.email || '').toLowerCase()).filter(Boolean)).filter((e, i, a) => e && a.indexOf(e) === i);
    return { recipients: list, cc };
  },

  async send(user, b) {
    const { ch, project } = await loadChange(user, b.id);
    if (LOCKED.includes(ch.status)) throw { status: 409, message: 'Cette demande est ' + ch.status + '.' };
    const row = parseRow(ch);
    if (!numOf(ch)) throw { status: 400, message: "Indiquez le « N° de la demande » (section 1) avant l'envoi." };
    if (!row.lines.length) throw { status: 400, message: "Ajoutez au moins une ligne de coût avant l'envoi." };
    const to = Array.from(new Set((Array.isArray(b.to) ? b.to : []).map(e => str(e, 200).toLowerCase()).filter(Boolean)));
    if (!to.length) throw { status: 400, message: 'Choisissez au moins un destinataire.' };
    const bad = to.find(e => !po.isEmail(e)); if (bad) throw { status: 400, message: 'Courriel invalide : ' + bad };
    const ccAll = [user.email].concat(project.cp.map(c => (c.email || '').toLowerCase()), (Array.isArray(b.cc) ? b.cc : []).map(e => str(e, 200).toLowerCase()));
    const cc = Array.from(new Set(ccAll.filter(e => e && po.isEmail(e) && !to.includes(e))));
    const rev = ch.sent_at ? (Number(ch.rev) || 0) + 1 : 0;
    applyTotals(row);
    const sentAt = new Date().toISOString();
    const base = await buildChangePdf(Object.assign({}, row, { rev, sent_at: sentAt }));
    const merged = await withQuotes(base, row, ch.id);
    const bytes = merged.bytes;
    const filename = 'Avis de changement ' + numOf(ch) + (rev ? ' Rev' + rev : '') + ' - ' + safe(ch.project_number) + '.pdf';
    const subject = str(b.subject, 200) || ('Avis de changement ' + numOf(ch) + (rev ? ' Rév.' + rev : '') + ' — Projet ' + ch.project_number + ' ' + ch.project_name);
    const message = String(b.message || '').replace(/\r/g, '').slice(0, 5000) ||
      ("Bonjour,\n\nVeuillez trouver ci-joint l'avis de changement " + numOf(ch) + (rev ? ' (révision ' + rev + ')' : '') + ' pour le projet ' + ch.project_number + '.\n\nMerci de nous faire part de vos commentaires ou de votre approbation.');
    const attachments = [{ filename, content: Buffer.from(bytes), contentType: 'application/pdf' }];
    merged.extra.forEach(x => attachments.push(x));
    for (const fid of (Array.isArray(b.fileIds) ? b.fileIds : []).filter(isUuid).slice(0, 6)) {
      const f = await fileBytes(fid, ch.id);
      if (f) attachments.push({ filename: f.filename, content: f.bytes });
    }
    const html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:560px">' + esc(message).replace(/\n/g, '<br>') +
      '<p style="margin-top:18px">' + esc(user.name || user.email) + '<br>Les Entreprises Philippe Denis inc.</p>' +
      '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
    await mail.sendMail({ to: to.join(', '), cc: cc.join(', '), replyTo: user.email, subject, html, text: message + '\n\n' + (user.name || user.email) + '\nLes Entreprises Philippe Denis inc.', attachments });
    await q('INSERT INTO fin_change_version (change_id, rev, sent_at, sent_by, recipients, cc, subject, message, total, filename, pdf_b64) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [ch.id, rev, sentAt, user.email, to.join(', '), cc.join(', '), subject, message, row.total, filename, Buffer.from(bytes).toString('base64')]);
    await q("UPDATE fin_change SET status = 'envoye', rev = $2, sent_at = $3, updated_by = $4, updated_at = now() WHERE id = $1", [ch.id, rev, sentAt, user.email]);
    await logEvent(ch.id, rev ? 'renvoye' : 'envoye', user.email, 'Rév.' + rev + ' → ' + to.join(', '));
    return { ok: true, rev, sentTo: to, cc };
  },

  async addComment(user, b) {
    const { ch } = await loadChange(user, b.id);
    if (LOCKED.includes(ch.status)) throw { status: 409, message: 'Cette demande est ' + ch.status + '.' };
    const text = String(b.text || '').replace(/\r/g, '').trim().slice(0, 4000);
    if (!text) throw { status: 400, message: 'Saisissez le commentaire reçu.' };
    const from = str(b.from, 120);
    await logEvent(ch.id, 'commentaire', user.email, (from ? from + ' : ' : '') + text);
    if (ch.status === 'envoye') await q("UPDATE fin_change SET status = 'en_revision', updated_at = now() WHERE id = $1", [ch.id]);
    return { ok: true };
  },

  async setStatus(user, b) {
    const { ch } = await loadChange(user, b.id);
    const to = b.status;
    if (to === 'avenant_recu') {   // marquage manuel (le module Avenant le fait automatiquement)
      if (ch.status !== 'attente_avenant') throw { status: 409, message: "La demande n'est pas en attente de l'avenant." };
      await q("UPDATE fin_change SET status = 'avenant_recu', updated_by = $2, updated_at = now() WHERE id = $1", [ch.id, user.email]);
      await logEvent(ch.id, 'avenant_recu', user.email, 'Marqué manuellement');
      return { ok: true };
    }
    if (!['refuse', 'annule', 'en_revision'].includes(to)) throw { status: 400, message: 'Statut invalide.' };
    if (isApproved(ch.status)) throw { status: 409, message: 'Cette demande est déjà approuvée.' };
    await q('UPDATE fin_change SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [ch.id, to, user.email]);
    await logEvent(ch.id, to, user.email, str(b.reason, 500));
    return { ok: true };
  },

  // --- Fichiers par blocs (la limite de corps Vercel est 4,5 Mo) ---
  async fileChunk(user, b) {
    await loadChange(user, b.id);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const idx = parseInt(b.idx, 10);
    const data = String(b.data || '');
    if (!(idx >= 0 && idx < 20) || !data || data.length > 2200000 || /[^A-Za-z0-9+/=]/.test(data)) throw { status: 400, message: 'Bloc invalide.' };
    await q('INSERT INTO fin_change_chunk (upload_id, idx, data_b64) VALUES ($1,$2,$3) ON CONFLICT (upload_id, idx) DO UPDATE SET data_b64 = EXCLUDED.data_b64', [up, idx, data]);
    return { ok: true };
  },

  async fileFinish(user, b) {
    const { ch } = await loadChange(user, b.id);
    if (isApproved(ch.status)) throw { status: 409, message: 'Demande approuvée : documents verrouillés.' };
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const kind = ['ddc', 'comment', 'signed', 'quote', 'other'].includes(b.kind) ? b.kind : 'other';
    const filename = str(b.filename || 'document', 150).replace(/[\\/:*?"<>|]/g, '_') || 'document';
    const n = parseInt(b.count, 10);
    const cnt = await q('SELECT count(*)::int AS n FROM fin_change_chunk WHERE upload_id = $1', [up]);
    if (!(n > 0) || cnt[0].n !== n) throw { status: 400, message: 'Téléversement incomplet (' + cnt[0].n + '/' + n + ' blocs). Réessayez.' };
    const ins = await q(`INSERT INTO fin_change_file (change_id, kind, filename, size_bytes, data_b64, note, uploaded_by)
        SELECT $1, $2, $3, 0, string_agg(data_b64, '' ORDER BY idx), $5, $6 FROM fin_change_chunk WHERE upload_id = $4 RETURNING id, length(data_b64) AS len`,
      [ch.id, kind, filename, up, str(b.note, 300) || null, user.email]);
    await q('DELETE FROM fin_change_chunk WHERE upload_id = $1', [up]);
    const size = Math.floor(Number(ins[0].len) * 3 / 4);
    if (size > MAX_FILE) { await q('DELETE FROM fin_change_file WHERE id = $1', [ins[0].id]); throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' }; }
    await q('UPDATE fin_change_file SET size_bytes = $2 WHERE id = $1', [ins[0].id, size]);
    await logEvent(ch.id, 'fichier_' + kind, user.email, filename);
    if (kind === 'comment' && ch.status === 'envoye') await q("UPDATE fin_change SET status = 'en_revision', updated_at = now() WHERE id = $1", [ch.id]);
    return { ok: true, id: ins[0].id };
  },

  async fileDelete(user, b) {
    const { ch } = await loadChange(user, b.id);
    if (isApproved(ch.status)) throw { status: 409, message: 'Demande approuvée : documents verrouillés.' };
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const r = await q('DELETE FROM fin_change_file WHERE id = $1 AND change_id = $2 RETURNING filename', [b.fileId, ch.id]);
    if (r[0]) await logEvent(ch.id, 'fichier_supprime', user.email, r[0].filename);
    return { ok: true };
  },

  /** Téléchargement par blocs : src = 'file' | 'version'. */
  async fileGetChunk(user, b) {
    const { ch } = await loadChange(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const sql = b.src === 'version'
      ? 'SELECT filename, length(pdf_b64) AS len, substr(pdf_b64, $3::int, $4::int) AS part FROM fin_change_version WHERE id = $1 AND change_id = $2'
      : 'SELECT filename, length(data_b64) AS len, substr(data_b64, $3::int, $4::int) AS part FROM fin_change_file WHERE id = $1 AND change_id = $2';
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = await q(sql, [b.fileId, ch.id, idx * CHUNK_B64 + 1, CHUNK_B64]);
    if (!r[0]) throw { status: 404, message: 'Fichier introuvable.' };
    return { filename: r[0].filename, data: r[0].part || '', chunks: Math.max(1, Math.ceil(Number(r[0].len) / CHUNK_B64)), idx };
  },

  async approve(user, b) {
    const { ch, project } = await loadChange(user, b.id);
    if (isApproved(ch.status)) throw { status: 409, message: 'Déjà approuvée.' };
    if (['refuse', 'annule'].includes(ch.status)) throw { status: 409, message: 'Cette demande est ' + ch.status + '.' };
    const sg = await q("SELECT 1 FROM fin_change_file WHERE change_id = $1 AND kind = 'signed' LIMIT 1", [ch.id]);
    if (!sg[0]) throw { status: 400, message: "Insérez d'abord le document signé par les professionnels." };
    const row = parseRow(ch);
    await q("UPDATE fin_change SET status = 'attente_avenant', approved_at = now(), signed_date = $2, updated_by = $3, updated_at = now() WHERE id = $1",
      [ch.id, dateOrNull(b.signedDate) || new Date().toISOString().slice(0, 10), user.email]);
    await logEvent(ch.id, 'approuve', user.email, "Approuvée par les professionnels : en attente de l'avenant");
    const sharepoint = await pushToSharePoint(ch);
    let pos = { created: [], warnings: [] };
    if (!row.po_ids.length) {
      pos = await createDraftPos(user, row, project);
      await q('UPDATE fin_change SET po_ids = $2::jsonb, po_created_at = now() WHERE id = $1', [ch.id, JSON.stringify(pos.created)]);
      await logEvent(ch.id, 'bons_crees', user.email, pos.created.map(x => x.po_number).join(', ') || 'aucun');
    }
    return { ok: true, sharepoint, pos: pos.created, warnings: pos.warnings };
  },


  /** Demande de prix : envoie la demande du professionnel (+ description) aux sous-traitants choisis et passe en « En attente de prix ». */
  async requestPrices(user, b) {
    const { ch, project } = await loadChange(user, b.id);
    if (!['brouillon', 'attente_prix'].includes(ch.status)) throw { status: 409, message: 'Les prix ne peuvent être demandés que pour un brouillon ou une demande en attente de prix.' };
    const list = (Array.isArray(b.suppliers) ? b.suppliers : []).slice(0, 15).map(x => ({
      name: str(x.name, 200), email: str(x.email, 200).toLowerCase(), contact: str(x.contact, 120), supplierItemId: isId(x.supplierItemId) ? String(x.supplierItemId) : '' })).filter(x => x.name);
    if (!list.length) throw { status: 400, message: 'Choisissez au moins un sous-traitant.' };
    const nomail = list.find(x => !x.email || !po.isEmail(x.email));
    if (nomail) throw { status: 400, message: 'Courriel manquant ou invalide pour ' + nomail.name + '.' };
    const files = await q("SELECT id FROM fin_change_file WHERE change_id = $1 AND kind = 'ddc' ORDER BY created_at", [ch.id]);
    if (!files.length) throw { status: 400, message: "Glissez d'abord le document du professionnel (demande de changement) dans la demande." };
    const attachments = [];
    for (const f of files.slice(0, 6)) { const fb = await fileBytes(f.id, ch.id); if (fb) attachments.push({ filename: fb.filename, content: fb.bytes }); }
    const prs = Array.isArray(ch.price_requests) ? ch.price_requests.slice() : [];
    const cc = Array.from(new Set([user.email].concat(project.cp.map(c => (c.email || '').toLowerCase()), (Array.isArray(b.cc) ? b.cc : []).map(e => str(e, 200).toLowerCase())).filter(e => e && po.isEmail(e))));
    const sent = [];
    for (const sup of list) {
      const to = [sup.email];
      const ccs = cc.filter(e => !to.includes(e));
      const subject = str(b.subject, 200) || ('Demande de prix — ' + (numOf(ch) || ch.avc_number) + ' — Projet ' + ch.project_number + ' ' + ch.project_name);
      const message = (String(b.message || '').replace(/\r/g, '').slice(0, 4000) ||
        ('Bonjour' + (sup.contact ? ' ' + sup.contact : '') + ',\n\nVeuillez trouver ci-joint une demande de changement pour le projet ' + ch.project_number + ' — ' + ch.project_name +
         (ch.title ? ' (' + ch.title + ')' : '') + '.\n\nMerci de nous transmettre votre prix détaillé (ventilation) par courriel, en format PDF, dans les meilleurs délais.'))
        .split('[FOURNISSEUR]').join(sup.contact || sup.name);
      const html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:560px">' + esc(message).replace(/\n/g, '<br>') +
        '<p style="margin-top:18px">' + esc(user.name || user.email) + '<br>Les Entreprises Philippe Denis inc.</p>' +
        '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
      await mail.sendMail({ to: to.join(', '), cc: ccs.join(', '), replyTo: user.email, subject, html, text: message + '\n\n' + (user.name || user.email) + '\nLes Entreprises Philippe Denis inc.', attachments });
      const nowIso = new Date().toISOString();
      const i = prs.findIndex(p => String(p.email).toLowerCase() === sup.email);
      const entry = Object.assign({}, i >= 0 ? prs[i] : {}, { name: sup.name, email: sup.email, contact: sup.contact, supplierItemId: sup.supplierItemId, sent_at: nowIso, last_reminder_at: null, reminders: 0, received_at: null });
      if (i >= 0) prs[i] = entry; else prs.push(entry);
      await logEvent(ch.id, 'prix_demande', user.email, sup.name + ' <' + sup.email + '>');
      sent.push({ name: sup.name, to: sup.email });
    }
    await q("UPDATE fin_change SET status = 'attente_prix', price_requests = $2::jsonb, updated_by = $3, updated_at = now() WHERE id = $1", [ch.id, JSON.stringify(prs), user.email]);
    return { ok: true, sent };
  },

  /** Marque (ou démarque) la réception du prix d'un sous-traitant : les relances s'arrêtent. */
  async markPrice(user, b) {
    const { ch } = await loadChange(user, b.id);
    const email = str(b.email, 200).toLowerCase();
    const prs = (Array.isArray(ch.price_requests) ? ch.price_requests : []).map(p => String(p.email).toLowerCase() === email
      ? Object.assign({}, p, { received_at: b.received === false ? null : new Date().toISOString() }) : p);
    if (!prs.some(p => String(p.email).toLowerCase() === email)) throw { status: 404, message: 'Sous-traitant introuvable dans la demande.' };
    await q('UPDATE fin_change SET price_requests = $2::jsonb, updated_by = $3, updated_at = now() WHERE id = $1', [ch.id, JSON.stringify(prs), user.email]);
    await logEvent(ch.id, b.received === false ? 'prix_annule' : 'prix_recu', user.email, email);
    return { ok: true, price_requests: prs };
  },

  // --- Avenants (module « Avenants ») ---------------------------------------------------------------------

  /** Avenants du projet + directives qui attendent un avenant. */
  async avenantList(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const av = require('./_lib/avenant');
    const [list, waiting] = await Promise.all([
      q("SELECT id, avenant_number, avenant_date, filename, size_bytes, source, email_from, status, matches, notes, applied_ids, applied_by, applied_at, created_by, created_at FROM fin_avenant WHERE project_item_id = $1 ORDER BY created_at DESC", [project.id]),
      av.candidates(project.id)]);
    const recu = await q("SELECT id, legacy, avc_number, ddc_number, title, total, avenant_id FROM fin_change WHERE project_item_id = $1 AND status = 'avenant_recu' ORDER BY avc_number", [project.id]);
    return { project: { id: project.id, number: project.number, name: project.name }, avenants: list, waiting: waiting.map(c => Object.assign({}, c, { total: Number(c.total) || 0 })),
      received: recu.map(c => Object.assign({}, c, { total: Number(c.total) || 0 })) };
  },
  /** Sommaire global : nombre d'avenants à valider et de directives en attente, par projet (pastille de navigation). */
  async avenantCounts(user) {
    const w = await who(user);
    const mine = w.isAccounting ? null : (await monday.fetchProjectsLite(false)).filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email)).map(p => String(p.id));
    const a = await q("SELECT project_item_id, count(*)::int AS n FROM fin_avenant WHERE status = 'a_valider' AND ($2::boolean OR project_item_id = ANY($1::text[])) GROUP BY project_item_id", [mine || [], !mine]);
    const c = await q("SELECT project_item_id, count(*)::int AS n FROM fin_change WHERE status = 'attente_avenant' AND ($2::boolean OR project_item_id = ANY($1::text[])) GROUP BY project_item_id", [mine || [], !mine]);
    return { toValidate: a.reduce((t, x) => t + x.n, 0), waiting: c.reduce((t, x) => t + x.n, 0) };
  },
  async avenantChunk(user, b) {
    await projectAccess(user, b.projectItemId);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const idx = parseInt(b.idx, 10), data = String(b.data || '');
    if (!(idx >= 0 && idx < 20) || !data || data.length > 2200000 || /[^A-Za-z0-9+/=]/.test(data)) throw { status: 400, message: 'Bloc invalide.' };
    await q('INSERT INTO fin_change_chunk (upload_id, idx, data_b64) VALUES ($1,$2,$3) ON CONFLICT (upload_id, idx) DO UPDATE SET data_b64 = EXCLUDED.data_b64', [up, idx, data]);
    return { ok: true };
  },
  /** Assemble le PDF déposé, le fait lire par Claude et crée l'avenant « À valider ». */
  async avenantFinish(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const n = parseInt(b.count, 10);
    const rows = await q('SELECT data_b64 FROM fin_change_chunk WHERE upload_id = $1 ORDER BY idx', [up]);
    if (!(n > 0) || rows.length !== n) throw { status: 400, message: 'Téléversement incomplet (' + rows.length + '/' + n + ' blocs). Réessayez.' };
    await q('DELETE FROM fin_change_chunk WHERE upload_id = $1', [up]);
    const bytes = Buffer.from(rows.map(r => r.data_b64).join(''), 'base64');
    if (bytes.length > MAX_FILE) throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' };
    if (bytes.slice(0, 4).toString('latin1') !== '%PDF') throw { status: 400, message: "L'avenant doit être un fichier PDF." };
    const filename = str(b.filename || 'avenant.pdf', 150).replace(/[\\/:*?"<>|]/g, '_') || 'avenant.pdf';
    const r = await require('./_lib/avenant').store({ project, filename, bytes, source: 'manuel', user });
    return { ok: true, id: r.id, matches: r.analysis.matches.length, error: r.analysis.error || '' };
  },
  async avenantApply(user, b) {
    const av = (await q('SELECT * FROM fin_avenant WHERE id = $1', [String(b.id || '').match(/^[0-9a-f-]{36}$/i) ? b.id : '00000000-0000-0000-0000-000000000000']))[0];
    if (!av) throw { status: 404, message: 'Avenant introuvable.' };
    await projectAccess(user, av.project_item_id);
    if (av.status !== 'a_valider') throw { status: 409, message: 'Cet avenant a déjà été appliqué.' };
    const r = await require('./_lib/avenant').apply(av, b.changeIds, user.email);
    if (!r.updated.length) throw { status: 409, message: "Aucune des directives choisies n'est en attente de l'avenant." };
    return { ok: true, updated: r.updated, skipped: r.skipped };
  },
  async avenantDelete(user, b) {
    const av = (await q('SELECT id, project_item_id, status FROM fin_avenant WHERE id = $1', [String(b.id || '').match(/^[0-9a-f-]{36}$/i) ? b.id : '00000000-0000-0000-0000-000000000000']))[0];
    if (!av) throw { status: 404, message: 'Avenant introuvable.' };
    await projectAccess(user, av.project_item_id);
    if (av.status !== 'a_valider') throw { status: 409, message: 'Un avenant appliqué ne peut pas être supprimé.' };
    await q('DELETE FROM fin_avenant WHERE id = $1', [av.id]);
    return { ok: true };
  },
  async avenantGetChunk(user, b) {
    const av = (await q('SELECT project_item_id FROM fin_avenant WHERE id = $1', [String(b.id || '').match(/^[0-9a-f-]{36}$/i) ? b.id : '00000000-0000-0000-0000-000000000000']))[0];
    if (!av) throw { status: 404, message: 'Avenant introuvable.' };
    await projectAccess(user, av.project_item_id);
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = await q('SELECT filename, length(data_b64) AS len, substr(data_b64, $2::int, $3::int) AS part FROM fin_avenant WHERE id = $1', [b.id, idx * CHUNK_B64 + 1, CHUNK_B64]);
    return { filename: r[0].filename, data: r[0].part || '', chunks: Math.max(1, Math.ceil(Number(r[0].len) / CHUNK_B64)), idx };
  },

  async spRetry(user, b) {
    const { ch } = await loadChange(user, b.id);
    if (!isApproved(ch.status)) throw { status: 409, message: "La demande n'est pas approuvée." };
    return { sharepoint: await pushToSharePoint(ch) };
  },

  /** Réessaie la création des bons de commande (ex. aucun généré à l'approbation faute de code d'activité). */
  async createPos(user, b) {
    const { ch, project } = await loadChange(user, b.id);
    if (!isApproved(ch.status)) throw { status: 409, message: "La demande n'est pas approuvée." };
    const row = parseRow(ch);
    if (row.po_ids.length) throw { status: 409, message: 'Des bons de commande ont déjà été créés pour cette directive.' };
    const pos = await createDraftPos(user, row, project);
    await q('UPDATE fin_change SET po_ids = $2::jsonb, po_created_at = now() WHERE id = $1', [ch.id, JSON.stringify(pos.created)]);
    await logEvent(ch.id, 'bons_crees', user.email, pos.created.map(x => x.po_number).join(', ') || 'aucun');
    return { pos: pos.created, warnings: pos.warnings };
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }
  let user;
  try { user = await requireUser(req); }
  catch (e) { res.status(e.status || 401).json({ error: e.message || 'Non authentifié.' }); return; }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fn = ACTIONS[body.action];
  if (!fn) { res.status(400).json({ error: 'Action inconnue.' }); return; }
  try { res.status(200).json(await fn(user, body, req)); }
  catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('changes.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
