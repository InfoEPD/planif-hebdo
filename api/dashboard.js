// api/dashboard.js
//
// Modules « Tableau de bord » (suivi financier par projet) et « Intervenants » de Finance.
//   POST { action, ... }  authentifié par Clerk (comme api/finance.js et api/invoices.js)
//
// Accès : comptabilité + administrateurs (tous les projets) ; chargé de projet (ses projets, courriel reconnu dans Monday).
// Tous les montants sont AVANT taxes.

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const mail = require('./_lib/mail');
const inv = require('./_lib/invoice');
const mlive = require('./_lib/mlive');
const { buildIntervenantsPdf } = require('./_lib/ivpdf');
const { COMPANY } = require('./_lib/pdf');

const COMPANY_EMAIL = process.env.COMPANY_EMAIL || 'infos@entreprisesphilippedenis.com';
const r2 = inv.round2;
const isId = v => /^\d+$/.test(String(v || ''));
const codeOf = v => String(v == null ? '' : v).trim();
const SENT_MONDAY = /envoy|sign/i;           // statuts Monday d'un bon réellement transmis
const SUBCONTRACT = /sous[\s-]*contrat/i;

async function who(user) {
  const acct = await inv.accountingEmails();
  return { isAccounting: user.isAdmin || acct.includes(user.email) };
}

/** Autorise l'accès à un projet : comptabilité/admin ou chargé de projet de ce projet. */
async function projectAccess(user, projectItemId) {
  if (!isId(projectItemId)) throw { status: 400, message: 'Projet invalide.' };
  const w = await who(user);
  const project = await monday.fetchProject(projectItemId);
  const isCp = project.cp.some(c => (c.email || '').toLowerCase() === user.email);
  if (!w.isAccounting && !isCp) throw { status: 403, message: "Vous n'avez pas accès à ce projet." };
  return { project, isAccounting: w.isAccounting, isCp };
}

function cleanName(label) { return String(label || '').replace(/^\s*\d+\s*[-–]\s*/, '').trim(); }

// ---------- Tableau de bord --------------------------------------------------------------------------------

function posteIndex(postes) {
  const byCode = new Map();
  postes.forEach(p => { const k = codeOf(p.code); if (k && !byCode.has(k)) byCode.set(k, p); });
  return byCode;
}

/** Code de poste d'une facture : code d'activité, sinon poste dont le G/L est unique. */
function invoiceCode(x, postes, byCode) {
  const a = codeOf(x.activity_code);
  if (a) return a;
  const gl = codeOf(x.gl_expense);
  if (gl) { const m = postes.filter(p => codeOf(p.gl) === gl); if (m.length === 1) return codeOf(m[0].code); }
  return '';
}

async function buildDashboard(project) {
  const pid = project.id;
  const warnings = [];
  const postes = await monday.fetchBudgetItems();
  const byCode = posteIndex(postes);
  const lines = await q('SELECT * FROM fin_bid_line WHERE project_item_id = $1', [pid]);
  const finPos = await q(`SELECT po_number, status, supplier_name, subtotal, budget_code, budget_label, gl_account, sent_at FROM fin_po
      WHERE (project_item_id = $1 OR project_number = $2) AND status IN ('envoye','vu','signe') ORDER BY po_number`, [pid, project.number]);
  const allFinNums = new Set((await q('SELECT po_number FROM fin_po WHERE project_item_id = $1 OR project_number = $2', [pid, project.number])).map(x => String(x.po_number).trim()));
  const finInv = await q(`SELECT id, status, invoice_number, invoice_date, supplier_name, subtotal, activity_code, gl_expense, po_number FROM fin_invoice
      WHERE project_item_id = $1 AND status <> 'rejetee' AND ${mlive.NOT_LEGACY_PENDING} ORDER BY invoice_date NULLS LAST, created_at`, [pid]);

  // Bons Monday (créés avant Finance) + leurs factures Monday
  let monPos = [], monInv = [];
  if (mlive.po) try {
    const all = await monday.fetchPosByProject(pid);
    monPos = all.filter(x => !allFinNums.has(String(x.name).trim()));
    const ids = Array.from(new Set(monPos.flatMap(x => x.invoiceItemIds || [])));
    for (let i = 0; i < ids.length; i += 50) monInv.push(...await monday.fetchMondayInvoices(ids.slice(i, i + 50)));
  } catch (e) { console.error('dashboard Monday', e && e.message); warnings.push("Les bons de commande créés dans Monday n'ont pas pu être lus (" + ((e && e.message) || 'erreur') + ')'); }
  const poByInvoiceId = new Map();
  monPos.forEach(po => (po.invoiceItemIds || []).forEach(id => poByInvoiceId.set(String(id), po)));

  const rows = new Map();
  const getRow = code => {
    const k = codeOf(code);
    if (!rows.has(k)) {
      const p = byCode.get(k);
      rows.set(k, { code: k, name: p ? cleanName(p.name.replace(/^\s*\d+\s*[-–]\s*/, '')) || p.name : (k ? 'Poste ' + k : 'Non classé'), fullName: p ? p.name : '', gl: p ? p.gl : '', glLabel: p ? p.glLabel : '',
        bid: 0, ddc: 0, ddcs: [], done: false, estimate: null, pos: [], invs: [], known: !!p, budgetItemId: p ? p.id : null });
    }
    return rows.get(k);
  };
  lines.forEach(l => { const r = getRow(l.poste_code); r.bid = Number(l.amount) || 0; r.done = !!l.done; r.estimate = l.estimate == null ? null : Number(l.estimate); });

  finPos.forEach(x => getRow(x.budget_code).pos.push({ number: x.po_number, supplier: x.supplier_name, status: x.status, amount: Number(x.subtotal) || 0, source: 'Finance' }));
  monPos.filter(x => SENT_MONDAY.test(x.status || '')).forEach(x => getRow(x.activityCode).pos.push({ number: x.name, supplier: x.supplierName || '', status: x.status, amount: x.subtotal, source: 'Monday' }));

  const finNums = new Set(finInv.map(x => inv.normInvoiceNumber(x.invoice_number)).filter(Boolean));
  // Facture liée à un bon de commande mais sans code d'activité : on prend le code du bon (Finance ou Monday)
  const poCode = new Map();
  finPos.forEach(x => { if (codeOf(x.budget_code)) poCode.set(String(x.po_number).trim(), codeOf(x.budget_code)); });
  monPos.forEach(x => { if (codeOf(x.activityCode)) poCode.set(String(x.name).trim(), codeOf(x.activityCode)); });
  finInv.forEach(x => { if (!codeOf(x.activity_code) && x.po_number && poCode.has(String(x.po_number).trim())) x.activity_code = poCode.get(String(x.po_number).trim()); });
  finInv.forEach(x => getRow(invoiceCode(x, postes, byCode)).invs.push({ id: x.id, number: x.invoice_number, supplier: x.supplier_name, date: inv.isoDate(x.invoice_date), status: x.status, amount: Number(x.subtotal) || 0, po: x.po_number, source: 'Finance' }));
  // Factures du board Monday rattachées au projet : surtout celles SANS bon de commande (code « Code d'activité - SANS PO »)
  const seenMon = new Set(monInv.map(x => String(x.id)));
  let projInv = [];
  if (mlive.invoices) try { projInv = await monday.fetchInvoicesByProject(pid); } catch (e) { console.error('dashboard factures Monday', e && e.message); warnings.push('Les factures Monday du projet (sans bon de commande) n\'ont pas pu être lues (' + ((e && e.message) || 'erreur') + ').'); }
  const extraInv = projInv.filter(x => !seenMon.has(String(x.id)) && !/refus|annul/i.test(x.status || '') && !(x.number && finNums.has(inv.normInvoiceNumber(x.number))));
  extraInv.forEach(x => getRow(codeOf((postes.find(p => String(p.id) === String(x.divisionId)) || {}).code) || x.activityNoPo || x.activityPo || '').invs.push({ number: x.number || x.name, supplier: x.supplier, date: x.date, status: x.status || 'Monday', amount: x.subtotal, po: x.poNumber || '', source: 'Monday' }));
  monInv.forEach(x => {
    if (/refus|annul/i.test(x.status || '')) return;
    if (x.number && finNums.has(inv.normInvoiceNumber(x.number))) return; // déjà reprise dans Finance
    const po = poByInvoiceId.get(String(x.id));
    getRow(po ? po.activityCode : '').invs.push({ number: x.number || x.name, supplier: po ? (po.supplierName || '') : '', date: null, status: x.status || 'Monday', amount: x.subtotal, po: po ? po.name : '', source: 'Monday' });
  });

  // Demandes de changement approuvées (Finance + Monday) : s'ajoutent à la soumission, par code d'activité
  const resolveCode = c => {
    const k = codeOf(c); if (!k) return '';
    if (byCode.has(k)) return k;
    const p = postes.find(x => String(x.name || '').trim().toLowerCase().startsWith(k.toLowerCase() + ' ') || String(x.name || '').trim().toLowerCase().startsWith(k.toLowerCase() + '-'));
    return p ? codeOf(p.code) : '';
  };
  const addDdc = (d) => {
    let placed = 0;
    d.lines.forEach(l => { const amt = r2(l.amount); if (!amt) return; placed += amt; getRow(resolveCode(l.code)).ddcs.push({ number: d.number, title: d.title, amount: amt, source: d.source, date: d.date || null }); });
    const rest = r2(d.total - placed);
    if (Math.abs(rest) >= 0.01) getRow('').ddcs.push({ number: d.number, title: d.title, amount: rest, source: d.source, date: d.date || null });
  };
  const finDdcNums = new Set();
  try {
    const fc = await q("SELECT legacy, avc_number, ddc_number, title, approved_at, lines, insurance_pct, bond_pct FROM fin_change WHERE project_item_id = $1 AND status IN ('approuve','attente_avenant','avenant_recu') ORDER BY avc_number", [pid]);
    fc.forEach(c => {
      const ls = Array.isArray(c.lines) ? c.lines : JSON.parse(c.lines || '[]');
      const f = 1 + ((Number(c.insurance_pct) || 0) + (Number(c.bond_pct) || 0)) / 100;
      const lines = ls.map(l => ({ code: l.activityCode, amount: r2((Number(l.qty) || 0) * (Number(l.price) || 0) * (1 + (Number(l.feePct) || 0) / 100) * f) }));
      const total = r2(lines.reduce((x, l) => x + l.amount, 0));
      if (c.ddc_number) finDdcNums.add(String(c.ddc_number).trim().toLowerCase());
      addDdc({ number: String(c.ddc_number || '').trim() || c.avc_number, title: c.title || '', date: c.approved_at ? new Date(c.approved_at).toISOString().slice(0, 10) : null, lines, total, source: 'Finance' });
    });
  } catch (e) { console.error('dashboard DDC Finance', e && e.message); warnings.push('Les demandes de changement de Finance n\'ont pas pu être lues (migration SQL des demandes de changement exécutée ?).'); }
  if (mlive.ddc) try {
    (await monday.fetchDdcByProject(pid)).forEach(d => {
      if (d.number && finDdcNums.has(String(d.number).trim().toLowerCase())) return; // déjà reprise dans Finance
      addDdc({ number: d.number || d.name, title: d.name, date: d.date, lines: d.lines, total: d.total, source: 'Monday' });
    });
  } catch (e) { console.error('dashboard DDC Monday', e && e.message); warnings.push('Les demandes de changement approuvées dans Monday n\'ont pas pu être lues (' + ((e && e.message) || 'erreur') + ').'); }

  const out = Array.from(rows.values()).map(r => {
    r.bid = r2(r.bid);
    r.ddc = r2(r.ddcs.reduce((x, y) => x + y.amount, 0));
    r.poTotal = r2(r.pos.reduce((s, x) => s + x.amount, 0));
    r.invTotal = r2(r.invs.reduce((s, x) => s + x.amount, 0));
    r.remaining = r.done ? 0 : r2(r.estimate || 0);
    r.forecast = r2(r.invTotal + r.remaining);
    r.result = r2(r.bid + r.ddc - r.forecast);
    return r;
  })
    .filter(r => r.bid || r.ddc || r.pos.length || r.invs.length || r.done || r.estimate)
    .sort((a, b) => (a.code === '' ? 1 : b.code === '' ? -1 : String(a.code).localeCompare(String(b.code), 'fr', { numeric: true })));
  const sum = k => r2(out.reduce((s, r) => s + r[k], 0));
  return { project: { id: pid, number: project.number, name: project.name, status: project.status }, rows: out,
    totals: { bid: sum('bid'), ddc: sum('ddc'), poTotal: sum('poTotal'), invTotal: sum('invTotal'), remaining: sum('remaining'), forecast: sum('forecast'), result: sum('result') }, warnings };
}

// ---------- Intervenants -----------------------------------------------------------------------------------

const person = p => ({ name: p.name || '', phone: p.phone || '', email: p.email || '' });

async function buildInterv(project) {
  const pid = project.id;
  const rows = await q('SELECT * FROM fin_intervenant WHERE project_item_id = $1 ORDER BY kind, sort, updated_at', [pid]);
  const ownerRow = rows.find(r => r.kind === 'owner');
  const owner = ownerRow ? { name: ownerRow.company || ownerRow.contact || '', phone: ownerRow.phone || '', email: ownerRow.email || '', saved: true }
    : { name: (project.owner && project.owner.name) || '', phone: '', email: (project.owner && project.owner.email) || '', saved: false };
  const pros = rows.filter(r => r.kind === 'pro').map(r => ({ id: r.id, company: r.company || '', specialty: r.specialty || '', contact: r.contact || '', phone: r.phone || '', email: r.email || '' }));

  // Sous-traitants et fournisseurs : bons de commande envoyés (Finance + Monday)
  const warnings = [];
  const postes = await monday.fetchBudgetItems();
  const byCode = posteIndex(postes);
  let suppliers = [];
  try { suppliers = await monday.fetchSuppliers(); } catch (e) { warnings.push('Fournisseurs Monday illisibles : coordonnées incomplètes.'); }
  const supById = new Map(suppliers.map(s => [String(s.id), s]));
  const finPos = await q(`SELECT po_number, supplier_item_id, supplier_name, supplier_email, supplier_phone, budget_code, gl_label FROM fin_po
      WHERE (project_item_id = $1 OR project_number = $2) AND status IN ('envoye','vu','signe')`, [pid, project.number]);
  const allFinNums = new Set((await q('SELECT po_number FROM fin_po WHERE project_item_id = $1 OR project_number = $2', [pid, project.number])).map(x => String(x.po_number).trim()));
  let monPos = [];
  if (mlive.po) try { monPos = (await monday.fetchPosByProject(pid)).filter(x => !allFinNums.has(String(x.name).trim()) && SENT_MONDAY.test(x.status || '')); }
  catch (e) { warnings.push("Les bons de commande créés dans Monday n'ont pas pu être lus."); }

  const groups = new Map();
  const add = (name, supplierItemId, email, phone, code, glLabel) => {
    const poste = byCode.get(codeOf(code));
    const label = cleanName(glLabel || (poste && poste.glLabel) || '') || cleanName(poste ? poste.name : '');
    const isSub = SUBCONTRACT.test(label);
    const s = supById.get(String(supplierItemId || ''));
    const key = (isSub ? 'S' : 'F') + '|' + String(name || '').toLowerCase() + '|' + label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { company: name || (s && s.name) || '(fournisseur)', category: label, sub: isSub, phone: phone || (s && s.phone) || '', email: email || (s && s.emails && s.emails[0]) || '', contact: s ? s.contact || '' : '' });
    else { const g = groups.get(key); if (!g.email) g.email = email || (s && s.emails && s.emails[0]) || ''; if (!g.phone) g.phone = phone || (s && s.phone) || ''; }
  };
  finPos.forEach(x => add(x.supplier_name, x.supplier_item_id, x.supplier_email, x.supplier_phone, x.budget_code, x.gl_label));
  monPos.forEach(x => add(x.supplierName, x.supplierItemId, '', '', x.activityCode, ''));
  const all = Array.from(groups.values()).sort((a, b) => a.company.localeCompare(b.company, 'fr', { sensitivity: 'base' }) || a.category.localeCompare(b.category, 'fr'));
  // Modifications manuelles : surcharges (kind 'ov', ref = groupe|clé) et ajouts (kind = groupe, sans ref)
  const extra = rows.filter(r => r.kind !== 'owner' && r.kind !== 'pro');
  const ovMap = new Map(extra.filter(r => r.kind === 'ov' && r.ref).map(r => [r.ref, r]));
  const applyGroup = (group, list, keyOf, isPerson) => {
    const out = [];
    for (const x of list) {
      const ref = group + '|' + keyOf(x);
      const o = ovMap.get(ref);
      if (o && o.hidden) continue;
      const it = Object.assign({}, x, { ref, manual: false });
      if (o) {
        if (isPerson) it.name = o.company || '';
        else { it.company = o.company || ''; it.category = o.specialty || ''; it.contact = o.contact || ''; }
        it.phone = o.phone || ''; it.email = o.email || ''; it.edited = true;
      }
      out.push(it);
    }
    for (const r of extra.filter(r => r.kind === group && !r.ref)) {
      out.push(isPerson ? { id: r.id, manual: true, name: r.company || '', phone: r.phone || '', email: r.email || '' }
        : { id: r.id, manual: true, company: r.company || '', category: r.specialty || '', contact: r.contact || '', phone: r.phone || '', email: r.email || '' });
    }
    return out;
  };
  const supKey = x => String(x.company || '').toLowerCase() + '|' + String(x.category || '').toLowerCase();
  const perKey = x => String(x.name || '').toLowerCase();
  return {
    project: { id: pid, number: project.number, name: project.name },
    owner, pros,
    cp: applyGroup('cp', project.cp.map(person), perKey, true), cm: applyGroup('cm', project.cm.map(person), perKey, true), coordo: applyGroup('coordo', project.coordo.map(person), perKey, true),
    subs: applyGroup('sub', all.filter(x => x.sub), supKey, false), suppliers: applyGroup('sup', all.filter(x => !x.sub), supKey, false), warnings,
    hiddenOv: extra.filter(r => r.kind === 'ov' && r.hidden && r.ref).map(r => ({ group: String(r.ref).split('|')[0], ref: r.ref, label: r.company || String(r.ref).split('|').slice(1).join(' ') }))
  };
}

function pdfModel(iv) {
  const when = new Date().toLocaleDateString('fr-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'long', day: 'numeric' });
  return { project: iv.project, company: { name: COMPANY.name.replace(/\b(\w)(\w*)/g, (m, a, b) => a + b.toLowerCase()).replace('Philippe Denis', 'Philippe Denis'), address: '1810, rue J.-A. Roy, Joliette, QC J6E 9H6', email: 'info@epd.ca', phone: COMPANY.tel },
    owner: iv.owner, cp: iv.cp, cm: iv.cm, pros: iv.pros, subs: iv.subs, suppliers: iv.suppliers, generatedAt: when };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Actions ----------------------------------------------------------------------------------------

const ACTIONS = {
  async me(user) { const w = await who(user); return { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting }; },

  /** Projets accessibles : tous pour la comptabilité/admin, sinon ceux dont la personne est chargée de projet. */
  async projects(user, b) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(!!(b && b.refresh))]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    return { me: { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting }, projects: mine.map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status, cp: p.cp.map(c => c.name) })) };
  },

  async dash(user, b) {
    const { project, isAccounting, isCp } = await projectAccess(user, b.projectItemId);
    const d = await buildDashboard(project);
    d.canEdit = isAccounting || isCp;
    return d;
  },

  /** Tous les postes budgétaires (Monday) + montants déjà inscrits, pour l'édition du bordereau. */
  async bidGet(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const postes = await monday.fetchBudgetItems();
    const lines = await q('SELECT poste_code, amount FROM fin_bid_line WHERE project_item_id = $1', [project.id]);
    const amt = new Map(lines.map(l => [codeOf(l.poste_code), Number(l.amount) || 0]));
    return { project: { id: project.id, number: project.number, name: project.name },
      postes: postes.filter(p => codeOf(p.code)).map(p => ({ code: codeOf(p.code), name: p.name, gl: p.gl, glLabel: p.glLabel, amount: amt.has(codeOf(p.code)) ? amt.get(codeOf(p.code)) : null })),
      orphans: lines.filter(l => !postes.some(p => codeOf(p.code) === codeOf(l.poste_code))).map(l => ({ code: codeOf(l.poste_code), amount: Number(l.amount) || 0 })) };
  },

  /** Enregistre les montants du bordereau (remplace les montants ; conserve « terminé » et « estimé »). */
  async bidSave(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const postes = await monday.fetchBudgetItems();
    const byCode = posteIndex(postes);
    const list = (Array.isArray(b.lines) ? b.lines : []).slice(0, 1000);
    let n = 0;
    for (const l of list) {
      const code = codeOf(l.code);
      if (!code || code.length > 20) continue;
      const a = l.amount === '' || l.amount == null ? 0 : inv.num(l.amount);
      if (a == null || Math.abs(a) > 999999999) throw { status: 400, message: 'Montant invalide pour le poste ' + code + '.' };
      const p = byCode.get(code);
      await q(`INSERT INTO fin_bid_line (project_item_id, poste_code, poste_name, gl_account, budget_item_id, amount, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (project_item_id, poste_code) DO UPDATE SET amount = EXCLUDED.amount, poste_name = COALESCE(EXCLUDED.poste_name, fin_bid_line.poste_name),
                 gl_account = COALESCE(EXCLUDED.gl_account, fin_bid_line.gl_account), budget_item_id = COALESCE(EXCLUDED.budget_item_id, fin_bid_line.budget_item_id), updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [project.id, code, p ? p.name : null, p ? p.gl || null : null, p ? p.id : null, r2(a), user.email]);
      n++;
    }
    // Les lignes à 0 sans suivi (ni terminé, ni estimé) sont supprimées pour garder le tableau propre
    await q('DELETE FROM fin_bid_line WHERE project_item_id = $1 AND amount = 0 AND done = false AND estimate IS NULL', [project.id]);
    return { ok: true, saved: n };
  },

  /** Coche « terminé » et/ou l'estimé des factures à recevoir d'un poste. */
  async lineUpdate(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const code = codeOf(b.code);
    if (!code) throw { status: 400, message: 'Poste invalide.' };
    const p = posteIndex(await monday.fetchBudgetItems()).get(code);
    const done = !!b.done;
    let est = null;
    if (b.estimate !== '' && b.estimate != null) { est = inv.num(b.estimate); if (est == null || Math.abs(est) > 999999999) throw { status: 400, message: 'Estimé invalide.' }; est = r2(est); }
    await q(`INSERT INTO fin_bid_line (project_item_id, poste_code, poste_name, gl_account, budget_item_id, amount, done, estimate, updated_by)
             VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)
             ON CONFLICT (project_item_id, poste_code) DO UPDATE SET done = EXCLUDED.done, estimate = EXCLUDED.estimate, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [project.id, code, p ? p.name : null, p ? p.gl || null : null, p ? p.id : null, done, est, user.email]);
    return { ok: true };
  },

  /** Liste d'intervenants (Conformité) pour les suggestions de la fiche intervenants. */
  async parties() { return { parties: await require('./_lib/parties').list(false) }; },

  async ivGet(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    return await buildInterv(project);
  },

  async ivSave(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const S = (v, n) => inv.str(v, n || 200);
    const o = b.owner || {};
    const pros = (Array.isArray(b.pros) ? b.pros : []).slice(0, 40).filter(p => p && (p.company || p.contact || p.specialty || p.email || p.phone));
    const bad = pros.concat([{ email: o.email }]).find(p => p.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(p.email).trim()));
    if (bad) throw { status: 400, message: 'Courriel invalide : ' + bad.email };
    const GROUPS = ['sub', 'sup', 'cp', 'cm', 'coordo'];
    const extras = Array.isArray(b.extras) ? b.extras.slice(0, 400).filter(e => e && GROUPS.includes(e.group)) : null;
    if (extras) {
      const badE = extras.find(e => e.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(e.email).trim()));
      if (badE) throw { status: 400, message: 'Courriel invalide : ' + badE.email };
      if (extras.some(e => !e.ref && !e.hidden && !(e.company || '').toString().trim())) throw { status: 400, message: 'Un intervenant ajouté manuellement doit avoir un nom.' };
    }
    await q("DELETE FROM fin_intervenant WHERE project_item_id = $1 AND kind IN ('owner','pro')", [project.id]);
    if (extras) {
      await q("DELETE FROM fin_intervenant WHERE project_item_id = $1 AND kind IN ('sub','sup','cp','cm','coordo','ov')", [project.id]);
      let k = 0;
      for (const e of extras) {
        const ref = e.ref ? String(e.ref).slice(0, 300) : null;
        if (ref && !ref.startsWith(e.group + '|')) continue;
        await q("INSERT INTO fin_intervenant (project_item_id, kind, ref, hidden, company, specialty, contact, phone, email, sort, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [project.id, ref ? 'ov' : e.group, ref, !!e.hidden, S(e.company), S(e.category, 120), S(e.contact), S(e.phone, 40), S(e.email), 1000 + k++, user.email]);
      }
    }
    if (o.name || o.phone || o.email) await q("INSERT INTO fin_intervenant (project_item_id, kind, company, phone, email, sort, updated_by) VALUES ($1,'owner',$2,$3,$4,0,$5)", [project.id, S(o.name), S(o.phone, 40), S(o.email), user.email]);
    let i = 0;
    for (const p of pros) await q("INSERT INTO fin_intervenant (project_item_id, kind, company, specialty, contact, phone, email, sort, updated_by) VALUES ($1,'pro',$2,$3,$4,$5,$6,$7,$8)",
      [project.id, S(p.company), S(p.specialty, 80), S(p.contact), S(p.phone, 40), S(p.email), i++, user.email]);
    return { ok: true };
  },

  async ivPdf(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const iv = await buildInterv(project);
    const bytes = await buildIntervenantsPdf(pdfModel(iv));
    const fname = ('Intervenants ' + (project.number || '') + ' - ' + (project.name || '')).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() + '.pdf';
    return { filename: fname, dataBase64: Buffer.from(bytes).toString('base64') };
  },

  /** Envoi d'un courriel à plusieurs intervenants du projet (choisis dans la liste). */
  async ivSend(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const to = Array.from(new Set((Array.isArray(b.to) ? b.to : []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean)));
    if (!to.length) throw { status: 400, message: 'Choisissez au moins un destinataire.' };
    if (to.length > 80) throw { status: 400, message: 'Maximum 80 destinataires par envoi.' };
    const badMail = to.find(e => !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e));
    if (badMail) throw { status: 400, message: 'Courriel invalide : ' + badMail };
    // Seules les adresses réellement liées au projet peuvent recevoir l'envoi
    const iv = await buildInterv(project);
    const allowed = new Set([iv.owner.email, ...iv.cp.map(x => x.email), ...iv.cm.map(x => x.email), ...iv.coordo.map(x => x.email), ...iv.pros.map(x => x.email), ...iv.subs.map(x => x.email), ...iv.suppliers.map(x => x.email)]
      .map(e => String(e || '').trim().toLowerCase()).filter(Boolean));
    const outside = to.find(e => !allowed.has(e));
    if (outside) throw { status: 400, message: "Ce courriel n'est pas un intervenant de ce projet : " + outside };
    const subject = inv.str(b.subject, 200);
    const message = inv.str(b.message, 8000);
    if (!subject) throw { status: 400, message: "Indiquez l'objet du courriel." };
    if (!message) throw { status: 400, message: 'Écrivez le message.' };
    const attachments = [];
    const files = Array.isArray(b.files) ? b.files : [];
    if (files.length > 5) throw { status: 400, message: 'Maximum 5 pièces jointes.' };
    let total = 0;
    for (const f of files) {
      const name = String(f && f.name || 'fichier').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 120) || 'fichier';
      if (/\.(exe|bat|cmd|com|scr|js|vbs|msi|ps1|jar|dll)$/i.test(name)) throw { status: 400, message: 'Type de fichier non permis : ' + name };
      const buf = Buffer.from(String(f && f.dataBase64 || ''), 'base64');
      if (!buf.length) throw { status: 400, message: 'Pièce jointe vide : ' + name };
      total += buf.length;
      attachments.push({ filename: name, content: buf });
    }
    if (total > 3.2 * 1024 * 1024) throw { status: 413, message: 'Pièces jointes trop volumineuses (maximum environ 3 Mo au total).' };
    if (b.attachPdf) {
      const bytes = await buildIntervenantsPdf(pdfModel(iv));
      attachments.push({ filename: ('Intervenants ' + project.number + '.pdf'), content: Buffer.from(bytes), contentType: 'application/pdf' });
    }
    const body = message.split(/\n{2,}/).map(p => '<p style="margin:0 0 12px">' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
    const sig = '<p style="margin:16px 0 0;color:#1b2a41"><b>' + esc(user.name || user.email) + '</b><br>Les Entreprises Philippe Denis inc.<br>Projet ' + esc(project.number) + ' — ' + esc(project.name) + '</p>';
    const html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:620px">' + body + sig +
      '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
    const text = message + '\n\n' + (user.name || user.email) + '\nLes Entreprises Philippe Denis inc.\nProjet ' + project.number + ' — ' + project.name;
    const hide = b.hideRecipients !== false; // par défaut : copie cachée (les intervenants ne voient pas les adresses des autres)
    await mail.sendMail({ to: hide ? user.email : to.join(', '), bcc: hide ? to.join(', ') : undefined, replyTo: user.email, subject, html, text, attachments });
    await q('INSERT INTO fin_mail_log (project_item_id, sent_by, subject, recipients, n) VALUES ($1,$2,$3,$4,$5)', [project.id, user.email, subject, to.join(', ').slice(0, 4000), to.length]);
    return { ok: true, sent: to.length };
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
    if (status >= 500) console.error('dashboard.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};

module.exports.buildInterv = buildInterv;
