// api/da.js
//
// Module « Dessins d'atelier (DA) et fiches techniques (FT) ».
//   POST { action, ... }  authentifié par Clerk. Accès : comptabilité + admins (tous les projets) ; chargé de projet (ses projets).
//
// Cycle d'un élément :
//   a_demander -> demande (courriel au fournisseur) -> recu (PDF du fournisseur déposé)
//   -> chez_pro (fiche + PDF envoyés au professionnel) -> approuve (VU / VU AVEC CORRECTIONS)
//                                                     \-> a_corriger (modifications demandées / rejeté) -> (fournisseur corrige) -> recu ...
// À l'approbation : copie dans SharePoint (« DA et FT ») + courriel au fournisseur avec le PDF final.

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const mail = require('./_lib/mail');
const inv = require('./_lib/invoice');
const po = require('./_lib/po');
const sp = require('./_lib/sharepoint');
const dash = require('./dashboard');
const dapdf = require('./_lib/dapdf');

const isId = v => /^\d+$/.test(String(v || ''));
const isUuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const str = po.str;
const CHUNK_B64 = 2097152;                    // taille d'un bloc base64 au téléchargement (multiple de 4)
const MAX_FILE = 20 * 1024 * 1024;
const mailLimit = () => (Number(process.env.DA_MAIL_LIMIT_MB) || 15) * 1024 * 1024;   // taille cumulée max des pièces jointes par courriel (avant de scinder)
const TYPES = ['DA', 'FT', 'ECH'];
const STATUSES = ['a_demander', 'demande', 'a_reviser', 'recu', 'chez_pro', 'a_corriger', 'approuve'];
const APPROVED_DECISIONS = ['vu', 'vu_corrections'];
const DECISION_LABEL = { vu: 'VU', vu_corrections: 'VU AVEC CORRECTIONS', modifier: 'Modifier et soumettre à nouveau', rejete: 'Rejeté / voir remarque' };
const SPECIALTIES = ['Architecture', 'Architecture de paysage', 'Ing Mécanique', 'Ing Électrique', 'Ing Civil', 'Ing Structure', 'Hygiène', 'LEED', 'Autre'];
const _OLD = ['Architecture', 'Structure', 'Civil', 'Mécanique', 'Électricité', 'Paysagement', 'Environnement', 'Géotechnique', 'Surveillance', 'Autre'];

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
async function loadDa(user, id) {
  if (!isUuid(id)) throw { status: 400, message: 'Identifiant invalide.' };
  const rows = await q('SELECT * FROM fin_da WHERE id = $1', [id]);
  if (!rows[0]) throw { status: 404, message: 'Élément introuvable.' };
  const ctx = await projectAccess(user, rows[0].project_item_id);
  return Object.assign({ da: rows[0] }, ctx);
}
/** Charge plusieurs éléments d'un même projet (contrôle d'accès inclus). */
async function loadMany(user, projectItemId, ids) {
  const { project } = await projectAccess(user, projectItemId);
  const list = (Array.isArray(ids) ? ids : []).filter(isUuid);
  if (!list.length) throw { status: 400, message: 'Sélectionnez au moins un élément.' };
  const rows = await q('SELECT * FROM fin_da WHERE project_item_id = $1 AND id = ANY($2::uuid[]) ORDER BY seq', [project.id, list]);
  const live = rows.filter(r => !r.deleted_at);
  if (!live.length) throw { status: 404, message: 'Éléments introuvables.' };
  return { project, rows: live };
}
async function logEvent(id, event, actor, detail) {
  await q('INSERT INTO fin_da_event (da_id, event, actor, detail) VALUES ($1,$2,$3,$4)', [id, event, actor || null, detail ? String(detail).slice(0, 4000) : null]);
}
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const spName = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').trim();
const fileSafe = s => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fmtD = d => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '';
const prefixOf = t => (TYPES.includes(t) ? t : 'DA');
const refOf = (t, seq) => prefixOf(t) + '-' + String(seq).padStart(3, '0');

function mailHtml(message, user) {
  return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:640px">' + esc(message).replace(/\n/g, '<br>') +
    '<p style="margin-top:18px">' + esc(user.name || user.email) + '<br>Les Entreprises Philippe Denis inc.</p>' +
    '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
}
/** Tableau HTML + texte des éléments listés dans un courriel. */
function listBlock(rows) {
  const th = 'style="text-align:left;padding:5px 8px;background:#eef2fa;border:1px solid #dde3ee;font-size:12.5px"';
  const td = 'style="padding:5px 8px;border:1px solid #dde3ee;font-size:13px;vertical-align:top"';
  const html = '<table style="border-collapse:collapse;margin:12px 0;width:100%"><tr><th ' + th + '>Réf.</th><th ' + th + '>Description</th><th ' + th + '>Section de devis</th></tr>' +
    rows.map(r => '<tr><td ' + td + '>' + esc(r.ref) + '</td><td ' + td + '>' + esc(r.description) + '</td><td ' + td + '>' + esc(r.spec_section || '') + '</td></tr>').join('') + '</table>';
  const text = rows.map(r => '  - ' + r.ref + ' : ' + r.description + (r.spec_section ? ' (section ' + r.spec_section + ')' : '')).join('\n');
  return { html, text };
}
/** Envoi d'un courriel dont le corps contient (optionnellement) le tableau des éléments. */
async function sendWithList({ user, to, cc, subject, message, rows, attachments }) {
  const lb = rows && rows.length ? listBlock(rows) : null;
  const parts = String(message || '').replace(/\r/g, '').split('{{LISTE}}');
  let html = '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1b2a41;max-width:640px">' + esc(parts[0]).replace(/\n/g, '<br>');
  if (parts.length > 1) html += (lb ? lb.html : '') + esc(parts.slice(1).join('')).replace(/\n/g, '<br>');
  html += '<p style="margin-top:18px">' + esc(user.name || user.email) + '<br>Les Entreprises Philippe Denis inc.</p>' +
    '<hr style="border:none;border-top:1px solid #dde3ee;margin:22px 0 10px"><div style="color:#7a879c;font-size:12px">Les Entreprises Philippe Denis inc. — 1810, rue J-A Roy, Joliette (Québec) J6E 9H6</div></div>';
  const text = parts.join(lb ? '\n' + lb.text + '\n' : '') + '\n\n' + (user.name || user.email) + '\nLes Entreprises Philippe Denis inc.';
  await mail.sendMail({ to: to.join(', '), cc: cc.join(', '), replyTo: user.email, subject, html, text, attachments: attachments || [] });
}
function cleanEmails(arr) {
  const list = Array.from(new Set((Array.isArray(arr) ? arr : String(arr || '').split(/[,;\s]+/)).map(e => str(e, 200).toLowerCase()).filter(Boolean)));
  const bad = list.find(e => !po.isEmail(e));
  if (bad) throw { status: 400, message: 'Courriel invalide : ' + bad };
  return list;
}
function ccFor(user, project, extra, to) {
  return Array.from(new Set([user.email].concat(project.cp.map(c => (c.email || '').toLowerCase()), (extra || []).map(e => String(e).toLowerCase())).filter(e => e && po.isEmail(e) && !to.includes(e))));
}
async function latestFile(daId, kind) {
  const r = await q('SELECT id, filename, data_b64, rev, created_at FROM fin_da_file WHERE da_id = $1 AND kind = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [daId, kind]);
  return r[0] ? { id: r[0].id, filename: r[0].filename, bytes: Buffer.from(r[0].data_b64, 'base64'), rev: r[0].rev } : null;
}
/** Tous les PDF « Reçu du fournisseur » du lot courant (déposés depuis le dernier envoi au professionnel), dans l'ordre de dépôt. */
async function supplierFiles(da) {
  const sent = da.sent_pro_at ? new Date(da.sent_pro_at).toISOString() : null;
  let r = await q(`SELECT id, filename, data_b64, rev FROM fin_da_file WHERE da_id = $1 AND kind = 'supplier' AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz) ORDER BY created_at ASC, id ASC`, [da.id, sent]);
  if (!r.length) r = await q(`SELECT id, filename, data_b64, rev FROM fin_da_file WHERE da_id = $1 AND kind = 'supplier' ORDER BY created_at DESC, id DESC LIMIT 1`, [da.id]);
  return r.map(x => ({ id: x.id, filename: x.filename, bytes: Buffer.from(x.data_b64, 'base64'), rev: x.rev }));
}
/** PDF « Demandes de modification » du lot courant (déposés depuis le dernier envoi des corrections), sinon le plus récent. */
async function commentFiles(da) {
  const since = da.corrections_sent_at ? new Date(da.corrections_sent_at).toISOString() : null;
  let r = await q(`SELECT id, filename, data_b64 FROM fin_da_file WHERE da_id = $1 AND kind = 'comments' AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz) ORDER BY created_at ASC, id ASC`, [da.id, since]);
  if (!r.length) r = await q(`SELECT id, filename, data_b64 FROM fin_da_file WHERE da_id = $1 AND kind = 'comments' ORDER BY created_at DESC, id DESC LIMIT 1`, [da.id]);
  return r.map(x => ({ id: x.id, filename: x.filename, bytes: Buffer.from(x.data_b64, 'base64') }));
}
async function storeFile(daId, kind, rev, filename, bytes, by) {
  const b64 = Buffer.from(bytes).toString('base64');
  const r = await q('INSERT INTO fin_da_file (da_id, kind, rev, filename, size_bytes, data_b64, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [daId, kind, rev, filename, Buffer.from(bytes).length, b64, by || null]);
  return r[0].id;
}
function rowOut(r) {
  const o = Object.assign({}, r);
  ['date_sent'].forEach(k => { o[k] = fmtD(r[k]) || null; });
  o.deleted = !!r.deleted_at;
  return o;
}
const COLS = `id, project_item_id, ref, da_type, seq, description, specialty, spec_section, supplier_item_id, supplier_name, supplier_contact, supplier_email,
  status, rev, date_sent, requested_at, last_reminder_at, reminders, received_at, sent_pro_at, corrections_sent_at, decision, approved_at, sharepoint_status, sharepoint_url, sharepoint_error, deleted_at,
  source, email_from, ai_notes, email_created`;

/** Crée un élément (numéro réservé automatiquement). vals : description, specialty, spec_section, supplier_* (déjà validés). */
async function insertDa(user, project, vals, type) {
  let id = null, ref = null;
  for (let t = 0; t < 4 && !id; t++) {
    const m = await q('SELECT COALESCE(MAX(seq), 0)::int AS m FROM fin_da WHERE project_item_id = $1', [project.id]);
    const seq = m[0].m + 1;
    try {
      const ins = await q(`INSERT INTO fin_da (project_item_id, project_number, project_name, seq, ref, da_type, description, specialty, spec_section,
          supplier_item_id, supplier_name, supplier_contact, supplier_email, created_by, updated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
        [project.id, project.number, project.name, seq, refOf(type, seq), type, vals.description, vals.specialty, vals.spec_section, vals.supplier_item_id, vals.supplier_name, vals.supplier_contact, vals.supplier_email, user.email]);
      id = ins[0].id; ref = refOf(type, seq);
    } catch (e) { if (!/duplicate|unique/i.test(String(e && e.message))) throw e; }
  }
  if (!id) throw { status: 409, message: 'Impossible de réserver un numéro. Réessayez.' };
  await logEvent(id, 'cree', user.email, String(vals.description || '').slice(0, 200));
  return { id, ref };
}

/**
 * Réception par courriel (boîte coordo) : crée ou retrouve l'élément, dépose le(s) PDF du fournisseur et passe l'élément à « À réviser ».
 * o : { id? (élément existant choisi), type, vals, files:[{filename, bytes}], notes:[{field,text}], emailFrom, subject, inboxId }
 * Rien n'est envoyé : le chargé de projets confirme la réception (action confirmReception).
 */
async function ingestFromEmail(user, project, o) {
  const notes = (o.notes || []).slice();
  let da = null;
  if (o.id && isUuid(o.id)) {
    const r = (await q('SELECT * FROM fin_da WHERE id = $1 AND project_item_id = $2', [o.id, project.id]))[0];
    if (r && !r.deleted_at) {
      if (['a_demander', 'demande', 'a_corriger', 'recu', 'a_reviser'].includes(r.status)) da = r;
      else notes.push({ field: 'Élément existant', text: r.ref + ' est déjà ' + (r.status === 'approuve' ? 'approuvé' : 'chez le professionnel') + ' : un nouvel élément a été créé (possible révision ou doublon).' });
    }
  }
  let created = false;
  if (!da) {
    const ins = await insertDa(user, project, o.vals, TYPES.includes(o.type) ? o.type : 'DA');
    da = (await q('SELECT * FROM fin_da WHERE id = $1', [ins.id]))[0] || Object.assign({ id: ins.id, ref: ins.ref, received_at: null, rev: 0 }, o.vals);
    created = true;
  }
  const crypto = require('crypto');
  const rev = da.received_at ? (Number(da.rev) || 0) + (da.status === 'a_reviser' ? 0 : 1) : 0;
  let stored = 0;
  for (const f of (o.files || [])) {
    const hash = crypto.createHash('sha256').update(f.bytes).digest('hex');
    const dup = await q("SELECT 1 FROM fin_da_file WHERE da_id = $1 AND sha256 = $2 LIMIT 1", [da.id, hash]);
    if (dup[0]) { notes.push({ field: 'Pièce jointe', text: '« ' + f.filename + ' » est déjà au dossier de ' + da.ref + ' (ignorée).' }); continue; }
    const b64 = Buffer.from(f.bytes).toString('base64');
    await q("INSERT INTO fin_da_file (da_id, kind, rev, filename, size_bytes, data_b64, uploaded_by, sha256) VALUES ($1,'supplier',$2,$3,$4,$5,$6,$7)",
      [da.id, rev, fileSafe(f.filename) || 'document.pdf', Buffer.from(f.bytes).length, b64, o.emailFrom || user.email, hash]);
    stored++;
  }
  if (!stored && !created) return { id: da.id, ref: da.ref, created, stored, unchanged: true, notes };
  if (stored > 1) notes.push({ field: 'Pièces jointes', text: stored + ' PDF reçus pour ' + da.ref + ' : seul le plus récent est utilisé pour la fiche d\'envoi au professionnel. Fusionnez-les au besoin.' });
  await q(`UPDATE fin_da SET status = 'a_reviser', received_at = COALESCE(received_at, now()), rev = $2, source = 'courriel', email_from = $3, ai_notes = $4::jsonb, inbox_id = $5,
      supplier_item_id = COALESCE(supplier_item_id, $6), supplier_name = COALESCE(supplier_name, $7), supplier_email = COALESCE(supplier_email, $8), supplier_contact = COALESCE(supplier_contact, $9),
      updated_by = $10, email_created = (COALESCE(email_created, false) OR $11), updated_at = now() WHERE id = $1`,
    [da.id, rev, o.emailFrom || null, JSON.stringify(notes), o.inboxId || null, o.vals.supplier_item_id || null, o.vals.supplier_name || null, o.vals.supplier_email || null, o.vals.supplier_contact || null, user.email, created]);
  await logEvent(da.id, 'recu_par_courriel', 'systeme', 'Courriel de ' + (o.emailFrom || '?') + ' : ' + String(o.subject || '').slice(0, 200));
  return { id: da.id, ref: da.ref, created, stored, notes };
}

async function projectInfo(project) {
  let owner = { name: (project.owner && project.owner.name) || '', email: (project.owner && project.owner.email) || '', phone: '' };
  try { const iv = await dash.buildInterv(project); if (iv && iv.owner) owner = { name: iv.owner.name || owner.name, email: iv.owner.email || owner.email, phone: iv.owner.phone || '' }; } catch (e) { /* facultatif */ }
  const cp0 = (project.cp || [])[0] || {};
  return { number: project.number, name: project.name, address: (project.owner && project.owner.address) || '', phone: owner.phone, ownerName: owner.name, ownerEmail: owner.email, cp: { name: cp0.name || '', email: cp0.email || '' } };
}

// ---------- SharePoint -------------------------------------------------------------------------------------

async function pushToSharePoint(da) {
  if (!sp.isConfigured()) {
    await q("UPDATE fin_da SET sharepoint_status = 'non_configure', sharepoint_error = NULL, updated_at = now() WHERE id = $1", [da.id]);
    return { status: 'non_configure' };
  }
  await q("UPDATE fin_da SET sharepoint_status = 'attente', sharepoint_error = NULL WHERE id = $1", [da.id]);
  try {
    const f = await latestFile(da.id, 'final');
    if (!f) throw new Error('PDF final introuvable.');
    // Nom court et sûr : « [Section de devis], Description (15 car. max) - A.pdf »
    const clean = v => spName(v).replace(/\s+/g, ' ').trim();
    const mk = x => (clean(x.spec_section) || clean(x.ref)) + ', ' + (clean(String(x.description || '').replace(/[._-]+/g, ' ')).slice(0, 15).trim() || clean(x.ref));
    const base = mk(da);
    const others = await q("SELECT id, ref, spec_section, description FROM fin_da WHERE project_item_id = $1 AND status = 'approuve' AND deleted_at IS NULL AND id <> $2 ORDER BY seq", [da.project_item_id, da.id]);
    const clash = (others || []).filter(o => mk(o) === base).length;
    const name = base + (clash ? ' ' + (clash + 1) : '') + ' - A.pdf';
    const out = await sp.uploadDa(da, f.bytes, name);
    await q("UPDATE fin_da SET sharepoint_status = 'reussi', sharepoint_url = $2, sharepoint_error = NULL, updated_at = now() WHERE id = $1", [da.id, (out && out.webUrl) || null]);
    await logEvent(da.id, 'sharepoint_ok', 'systeme', out && out.path);
    return { status: 'reussi', url: out && out.webUrl, path: out && out.path };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    await q("UPDATE fin_da SET sharepoint_status = 'echec', sharepoint_error = $2, updated_at = now() WHERE id = $1", [da.id, msg]);
    await logEvent(da.id, 'sharepoint_echec', 'systeme', msg);
    return { status: 'echec', error: msg };
  }
}

/** Courriel « DA approuvé » au fournisseur, avec le PDF final. */
async function mailApproved(user, project, da) {
  const f = await latestFile(da.id, 'final');
  if (!f || !da.supplier_email) return { sent: false, reason: da.supplier_email ? 'PDF final introuvable' : 'Aucun courriel de fournisseur' };
  const to = cleanEmails([da.supplier_email]);
  const cc = ccFor(user, project, [], to);
  const label = da.decision === 'vu_corrections' ? 'approuvé avec corrections (VU AVEC CORRECTIONS)' : 'approuvé (VU)';
  const message = 'Bonjour' + (da.supplier_contact ? ' ' + da.supplier_contact : '') + ',\n\nLe document suivant est ' + label + ' par le professionnel pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\n' +
    "Vous trouverez ci-joint la version finale approuvée. Vous pouvez procéder à la commande du matériel" + (da.decision === 'vu_corrections' ? ', en tenant compte des corrections indiquées sur le document' : '') + '.\n\nMerci de votre collaboration.';
  await sendWithList({ user, to, cc, subject: 'DA approuvé — ' + da.ref + ' — Projet ' + project.number + ' ' + project.name, message, rows: [da],
    attachments: [{ filename: fileSafe(da.ref + ' - Approuve.pdf'), content: f.bytes, contentType: 'application/pdf' }] });
  return { sent: true, to };
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

  async lookups() {
    const sups = await monday.fetchSuppliers();
    return { suppliers: sups.filter(s => !s.blacklisted).map(s => ({ id: s.id, name: s.name, email: (s.emails && s.emails[0]) || '', emails: s.emails || [] })), specialties: SPECIALTIES };
  },

  async list(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = await q(`SELECT ${COLS}, (SELECT count(*)::int FROM fin_da_file f WHERE f.da_id = fin_da.id AND f.kind = 'supplier') AS n_supplier,
        (SELECT count(*)::int FROM fin_da_file f WHERE f.da_id = fin_da.id AND f.kind = 'comments') AS n_comments,
        (SELECT count(*)::int FROM fin_da_file f WHERE f.da_id = fin_da.id AND f.kind = 'final') AS n_final
        FROM fin_da WHERE project_item_id = $1 ORDER BY seq`, [project.id]);
    return { project: { id: project.id, number: project.number, name: project.name }, items: rows.map(rowOut), sharepointConfigured: sp.isConfigured() };
  },

  /** Tous les éléments des projets accessibles (affichage « Par projets »), sans les supprimés. */
  async listAll(user) {
    const w = await who(user);
    // Comptabilité/admin : tout est lu dans Neon (aucun appel à Monday => affichage rapide). Chargé de projet : ses projets selon Monday.
    const mine = w.isAccounting ? null : (await monday.fetchProjectsLite(false)).filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    const ids = mine ? mine.map(p => String(p.id)) : [];
    const all = !mine;
    const rows = (all || ids.length) ? await q(`SELECT ${COLS}, project_number, project_name FROM fin_da WHERE ($2::boolean OR project_item_id = ANY($1::text[])) AND deleted_at IS NULL ORDER BY project_number, seq`, [ids, all]) : [];
    return { projects: mine ? mine.map(p => ({ id: String(p.id), number: p.number, name: p.name })) : distinctProjects(rows), items: rows.map(rowOut) };
  },

  /** Ajout / modification en lot. rows: [{ id?, type, description, specialty, specSection, supplierItemId, supplierName, supplierEmail, supplierContact, dateSent }] */
  async saveItems(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (rows.length > 200) throw { status: 400, message: 'Maximum 200 lignes à la fois.' };
    let created = 0, updated = 0;
    for (const r of rows) {
      const description = str(r.description, 500);
      if (!description) { if (r.id) throw { status: 400, message: 'La description est obligatoire.' }; continue; }
      const type = TYPES.includes(r.type) ? r.type : 'DA';
      const vals = { description, specialty: SPECIALTIES.includes(r.specialty) ? r.specialty : null, spec_section: str(r.specSection, 40) || null,
        supplier_item_id: isId(r.supplierItemId) ? String(r.supplierItemId) : null, supplier_name: str(r.supplierName, 200) || null,
        supplier_contact: str(r.supplierContact, 120) || null, supplier_email: str(r.supplierEmail, 200).toLowerCase() || null };
      if (vals.supplier_email && !po.isEmail(vals.supplier_email)) throw { status: 400, message: 'Courriel invalide : ' + vals.supplier_email };
      if (r.id) {
        if (!isUuid(r.id)) throw { status: 400, message: 'Identifiant invalide.' };
        const cur = await q('SELECT * FROM fin_da WHERE id = $1 AND project_item_id = $2', [r.id, project.id]);
        if (!cur[0]) throw { status: 404, message: 'Élément introuvable.' };
        if (cur[0].status === 'approuve') continue;                       // verrouillé
        let ref = cur[0].ref;
        if (type !== cur[0].da_type) ref = refOf(type, cur[0].seq);
        await q(`UPDATE fin_da SET da_type=$2, ref=$3, description=$4, specialty=$5, spec_section=$6, supplier_item_id=$7, supplier_name=$8, supplier_contact=$9, supplier_email=$10,
            updated_by=$11, updated_at=now() WHERE id=$1`,
          [r.id, type, ref, vals.description, vals.specialty, vals.spec_section, vals.supplier_item_id, vals.supplier_name, vals.supplier_contact, vals.supplier_email, user.email]);
        updated++;
      } else {
        await insertDa(user, project, vals, type);
        created++;
      }
    }
    return { ok: true, created, updated };
  },

  /** Suppression douce : l'élément passe dans le groupe « Supprimés » (rien n'est perdu) et peut être restauré. */
  async deleteItem(user, b) {
    const { da } = await loadDa(user, b.id);
    await q('UPDATE fin_da SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1', [da.id, user.email]);
    await logEvent(da.id, 'supprime', user.email, da.status);
    return { ok: true };
  },

  async restoreItem(user, b) {
    const { da } = await loadDa(user, b.id);
    await q('UPDATE fin_da SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1', [da.id]);
    await logEvent(da.id, 'restaure', user.email, null);
    return { ok: true };
  },

  async get(user, b) {
    const { da } = await loadDa(user, b.id);
    const [files, events] = await Promise.all([
      q('SELECT id, kind, rev, filename, size_bytes, uploaded_by, created_at FROM fin_da_file WHERE da_id = $1 ORDER BY created_at, id', [da.id]),
      q('SELECT event, actor, detail, at FROM fin_da_event WHERE da_id = $1 ORDER BY at DESC, id DESC LIMIT 100', [da.id])
    ]);
    return { item: rowOut(da), files, events };
  },

  /** Destinataires possibles (professionnels du projet) pour l'envoi pour approbation. */
  async recipients(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const iv = await dash.buildInterv(project);
    const specs = new Set((Array.isArray(b.specialties) ? b.specialties : []).map(norm).filter(Boolean));
    const seen = new Set(), list = [];
    (iv.pros || []).forEach(p => {
      const e = String(p.email || '').trim().toLowerCase(); if (!e || seen.has(e)) return; seen.add(e);
      const ps = norm(p.specialty);
      const match = !!ps && Array.from(specs).some(s => (s.indexOf('paysage') >= 0 && ps.indexOf('paysag') === 0) || s === ps || s.indexOf(ps) >= 0 || ps.indexOf(s) >= 0 || (s.slice(0, 5) && ps.slice(0, 5) === s.slice(0, 5)));
      list.push({ name: p.contact || '', company: p.company || '', specialty: p.specialty || '', email: e, suggested: match });
    });
    return { recipients: list, cc: ccFor(user, project, [], []) };
  },

  /** UN courriel par fournisseur contenant tous les éléments sélectionnés. */
  async requestSuppliers(user, b) {
    const { project, rows } = await loadMany(user, b.projectItemId, b.ids);
    const todo = rows.filter(r => r.status === 'a_demander');
    if (!todo.length) throw { status: 409, message: "Aucun élément « À demander » dans la sélection." };
    const missing = todo.filter(r => !r.supplier_email);
    if (missing.length) throw { status: 400, message: 'Courriel du fournisseur manquant pour : ' + missing.map(m => m.ref).join(', ') + '.' };
    const groups = groupBySupplier(todo);
    const sent = [];
    for (const g of groups) {
      const to = cleanEmails([g.email]);
      const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
      const contact = g.rows.find(r => r.supplier_contact);
      const message = String(b.message || '').replace(/\r/g, '').slice(0, 4000).split('[FOURNISSEUR]').join(contact ? contact.supplier_contact : g.name) ||
        defaultRequestText(project, contact ? contact.supplier_contact : '');
      const subject = str(b.subject, 200) || ('Demande de dessins d\'atelier / fiches techniques — Projet ' + project.number + ' ' + project.name);
      await sendWithList({ user, to, cc, subject, message: message.indexOf('{{LISTE}}') >= 0 ? message : message + '\n\n{{LISTE}}', rows: g.rows });
      for (const r of g.rows) {
        await q("UPDATE fin_da SET status='demande', requested_at=now(), date_sent=CURRENT_DATE, updated_by=$2, updated_at=now() WHERE id=$1", [r.id, user.email]);
        await logEvent(r.id, 'demande', user.email, to.join(', '));
      }
      sent.push({ supplier: g.name, to, count: g.rows.length });
    }
    return { ok: true, sent };
  },

  /** Relance : un courriel par fournisseur pour les éléments toujours en attente (« Demandé »). */
  async remind(user, b) {
    const { project, rows } = await loadMany(user, b.projectItemId, b.ids);
    const todo = rows.filter(r => r.status === 'demande');
    if (!todo.length) throw { status: 409, message: "Aucun élément « Demandé au fournisseur » dans la sélection." };
    const sent = [];
    for (const g of groupBySupplier(todo)) {
      if (!g.email) continue;
      const to = cleanEmails([g.email]);
      const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
      const contact = g.rows.find(r => r.supplier_contact);
      const message = String(b.message || '').replace(/\r/g, '').slice(0, 4000).split('[FOURNISSEUR]').join(contact ? contact.supplier_contact : g.name) ||
        ('Bonjour' + (contact ? ' ' + contact.supplier_contact : '') + ',\n\nCeci est un rappel : nous sommes toujours en attente des documents suivants pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nMerci de nous les transmettre dans les meilleurs délais, car ils sont requis pour l\'approbation des professionnels et le respect de l\'échéancier.');
      const subject = str(b.subject, 200) || ('RAPPEL — Dessins d\'atelier / fiches techniques — Projet ' + project.number + ' ' + project.name);
      await sendWithList({ user, to, cc, subject, message: message.indexOf('{{LISTE}}') >= 0 ? message : message + '\n\n{{LISTE}}', rows: g.rows });
      for (const r of g.rows) {
        await q("UPDATE fin_da SET reminders = reminders + 1, last_reminder_at = now(), updated_by = $2, updated_at = now() WHERE id = $1", [r.id, user.email]);
        await logEvent(r.id, 'relance', user.email, to.join(', '));
      }
      sent.push({ supplier: g.name, to, count: g.rows.length });
    }
    if (!sent.length) throw { status: 400, message: 'Aucun courriel de fournisseur disponible.' };
    return { ok: true, sent };
  },

  // --- Fichiers par blocs (la limite de corps Vercel est 4,5 Mo) ---
  async fileChunk(user, b) {
    await loadDa(user, b.id);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const idx = parseInt(b.idx, 10);
    const data = String(b.data || '');
    if (!(idx >= 0 && idx < 20) || !data || data.length > 2200000 || /[^A-Za-z0-9+/=]/.test(data)) throw { status: 400, message: 'Bloc invalide.' };
    await q('INSERT INTO fin_change_chunk (upload_id, idx, data_b64) VALUES ($1,$2,$3) ON CONFLICT (upload_id, idx) DO UPDATE SET data_b64 = EXCLUDED.data_b64', [up, idx, data]);
    return { ok: true };
  },

  /** kind : supplier (PDF du fournisseur -> « Reçu »), comments (PDF du professionnel avec modifications -> « Corrections demandées »), final (PDF final approuvé). */
  async fileFinish(user, b) {
    const { da } = await loadDa(user, b.id);
    if (da.status === 'approuve') throw { status: 409, message: 'Élément approuvé : documents verrouillés.' };
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const kind = ['supplier', 'comments', 'final'].includes(b.kind) ? b.kind : null;
    if (!kind) throw { status: 400, message: 'Type de document invalide.' };
    const filename = fileSafe(b.filename || 'document.pdf') || 'document.pdf';
    const n = parseInt(b.count, 10);
    const cnt = await q('SELECT count(*)::int AS n FROM fin_change_chunk WHERE upload_id = $1', [up]);
    if (!(n > 0) || cnt[0].n !== n) throw { status: 400, message: 'Téléversement incomplet (' + cnt[0].n + '/' + n + ' blocs). Réessayez.' };
    const rev = kind === 'supplier' ? (da.received_at ? (Number(da.rev) || 0) + 1 : 0) : (Number(da.rev) || 0);
    const ins = await q(`INSERT INTO fin_da_file (da_id, kind, rev, filename, size_bytes, data_b64, uploaded_by)
        SELECT $1, $2, $3, $4, 0, string_agg(data_b64, '' ORDER BY idx), $6 FROM fin_change_chunk WHERE upload_id = $5 RETURNING id, length(data_b64) AS len`,
      [da.id, kind, rev, filename, up, user.email]);
    await q('DELETE FROM fin_change_chunk WHERE upload_id = $1', [up]);
    const size = Math.floor(Number(ins[0].len) * 3 / 4);
    if (size > MAX_FILE) { await q('DELETE FROM fin_da_file WHERE id = $1', [ins[0].id]); throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' }; }
    // On vérifie que c'est bien un PDF lisible (évite de bloquer plus tard l'assemblage)
    const head = await q('SELECT substr(data_b64, 1, 8) AS h FROM fin_da_file WHERE id = $1', [ins[0].id]);
    if (Buffer.from(head[0].h, 'base64').toString('latin1').slice(0, 4) !== '%PDF') {
      await q('DELETE FROM fin_da_file WHERE id = $1', [ins[0].id]);
      throw { status: 400, message: 'Le fichier doit être un PDF.' };
    }
    await q('UPDATE fin_da_file SET size_bytes = $2 WHERE id = $1', [ins[0].id, size]);
    await logEvent(da.id, 'fichier_' + kind, user.email, filename);
    if (kind === 'supplier') {
      await q("UPDATE fin_da SET status = 'recu', received_at = now(), rev = $2, decision = NULL, updated_by = $3, updated_at = now() WHERE id = $1", [da.id, rev, user.email]);
    } else if (kind === 'comments') {
      await q("UPDATE fin_da SET status = 'a_corriger', decision = COALESCE($2, decision), updated_by = $3, updated_at = now() WHERE id = $1", [da.id, DECISION_LABEL[b.decision] ? b.decision : null, user.email]);
    }
    return { ok: true, id: ins[0].id };
  },

  async fileDelete(user, b) {
    const { da } = await loadDa(user, b.id);
    if (da.status === 'approuve') throw { status: 409, message: 'Élément approuvé : documents verrouillés.' };
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const r = await q('DELETE FROM fin_da_file WHERE id = $1 AND da_id = $2 RETURNING filename', [b.fileId, da.id]);
    if (r[0]) await logEvent(da.id, 'fichier_supprime', user.email, r[0].filename);
    return { ok: true };
  },

  async fileGetChunk(user, b) {
    const { da } = await loadDa(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = await q('SELECT filename, length(data_b64) AS len, substr(data_b64, $3::int, $4::int) AS part FROM fin_da_file WHERE id = $1 AND da_id = $2', [b.fileId, da.id, idx * CHUNK_B64 + 1, CHUNK_B64]);
    if (!r[0]) throw { status: 404, message: 'Fichier introuvable.' };
    return { filename: r[0].filename, data: r[0].part || '', chunks: Math.max(1, Math.ceil(Number(r[0].len) / CHUNK_B64)), idx };
  },

  /** Aperçu de la fiche + PDF fournisseur (ne modifie rien). */
  async preview(user, b) {
    const { da, project } = await loadDa(user, b.id);
    const sup = await supplierFiles(da);
    if (!sup.length) throw { status: 400, message: "Déposez d'abord le PDF du fournisseur." };
    const pj = await projectInfo(project);
    const fiche = await dapdf.buildFiche({ project: pj, cp: pj.cp, da: ficheDa(da, b.dateSent) });
    const out = await dapdf.assemble(fiche, sup.map(x => x.bytes), sup.map(x => x.filename));
    return { pdfBase64: Buffer.from(out).toString('base64'), filename: fileSafe(da.ref + ' - Pour approbation.pdf') };
  },

  /** Envoi pour approbation : fiche + PDF fournisseur ; plusieurs DA par courriel, scindé si la taille cumulée dépasse la limite. */
  async sendToPro(user, b) {
    const { project, rows } = await loadMany(user, b.projectItemId, b.ids);
    const todo = rows.filter(r => r.status === 'recu');
    if (!todo.length) throw { status: 409, message: "Aucun élément « Reçu du fournisseur » dans la sélection." };
    const to = cleanEmails(b.to);
    if (!to.length) throw { status: 400, message: 'Choisissez au moins un destinataire.' };
    const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
    const pj = await projectInfo(project);
    const sentDate = dateOrNull(b.dateSent) || today();
    const built = [];
    for (const r of todo) {
      const sup = await supplierFiles(r);
      if (!sup.length) throw { status: 400, message: r.ref + " : PDF du fournisseur manquant." };
      const rr = Object.assign({}, r, { date_sent: sentDate });
      const fiche = await dapdf.buildFiche({ project: pj, cp: pj.cp, da: ficheDa(rr, sentDate) });
      const out = Buffer.from(await dapdf.assemble(fiche, sup.map(x => x.bytes), sup.map(x => x.filename)));
      built.push({ row: r, bytes: out, filename: fileSafe(r.ref + (r.rev ? ' Rev' + r.rev : '') + ' - ' + (r.description || '').slice(0, 40) + '.pdf') });
    }
    // Paquets : taille cumulée <= MAIL_LIMIT (un DA plus gros que la limite part seul)
    const batches = [];
    let cur = [], size = 0;
    built.forEach(x => {
      if (cur.length && size + x.bytes.length * 1.37 > mailLimit()) { batches.push(cur); cur = []; size = 0; }
      cur.push(x); size += x.bytes.length * 1.37;
    });
    if (cur.length) batches.push(cur);
    const baseMsg = String(b.message || '').replace(/\r/g, '').slice(0, 4000) ||
      ('Bonjour,\n\nVeuillez trouver ci-joint, pour approbation, les dessins d\'atelier / fiches techniques suivants pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nMerci de nous retourner les documents annotés dans les meilleurs délais.');
    const sentAt = new Date().toISOString();
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const part = batches.length > 1 ? ' (courriel ' + (i + 1) + ' de ' + batches.length + ')' : '';
      const subject = (str(b.subject, 200) || ('DA / FT pour approbation — Projet ' + project.number + ' ' + project.name)) + part;
      await sendWithList({ user, to, cc, subject, message: baseMsg.indexOf('{{LISTE}}') >= 0 ? baseMsg : baseMsg + '\n\n{{LISTE}}', rows: batch.map(x => x.row),
        attachments: batch.map(x => ({ filename: x.filename, content: x.bytes, contentType: 'application/pdf' })) });
      for (const x of batch) {
        await storeFile(x.row.id, 'assembled', x.row.rev, x.filename, x.bytes, user.email);
        await q("UPDATE fin_da SET status = 'chez_pro', sent_pro_at = $2, decision = NULL, updated_by = $3, updated_at = now() WHERE id = $1", [x.row.id, sentAt, user.email]);
        await logEvent(x.row.id, 'envoye_pro', user.email, to.join(', '));
      }
    }
    return { ok: true, emails: batches.length, count: built.length, to };
  },

  /** Renvoie au fournisseur le PDF avec les demandes de modification (un courriel par fournisseur). */
  async sendBack(user, b) {
    const { project, rows } = await loadMany(user, b.projectItemId, b.ids);
    const todo = rows.filter(r => r.status === 'a_corriger');
    if (!todo.length) throw { status: 409, message: "Aucun élément « Corrections demandées » dans la sélection." };
    const sent = [];
    for (const g of groupBySupplier(todo)) {
      if (!g.email) throw { status: 400, message: 'Courriel du fournisseur manquant : ' + g.name };
      const to = cleanEmails([g.email]);
      const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
      const attachments = [];
      for (const r of g.rows) {
        const fs_ = await commentFiles(r);
        if (!fs_.length) throw { status: 400, message: r.ref + " : déposez d'abord le PDF avec les demandes de modification." };
        fs_.forEach((f, k) => attachments.push({ filename: fileSafe(r.ref + ' - Corrections demandees' + (fs_.length > 1 ? ' (' + (k + 1) + ')' : '') + '.pdf'), content: f.bytes, contentType: 'application/pdf' }));
      }
      const contact = g.rows.find(r => r.supplier_contact);
      const message = String(b.message || '').replace(/\r/g, '').slice(0, 4000).split('[FOURNISSEUR]').join(contact ? contact.supplier_contact : g.name) ||
        ('Bonjour' + (contact ? ' ' + contact.supplier_contact : '') + ',\n\nLe professionnel a analysé les documents suivants pour le projet ' + project.number + ' — ' + project.name + ' et demande des modifications. Vous trouverez ci-joint les documents annotés :\n\n{{LISTE}}\nMerci de produire les versions corrigées et de nous les retourner dans les meilleurs délais.');
      const subject = str(b.subject, 200) || ('DA / FT — corrections demandées — Projet ' + project.number + ' ' + project.name);
      await sendWithList({ user, to, cc, subject, message: message.indexOf('{{LISTE}}') >= 0 ? message : message + '\n\n{{LISTE}}', rows: g.rows, attachments });
      for (const r of g.rows) {
        await q("UPDATE fin_da SET corrections_sent_at = now(), updated_by = $2, updated_at = now() WHERE id = $1", [r.id, user.email]);
        await logEvent(r.id, 'corrections_envoyees', user.email, to.join(', '));
      }
      sent.push({ supplier: g.name, to, count: g.rows.length });
    }
    return { ok: true, sent };
  },

  /** Décision du professionnel. VU / VU AVEC CORRECTIONS => approuvé (PDF final requis). Autres => retour au fournisseur. */
  async decide(user, b) {
    const { da, project } = await loadDa(user, b.id);
    if (da.status === 'approuve') throw { status: 409, message: 'Déjà approuvé.' };
    const decision = String(b.decision || '');
    if (!DECISION_LABEL[decision]) throw { status: 400, message: 'Décision invalide.' };
    if (!['chez_pro', 'a_corriger', 'recu'].includes(da.status)) throw { status: 409, message: "Cet élément n'a pas encore été envoyé au professionnel." };
    if (APPROVED_DECISIONS.includes(decision)) {
      const fin = await latestFile(da.id, 'final');
      if (!fin) throw { status: 400, message: "Déposez d'abord le PDF final approuvé." };
      await q("UPDATE fin_da SET status = 'approuve', decision = $2, approved_at = now(), updated_by = $3, updated_at = now() WHERE id = $1", [da.id, decision, user.email]);
      await logEvent(da.id, 'approuve', user.email, DECISION_LABEL[decision]);
      const fresh = (await q('SELECT * FROM fin_da WHERE id = $1', [da.id]))[0];
      const sharepoint = await pushToSharePoint(fresh);
      let supplierMail = { sent: false };
      try { supplierMail = await mailApproved(user, project, fresh); if (supplierMail.sent) await logEvent(da.id, 'courriel_fournisseur', user.email, supplierMail.to.join(', ')); }
      catch (e) { supplierMail = { sent: false, error: (e && e.message) || String(e) }; await logEvent(da.id, 'courriel_fournisseur_echec', user.email, supplierMail.error); }
      return { ok: true, status: 'approuve', sharepoint, supplierMail };
    }
    await q("UPDATE fin_da SET status = 'a_corriger', decision = $2, updated_by = $3, updated_at = now() WHERE id = $1", [da.id, decision, user.email]);
    await logEvent(da.id, 'corrections', user.email, DECISION_LABEL[decision] + (b.note ? ' — ' + str(b.note, 500) : ''));
    return { ok: true, status: 'a_corriger' };
  },

  inboxList: (user) => require('./_lib/coordo').INBOX.inboxList(user, { kind: 'da' }),
  inboxGet: (user, b) => require('./_lib/coordo').INBOX.inboxGet(user, b),
  inboxDismiss: (user, b) => require('./_lib/coordo').INBOX.inboxDismiss(user, b),

  /** Revue d'un élément préparé par courriel : le chargé de projets confirme la réception du PDF (-> « Reçu du fournisseur »). */
  async confirmReception(user, b) {
    const { da } = await loadDa(user, b.id);
    if (da.status !== 'a_reviser') throw { status: 409, message: "Cet élément n'est pas à réviser." };
    const f = await q("SELECT 1 FROM fin_da_file WHERE da_id = $1 AND kind = 'supplier' LIMIT 1", [da.id]);
    if (!f[0]) throw { status: 400, message: 'Aucun PDF du fournisseur au dossier.' };
    await q("UPDATE fin_da SET status = 'recu', updated_by = $2, updated_at = now() WHERE id = $1", [da.id, user.email]);
    await logEvent(da.id, 'reception_confirmee', user.email, null);
    return { ok: true };
  },

  /** Refus de la préparation automatique : retire les PDF reçus par courriel et remet l'élément dans son état précédent (ou le supprime s'il a été créé par le système). */
  async reviewDismiss(user, b) {
    const { da } = await loadDa(user, b.id);
    if (da.status !== 'a_reviser') throw { status: 409, message: "Cet élément n'est pas à réviser." };
    await q("DELETE FROM fin_da_file WHERE da_id = $1 AND kind = 'supplier' AND uploaded_by = $2", [da.id, da.email_from || '']);
    if (da.email_created) {
      await q('UPDATE fin_da SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1', [da.id, user.email]);
    } else {
      const left = await q("SELECT 1 FROM fin_da_file WHERE da_id = $1 AND kind = 'supplier' LIMIT 1", [da.id]);
      await q("UPDATE fin_da SET status = $2, received_at = CASE WHEN $3 THEN received_at ELSE NULL END, ai_notes = '[]'::jsonb, source = NULL, updated_by = $4, updated_at = now() WHERE id = $1",
        [da.id, left[0] ? 'recu' : (da.requested_at ? 'demande' : 'a_demander'), !!left[0], user.email]);
    }
    await logEvent(da.id, 'revision_refusee', user.email, null);
    return { ok: true };
  },

  async spRetry(user, b) {
    const { da } = await loadDa(user, b.id);
    if (da.status !== 'approuve') throw { status: 409, message: "L'élément n'est pas approuvé." };
    return { sharepoint: await pushToSharePoint(da) };
  },

  async resendApproved(user, b) {
    const { da, project } = await loadDa(user, b.id);
    if (da.status !== 'approuve') throw { status: 409, message: "L'élément n'est pas approuvé." };
    const r = await mailApproved(user, project, da);
    if (r.sent) await logEvent(da.id, 'courriel_fournisseur', user.email, r.to.join(', '));
    if (!r.sent) throw { status: 400, message: r.reason || 'Courriel non envoyé.' };
    return { ok: true, to: r.to };
  },

  /** Tableau sommaire PDF, par professionnel. */
  async summary(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const rows = await q(`SELECT ref, description, specialty, spec_section, supplier_name, date_sent, status, approved_at FROM fin_da WHERE project_item_id = $1 AND deleted_at IS NULL ORDER BY seq`, [project.id]);
    const items = rows.map(r => ({ ref: r.ref, description: r.description, specialty: r.specialty, spec_section: r.spec_section, supplier_name: r.supplier_name,
      date_sent: fmtD(r.date_sent), status: r.status, approved_at: r.approved_at ? fmtD(r.approved_at) : '' }));
    if (!items.length) throw { status: 400, message: "Aucun élément à inclure dans le sommaire." };
    const bytes = await dapdf.buildSummary({ project: { number: project.number, name: project.name }, items });
    return { pdfBase64: Buffer.from(bytes).toString('base64'), filename: 'Sommaire DA et FT - ' + fileSafe(project.number) + '.pdf' };
  }
};

function ficheDa(r, dateSent) {
  return { ref: r.ref, type: r.da_type, description: r.description, specialty: r.specialty, spec_section: r.spec_section, supplier_name: r.supplier_name,
    supplier_contact: r.supplier_contact, date_sent: dateOrNull(dateSent) || today(), rev: Number(r.rev) || 0 };
}
function groupBySupplier(rows) {
  const m = new Map();
  rows.forEach(r => {
    const key = (r.supplier_email || '') + '|' + (r.supplier_item_id || r.supplier_name || '');
    if (!m.has(key)) m.set(key, { name: r.supplier_name || r.supplier_email || '', email: r.supplier_email || '', rows: [] });
    m.get(key).rows.push(r);
  });
  return Array.from(m.values());
}
function defaultRequestText(project, contact) {
  return 'Bonjour' + (contact ? ' ' + contact : '') + ',\n\nDans le cadre du projet ' + project.number + ' — ' + project.name + ', nous vous demandons de nous fournir les dessins d\'atelier, fiches techniques et/ou échantillons suivants afin de les soumettre pour approbation aux professionnels :\n\n{{LISTE}}\nMerci de nous transmettre les documents en format PDF dans les meilleurs délais.';
}

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
    if (status >= 500) console.error('da.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
module.exports.ACTIONS = ACTIONS;
module.exports.ingestFromEmail = ingestFromEmail;
module.exports.TYPES = TYPES;
module.exports.SPECIALTIES = SPECIALTIES;
