// api/fc.js
//
// Module « Documents de fin de chantier ».
//   POST { action, ... }  authentifié par Clerk. Accès : comptabilité + admins (tous les projets) ; chargé de projet (ses projets).
//
// La liste se construit automatiquement : documents d'EPD + documents de chaque sous-traitant ayant un bon de commande ENVOYÉ
// (buildInterv : envoye / vu / signe). Les éléments sont modifiables (non applicable, ajout d'éléments, ajout d'un sous-traitant).
// Statuts : a_demander -> demande (courriel envoyé) -> recu (fichier déposé; copie dans SharePoint « Fin de chantier »).

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const inv = require('./_lib/invoice');
const po = require('./_lib/po');
const sp = require('./_lib/sharepoint');
const dash = require('./dashboard');
const mx = require('./_lib/mailx');

const { str, cleanEmails, ccFor, fileSafe } = mx;
const isId = v => /^\d+$/.test(String(v || ''));
const isUuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const CHUNK_B64 = 2097152;
const MAX_FILE = 20 * 1024 * 1024;
const STATUSES = ['a_demander', 'demande', 'recu'];     // « a_reviser » n'est posé que par la réception par courriel (boîte coordo) et quitté par approve / reject

// short = nom court utilisé dans SharePoint (sans accents ni caractères spéciaux)
const EPD_DOCS = [
  { code: 'ccq', label: 'Lettre de conformité CCQ', short: 'Lettre CCQ' },
  { code: 'cnesst', label: 'Lettre de conformité CNESST', short: 'Lettre CNESST' },
  { code: 'garantie_generale', label: 'Certificat de garantie général', short: 'Garantie generale' },
  { code: 'plan', label: 'Plan tel que construit', short: 'Plan TQC' }
];
const SUB_DOCS = [
  { code: 'ccq', label: 'Lettre de conformité CCQ', short: 'Lettre CCQ' },
  { code: 'cnesst', label: 'Lettre de conformité CNESST', short: 'Lettre CNESST' },
  { code: 'garantie', label: 'Lettres de garanties spécifiques', short: 'Garanties' },
  { code: 'manuel', label: "Manuels d'entretiens", short: 'Manuels' },
  { code: 'da', label: 'DA approuvés', short: 'DA approuves' },
  { code: 'plan', label: 'Plans tel que construits', short: 'Plans TQC' }
];
const SHORT = {}; EPD_DOCS.concat(SUB_DOCS).forEach(d => { SHORT[d.code] = d.short; });

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const spName = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const fmtD = d => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '';
const DEF_LABEL = 'Acceptation provisoire';
const labelOf = v => str(v, 60) || DEF_LABEL;
const deLabel = l => { const x = l.toLowerCase(); return (/^[aeiouyhàâéèêîôû]/.test(x) ? "d'" : 'de ') + x; };
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const longDate = d => { const s = fmtD(d); if (!s) return ''; try { return new Intl.DateTimeFormat('fr-CA', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(s + 'T00:00:00Z')); } catch (e) { return s; } };

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
async function loadItem(user, id) {
  if (!isUuid(id)) throw { status: 400, message: 'Identifiant invalide.' };
  const rows = await q('SELECT * FROM fin_fc_item WHERE id = $1', [id]);
  if (!rows[0]) throw { status: 404, message: 'Élément introuvable.' };
  const ctx = await projectAccess(user, rows[0].project_item_id);
  return Object.assign({ item: rows[0] }, ctx);
}
async function logEvent(itemId, projectId, event, actor, detail) {
  await q('INSERT INTO fin_fc_event (item_id, project_item_id, event, actor, detail) VALUES ($1,$2,$3,$4,$5)', [itemId || null, projectId, event, actor || null, detail ? String(detail).slice(0, 4000) : null]);
}
async function ensureProject(project) {
  await q(`INSERT INTO fin_fc_project (project_item_id, project_number, project_name) VALUES ($1,$2,$3)
      ON CONFLICT (project_item_id) DO UPDATE SET project_number = EXCLUDED.project_number, project_name = EXCLUDED.project_name`, [project.id, project.number, project.name]);
}
async function insertDefaults(project, party, key, name, email, manual, user) {
  const docs = party === 'epd' ? EPD_DOCS : SUB_DOCS;
  for (let i = 0; i < docs.length; i++) {
    await q(`INSERT INTO fin_fc_item (project_item_id, project_number, project_name, party, supplier_key, supplier_name, supplier_email, doc_code, label, manual, sort, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT (project_item_id, party, supplier_key, doc_code) DO NOTHING`,
      [project.id, project.number, project.name, party, key, name || null, email || null, docs[i].code, docs[i].label, !!manual, i, user.email]);
  }
}

/** Aligne la liste sur les bons de commande envoyés (sous-traitants ajoutés / retirés). */
async function syncItems(project, user) {
  await ensureProject(project);
  await insertDefaults(project, 'epd', '', '', '', false, user);
  let subs = [];
  try { const iv = await dash.buildInterv(project); subs = (iv && iv.subs) || []; } catch (e) { return; }   // en cas d'échec Monday : on ne touche à rien
  const seen = new Set();
  for (const s of subs) {
    const name = str(s.company, 200); if (!name) continue;
    const key = norm(name); if (!key || seen.has(key)) continue; seen.add(key);
    const email = str(s.email, 200).toLowerCase();
    await insertDefaults(project, 'sub', key, name, email, !!s.manual, user);
    if (email) await q("UPDATE fin_fc_item SET supplier_email = $4 WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2 AND (supplier_email IS NULL OR supplier_email = '') AND $3 = $3", [project.id, key, key, email]);
  }
  // Sous-traitants dont le bon de commande n'existe plus (annulé) : on retire les éléments intacts (jamais demandés ni reçus).
  const cur = await q("SELECT DISTINCT supplier_key FROM fin_fc_item WHERE project_item_id = $1 AND party = 'sub' AND manual = false", [project.id]);
  for (const r of cur) {
    if (seen.has(r.supplier_key)) continue;
    await q(`DELETE FROM fin_fc_item WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2 AND status = 'a_demander'
        AND NOT EXISTS (SELECT 1 FROM fin_fc_file f WHERE f.item_id = fin_fc_item.id)`, [project.id, r.supplier_key]);
  }
}

const COLS = `id, party, supplier_key, supplier_name, supplier_email, doc_code, label, custom, manual, applicable, status, requested_at, last_reminder_at, reminders, received_at, note, sort, source, email_from, ai_notes`;

function spFileName(item, n, filename) {
  const ext = (String(filename || '').match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0].toLowerCase();
  const type = SHORT[item.doc_code] || spName(item.label).slice(0, 30) || 'Document';
  const who = item.party === 'epd' ? 'EPD' : (spName(item.supplier_name).slice(0, 15).trim() || 'Sous-traitant');
  return type + ' - ' + who + (n > 1 ? ' ' + n : '') + ext;
}

async function pushFile(item, fileId) {
  if (!sp.isConfigured()) {
    await q("UPDATE fin_fc_file SET sp_status = 'non_configure', sp_error = NULL WHERE id = $1", [fileId]);
    return { status: 'non_configure' };
  }
  await q("UPDATE fin_fc_file SET sp_status = 'attente', sp_error = NULL WHERE id = $1", [fileId]);
  try {
    const f = (await q('SELECT id, filename, sp_name, data_b64 FROM fin_fc_file WHERE id = $1', [fileId]))[0];
    if (!f || !f.data_b64) throw new Error('Fichier introuvable (déjà transféré ?).');
    const out = await sp.uploadFinChantier(item, Buffer.from(f.data_b64, 'base64'), f.sp_name || f.filename);
    await q("UPDATE fin_fc_file SET sp_status = 'reussi', sp_url = $2, sp_error = NULL, data_b64 = NULL WHERE id = $1", [fileId, (out && out.webUrl) || null]);
    await logEvent(item.id, item.project_item_id, 'sharepoint_ok', 'systeme', out && out.path);
    return { status: 'reussi', url: out && out.webUrl };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    await q("UPDATE fin_fc_file SET sp_status = 'echec', sp_error = $2 WHERE id = $1", [fileId, msg]);
    await logEvent(item.id, item.project_item_id, 'sharepoint_echec', 'systeme', msg);
    return { status: 'echec', error: msg };
  }
}

/** Dépose dans SharePoint tous les fichiers d'un élément qui n'y sont pas encore. */
async function pushPending(item) {
  const files = await q("SELECT id FROM fin_fc_file WHERE item_id = $1 AND data_b64 IS NOT NULL AND (sp_status IS NULL OR sp_status IN ('echec','non_configure','attente')) ORDER BY created_at", [item.id]);
  const out = [];
  for (const f of files) out.push(await pushFile(item, f.id));
  return out;
}

/**
 * Réception par courriel (boîte coordo) : classe le(s) fichier(s) sur le bon élément, sans rien déposer dans SharePoint.
 * L'élément passe à « À réviser » ; SharePoint n'est alimenté qu'à l'approbation (action approve).
 * o : { party:'sub'|'epd', supplierKey, supplierName, supplierEmail, docCode, label (pour un élément « autre »), files:[{filename, bytes}], notes, emailFrom, subject, inboxId }
 */
async function ingestFromEmail(user, project, o) {
  await syncItems(project, user);
  const notes = (o.notes || []).slice();
  const party = o.party === 'epd' ? 'epd' : 'sub';
  const key = party === 'epd' ? '' : String(o.supplierKey || norm(o.supplierName));
  let item = (await q('SELECT * FROM fin_fc_item WHERE project_item_id = $1 AND party = $2 AND supplier_key = $3 AND doc_code = $4', [project.id, party, key, o.docCode]))[0];
  if (!item) {
    if (party === 'sub' && !(await q("SELECT 1 FROM fin_fc_item WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2 LIMIT 1", [project.id, key]))[0]) {
      await ensureProject(project);
      await insertDefaults(project, 'sub', key, o.supplierName, o.supplierEmail, true, user);
      notes.push({ field: 'Sous-traitant', text: '« ' + o.supplierName + ' » ajouté à la liste de fin de chantier (aucun bon de commande envoyé).' });
      item = (await q('SELECT * FROM fin_fc_item WHERE project_item_id = $1 AND party = $2 AND supplier_key = $3 AND doc_code = $4', [project.id, party, key, o.docCode]))[0];
    }
  }
  if (!item) {                                                          // type de document hors liste : élément ajouté
    const label = str(o.label, 120) || 'Autre document';
    const ref = (await q("SELECT supplier_name, supplier_email FROM fin_fc_item WHERE project_item_id = $1 AND party = $2 AND supplier_key = $3 LIMIT 1", [project.id, party, key]))[0] || {};
    const mx2 = await q('SELECT COALESCE(MAX(sort), 0)::int AS m FROM fin_fc_item WHERE project_item_id = $1 AND party = $2 AND supplier_key = $3', [project.id, party, key]);
    const r = await q(`INSERT INTO fin_fc_item (project_item_id, project_number, project_name, party, supplier_key, supplier_name, supplier_email, doc_code, label, custom, manual, sort, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,$10,$11,$11) RETURNING id`,
      [project.id, project.number, project.name, party, key, ref.supplier_name || o.supplierName || null, ref.supplier_email || o.supplierEmail || null, 'custom-' + Math.random().toString(36).slice(2, 10), label, mx2[0].m + 1, user.email]);
    item = (await q('SELECT * FROM fin_fc_item WHERE id = $1', [r[0].id]))[0];
    notes.push({ field: 'Document', text: 'Type de document hors liste : élément « ' + label + ' » ajouté.' });
  }
  if (item.applicable === false) notes.push({ field: 'Document', text: 'Cet élément était marqué « Non applicable » : il a été réactivé.' });
  if (item.status === 'recu') notes.push({ field: 'Document', text: 'Ce document était déjà reçu : le nouveau fichier s\'ajoute (approuvez ou refusez).' });
  const crypto = require('crypto');
  let stored = 0;
  for (const f of (o.files || [])) {
    const hash = crypto.createHash('sha256').update(f.bytes).digest('hex');
    if ((await q('SELECT 1 FROM fin_fc_file WHERE item_id = $1 AND sha256 = $2 LIMIT 1', [item.id, hash]))[0]) { notes.push({ field: 'Pièce jointe', text: '« ' + f.filename + ' » est déjà au dossier (ignorée).' }); continue; }
    const filename = fileSafe(f.filename || 'document.pdf') || 'document.pdf';
    const nth = (await q('SELECT count(*)::int AS n FROM fin_fc_file WHERE item_id = $1', [item.id]))[0].n + 1;
    await q('INSERT INTO fin_fc_file (item_id, filename, sp_name, size_bytes, data_b64, uploaded_by, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [item.id, filename, spFileName(item, nth, filename), Buffer.from(f.bytes).length, Buffer.from(f.bytes).toString('base64'), o.emailFrom || user.email, hash]);
    stored++;
  }
  if (!stored) return { id: item.id, label: item.label, supplier: item.supplier_name, stored: 0, unchanged: true, notes };
  await q(`UPDATE fin_fc_item SET status = 'a_reviser', applicable = true, source = 'courriel', email_from = $2, ai_notes = $3::jsonb, inbox_id = $4,
      prev_status = CASE WHEN status = 'a_reviser' THEN prev_status ELSE status END, updated_by = $5, updated_at = now() WHERE id = $1`,
    [item.id, o.emailFrom || null, JSON.stringify(notes), o.inboxId || null, user.email]);
  await logEvent(item.id, project.id, 'recu_par_courriel', 'systeme', 'Courriel de ' + (o.emailFrom || '?') + ' : ' + String(o.subject || '').slice(0, 200));
  return { id: item.id, label: item.label, supplier: item.supplier_name, stored, notes };
}

const ACTIONS = {
  async projects(user, b) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(!!(b && b.refresh))]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    return { me: { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting },
      projects: mine.map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status, cp: p.cp.map(c => c.name) })) };
  },

  async list(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    await syncItems(project, user);
    const [meta, items, files] = await Promise.all([
      q('SELECT acceptance_date, acceptance_label FROM fin_fc_project WHERE project_item_id = $1', [project.id]),
      q(`SELECT ${COLS} FROM fin_fc_item WHERE project_item_id = $1 ORDER BY party DESC, supplier_name, sort, created_at`, [project.id]),
      q(`SELECT f.id, f.item_id, f.filename, f.sp_name, f.size_bytes, f.sp_status, f.sp_url, f.sp_error, f.created_at FROM fin_fc_file f JOIN fin_fc_item i ON i.id = f.item_id
          WHERE i.project_item_id = $1 ORDER BY f.created_at`, [project.id])
    ]);
    const byItem = {};
    files.forEach(f => { (byItem[f.item_id] = byItem[f.item_id] || []).push(f); });
    return { project: { id: project.id, number: project.number, name: project.name }, acceptanceDate: fmtD(meta[0] && meta[0].acceptance_date) || null, acceptanceLabel: labelOf(meta[0] && meta[0].acceptance_label),
      items: items.map(i => Object.assign({}, i, { files: byItem[i.id] || [] })), sharepointConfigured: sp.isConfigured(), cc: ccFor(user, project, [], []) };
  },

  /** Vue d'ensemble : progression par projet accessible (documents applicables reçus / total). */
  async overview(user) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(false)]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    const ids = mine.map(p => String(p.id));
    const rows = ids.length ? await q(`SELECT project_item_id, count(*) FILTER (WHERE applicable)::int AS total, count(*) FILTER (WHERE applicable AND status = 'recu')::int AS done,
        count(*) FILTER (WHERE applicable AND status = 'a_reviser')::int AS review, count(*) FILTER (WHERE applicable AND status = 'demande')::int AS asked
        FROM fin_fc_item WHERE project_item_id = ANY($1::text[]) GROUP BY project_item_id`, [ids]) : [];
    const projects = mine.map(p => ({ id: String(p.id), number: p.number, name: p.name, cp: (p.cp || []).map(c => c.name) }));
    return { progress: rows, projects };
  },

  async setAcceptance(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const d = b.date ? dateOrNull(b.date) : null;
    if (b.date && !d) throw { status: 400, message: 'Date invalide.' };
    await ensureProject(project);
    await q('UPDATE fin_fc_project SET acceptance_date = $2, acceptance_label = $4, updated_by = $3, updated_at = now() WHERE project_item_id = $1', [project.id, d, user.email, labelOf(b.label)]);
    await logEvent(null, project.id, 'date_acceptation', user.email, labelOf(b.label) + ' : ' + d);
    return { ok: true };
  },

  async toggleApplicable(user, b) {
    const { item } = await loadItem(user, b.id);
    const app = !!b.applicable;
    await q('UPDATE fin_fc_item SET applicable = $2, updated_by = $3, updated_at = now() WHERE id = $1', [item.id, app, user.email]);
    await logEvent(item.id, item.project_item_id, app ? 'applicable' : 'non_applicable', user.email, item.label);
    return { ok: true };
  },

  async addItem(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const label = str(b.label, 120);
    if (!label) throw { status: 400, message: 'Nom du document obligatoire.' };
    const party = b.party === 'epd' ? 'epd' : 'sub';
    let key = '', name = null, email = null;
    if (party === 'sub') {
      key = String(b.supplierKey || '');
      const ref = (await q("SELECT supplier_name, supplier_email FROM fin_fc_item WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2 LIMIT 1", [project.id, key]))[0];
      if (!ref) throw { status: 404, message: 'Sous-traitant introuvable.' };
      name = ref.supplier_name; email = ref.supplier_email;
    }
    const code = 'custom-' + Math.random().toString(36).slice(2, 10);
    const mx2 = await q('SELECT COALESCE(MAX(sort), 0)::int AS m FROM fin_fc_item WHERE project_item_id = $1 AND party = $2 AND supplier_key = $3', [project.id, party, key]);
    const r = await q(`INSERT INTO fin_fc_item (project_item_id, project_number, project_name, party, supplier_key, supplier_name, supplier_email, doc_code, label, custom, manual, sort, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,$10,$11,$11) RETURNING id`,
      [project.id, project.number, project.name, party, key, name, email, code, label, mx2[0].m + 1, user.email]);
    await logEvent(r[0].id, project.id, 'ajoute', user.email, label);
    return { ok: true, id: r[0].id };
  },

  /** Ajoute un sous-traitant sans bon de commande (liste complète par défaut). */
  async addSupplier(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const name = str(b.name, 200);
    if (!name) throw { status: 400, message: 'Nom du sous-traitant obligatoire.' };
    const email = str(b.email, 200).toLowerCase();
    if (email && !po.isEmail(email)) throw { status: 400, message: 'Courriel invalide : ' + email };
    await ensureProject(project);
    await insertDefaults(project, 'sub', norm(name), name, email, true, user);
    await logEvent(null, project.id, 'sous_traitant_ajoute', user.email, name);
    return { ok: true };
  },

  async setEmail(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const email = str(b.email, 200).toLowerCase();
    if (email && !po.isEmail(email)) throw { status: 400, message: 'Courriel invalide : ' + email };
    await q("UPDATE fin_fc_item SET supplier_email = $3, updated_at = now() WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2", [project.id, String(b.supplierKey || ''), email || null]);
    return { ok: true };
  },

  async renameItem(user, b) {
    const { item } = await loadItem(user, b.id);
    if (!item.custom) throw { status: 409, message: 'Seuls les éléments ajoutés peuvent être renommés.' };
    const label = str(b.label, 120);
    if (!label) throw { status: 400, message: 'Nom du document obligatoire.' };
    await q('UPDATE fin_fc_item SET label = $2, updated_by = $3, updated_at = now() WHERE id = $1', [item.id, label, user.email]);
    return { ok: true };
  },

  async deleteItem(user, b) {
    const { item } = await loadItem(user, b.id);
    if (!item.custom) throw { status: 409, message: "Les documents standards ne se suppriment pas : marquez-les « Non applicable »." };
    await logEvent(null, item.project_item_id, 'supprime', user.email, item.label);
    await q('DELETE FROM fin_fc_item WHERE id = $1', [item.id]);
    return { ok: true };
  },

  inboxList: (user) => require('./_lib/coordo').INBOX.inboxList(user, { kind: 'fc' }),
  inboxGet: (user, b) => require('./_lib/coordo').INBOX.inboxGet(user, b),
  inboxDismiss: (user, b) => require('./_lib/coordo').INBOX.inboxDismiss(user, b),

  /** Approbation d'un document reçu par courriel : « Reçu » + dépôt dans SharePoint (seulement maintenant). */
  async approve(user, b) {
    const { item } = await loadItem(user, b.id);
    if (item.status !== 'a_reviser') throw { status: 409, message: "Ce document n'est pas à réviser." };
    const n = (await q('SELECT count(*)::int AS n FROM fin_fc_file WHERE item_id = $1', [item.id]))[0].n;
    if (!n) throw { status: 400, message: 'Aucun fichier au dossier.' };
    await q("UPDATE fin_fc_item SET status = 'recu', received_at = COALESCE(received_at, now()), updated_by = $2, updated_at = now() WHERE id = $1", [item.id, user.email]);
    await logEvent(item.id, item.project_item_id, 'approuve', user.email, item.label);
    const sharepoint = await pushPending(item);
    return { ok: true, sharepoint };
  },

  /** Refus : retire les fichiers reçus par courriel (pas encore dans SharePoint) et remet l'élément dans son état précédent. */
  async reject(user, b) {
    const { item } = await loadItem(user, b.id);
    if (item.status !== 'a_reviser') throw { status: 409, message: "Ce document n'est pas à réviser." };
    await q('DELETE FROM fin_fc_file WHERE item_id = $1 AND sp_status IS NULL', [item.id]);
    const left = await q('SELECT 1 FROM fin_fc_file WHERE item_id = $1 LIMIT 1', [item.id]);
    const back = left[0] ? 'recu' : (item.prev_status && item.prev_status !== 'a_reviser' && item.prev_status !== 'recu' ? item.prev_status : (item.requested_at ? 'demande' : 'a_demander'));
    await q("UPDATE fin_fc_item SET status = $2, received_at = CASE WHEN $3 THEN received_at ELSE NULL END, ai_notes = '[]'::jsonb, source = NULL, prev_status = NULL, updated_by = $4, updated_at = now() WHERE id = $1", [item.id, back, !!left[0], user.email]);
    await logEvent(item.id, item.project_item_id, 'refuse', user.email, item.label);
    return { ok: true };
  },

  async setStatus(user, b) {
    const { item } = await loadItem(user, b.id);
    if (!STATUSES.includes(b.status)) throw { status: 400, message: 'Statut invalide.' };
    if (item.status === 'a_reviser') throw { status: 409, message: 'Ce document est à réviser : utilisez Approuver ou Refuser.' };
    await q(`UPDATE fin_fc_item SET status = $2, received_at = CASE WHEN $2 = 'recu' THEN COALESCE(received_at, now()) ELSE NULL END,
        requested_at = CASE WHEN $2 = 'a_demander' THEN NULL ELSE requested_at END, updated_by = $3, updated_at = now() WHERE id = $1`, [item.id, b.status, user.email]);
    await logEvent(item.id, item.project_item_id, 'statut', user.email, b.status);
    return { ok: true };
  },

  /** Courriel de demande (ou de rappel) : UN courriel par sous-traitant coché, avec la liste complète de ses documents. */
  async request(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const meta = (await q('SELECT acceptance_date, acceptance_label FROM fin_fc_project WHERE project_item_id = $1', [project.id]))[0];
    const accept = fmtD(meta && meta.acceptance_date), aLabel = labelOf(meta && meta.acceptance_label);
    if (!accept) throw { status: 400, message: "Indiquez d'abord la date d'acceptation." };
    const keys = (Array.isArray(b.supplierKeys) ? b.supplierKeys : []).map(String).filter(Boolean);
    if (!keys.length) throw { status: 400, message: 'Cochez au moins un sous-traitant.' };
    const sent = [], skipped = [];
    for (const key of keys) {
      const rows = await q("SELECT * FROM fin_fc_item WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2 AND applicable ORDER BY sort, created_at", [project.id, key]);
      if (!rows.length) continue;
      const name = rows[0].supplier_name || key;
      const pending = rows.filter(r => r.status === 'a_demander' || r.status === 'demande');
      if (!pending.length) { skipped.push({ supplier: name, reason: 'Tous les documents sont reçus (ou en révision).' }); continue; }
      const email = (b.emails && b.emails[key] ? String(b.emails[key]) : rows[0].supplier_email || '').trim().toLowerCase();
      if (!email) { skipped.push({ supplier: name, reason: 'Courriel manquant.' }); continue; }
      const to = cleanEmails([email]);
      const cc = ccFor(user, project, cleanEmails(b.cc || []), to);
      const isReminder = pending.some(r => r.status === 'demande');
      const dateTxt = longDate(accept);
      const blk = mx.table(['Document', 'État'], rows.map(r => [r.label, (r.status === 'recu' || r.status === 'a_reviser') ? 'Reçu' : 'À fournir']));
      let message = String(b.message || '').replace(/\r/g, '').slice(0, 4000).split('[DATE]').join(dateTxt).split('[JALON]').join(deLabel(aLabel));
      if (!message) message = 'Bonjour,\n\n' + (isReminder ? 'Ceci est un rappel : n' : 'N') + 'ous préparons la fin du chantier du projet ' + project.number + ' — ' + project.name + '. La date ' + deLabel(aLabel) + ' est fixée au ' + dateTxt +
        '.\n\nNous vous demandons de nous transmettre les documents de fin de chantier suivants (la liste complète est ci-dessous) :\n\n{{LISTE}}\nMerci de nous les faire parvenir par courriel, en format PDF, dans les meilleurs délais.';
      if (message.indexOf('{{LISTE}}') < 0) message += '\n\n{{LISTE}}';
      const subject = (str(b.subject, 200) || ('Documents de fin de chantier — Projet ' + project.number + ' ' + project.name)).replace(/^(RAPPEL — )?/, isReminder ? 'RAPPEL — ' : '');
      await mx.send({ user, to, cc, subject, message, blockHtml: blk.html, blockText: blk.text });
      for (const r of pending) {
        if (r.status === 'a_demander') await q("UPDATE fin_fc_item SET status = 'demande', requested_at = now(), supplier_email = COALESCE(supplier_email, $2), updated_by = $3, updated_at = now() WHERE id = $1", [r.id, email, user.email]);
        else await q('UPDATE fin_fc_item SET reminders = reminders + 1, last_reminder_at = now(), updated_by = $2, updated_at = now() WHERE id = $1', [r.id, user.email]);
        await logEvent(r.id, project.id, isReminder ? 'relance' : 'demande', user.email, to.join(', '));
      }
      sent.push({ supplier: name, to, count: rows.length, reminder: isReminder });
    }
    if (!sent.length && skipped.length) throw { status: 409, message: skipped.map(s => s.supplier + ' : ' + s.reason).join(' ') };
    return { ok: true, sent, skipped };
  },

  // --- Fichiers par blocs ---
  async fileChunk(user, b) {
    await loadItem(user, b.id);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const idx = parseInt(b.idx, 10);
    const data = String(b.data || '');
    if (!(idx >= 0 && idx < 20) || !data || data.length > 2200000 || /[^A-Za-z0-9+/=]/.test(data)) throw { status: 400, message: 'Bloc invalide.' };
    await q('INSERT INTO fin_change_chunk (upload_id, idx, data_b64) VALUES ($1,$2,$3) ON CONFLICT (upload_id, idx) DO UPDATE SET data_b64 = EXCLUDED.data_b64', [up, idx, data]);
    return { ok: true };
  },

  /** Document reçu : enregistre, marque « Reçu » et dépose dans SharePoint (« Fin de chantier / [Type] - [Sous-traitant] »). */
  async fileFinish(user, b) {
    const { item } = await loadItem(user, b.id);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const filename = fileSafe(b.filename || 'document.pdf') || 'document.pdf';
    if (/\.(exe|bat|cmd|com|scr|js|vbs|msi|ps1|jar|dll)$/i.test(filename)) throw { status: 400, message: 'Type de fichier non permis.' };
    const n = parseInt(b.count, 10);
    const cnt = await q('SELECT count(*)::int AS n FROM fin_change_chunk WHERE upload_id = $1', [up]);
    if (!(n > 0) || cnt[0].n !== n) throw { status: 400, message: 'Téléversement incomplet (' + cnt[0].n + '/' + n + ' blocs). Réessayez.' };
    const nth = (await q('SELECT count(*)::int AS n FROM fin_fc_file WHERE item_id = $1', [item.id]))[0].n + 1;
    const spn = spFileName(item, nth, filename);
    const ins = await q(`INSERT INTO fin_fc_file (item_id, filename, sp_name, size_bytes, data_b64, uploaded_by)
        SELECT $1, $2, $3, 0, string_agg(data_b64, '' ORDER BY idx), $5 FROM fin_change_chunk WHERE upload_id = $4 RETURNING id, length(data_b64) AS len`,
      [item.id, filename, spn, up, user.email]);
    await q('DELETE FROM fin_change_chunk WHERE upload_id = $1', [up]);
    const size = Math.floor(Number(ins[0].len) * 3 / 4);
    if (size > MAX_FILE) { await q('DELETE FROM fin_fc_file WHERE id = $1', [ins[0].id]); throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' }; }
    await q('UPDATE fin_fc_file SET size_bytes = $2 WHERE id = $1', [ins[0].id, size]);
    await q("UPDATE fin_fc_item SET status = 'recu', received_at = now(), applicable = true, updated_by = $2, updated_at = now() WHERE id = $1", [item.id, user.email]);
    await logEvent(item.id, item.project_item_id, 'fichier_recu', user.email, filename + ' → ' + spn);
    const all = await pushPending(item);                 // le nouveau fichier + tout fichier reçu par courriel encore en attente (le dépôt manuel vaut approbation)
    return { ok: true, id: ins[0].id, spName: spn, sharepoint: all[all.length - 1] };
  },

  async fileDelete(user, b) {
    const { item } = await loadItem(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const r = await q('DELETE FROM fin_fc_file WHERE id = $1 AND item_id = $2 RETURNING filename', [b.fileId, item.id]);
    if (r[0]) {
      await logEvent(item.id, item.project_item_id, 'fichier_supprime', user.email, r[0].filename);
      const left = await q('SELECT 1 FROM fin_fc_file WHERE item_id = $1 LIMIT 1', [item.id]);
      if (!left[0] && item.status === 'a_reviser') await ACTIONS.reject(user, { id: item.id });
      else if (!left[0] && item.status === 'recu') await q("UPDATE fin_fc_item SET status = $2, received_at = NULL, updated_at = now() WHERE id = $1", [item.id, item.requested_at ? 'demande' : 'a_demander']);
    }
    return { ok: true };
  },

  async fileGetChunk(user, b) {
    const { item } = await loadItem(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = await q('SELECT filename, length(data_b64) AS len, substr(data_b64, $3::int, $4::int) AS part FROM fin_fc_file WHERE id = $1 AND item_id = $2', [b.fileId, item.id, idx * CHUNK_B64 + 1, CHUNK_B64]);
    if (!r[0]) throw { status: 404, message: 'Fichier introuvable.' };
    if (!r[0].len) throw { status: 404, message: 'Le fichier est maintenant dans SharePoint (copie retirée de l\'application).' };
    return { filename: r[0].filename, data: r[0].part || '', chunks: Math.max(1, Math.ceil(Number(r[0].len) / CHUNK_B64)), idx };
  },

  async spRetry(user, b) {
    const { item } = await loadItem(user, b.id);
    if (!isUuid(b.fileId)) throw { status: 400, message: 'Fichier invalide.' };
    const f = (await q('SELECT id FROM fin_fc_file WHERE id = $1 AND item_id = $2', [b.fileId, item.id]))[0];
    if (!f) throw { status: 404, message: 'Fichier introuvable.' };
    return { sharepoint: await pushFile(item, f.id) };
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
    if (status >= 500) console.error('fc.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
module.exports.ACTIONS = ACTIONS;
module.exports.ingestFromEmail = ingestFromEmail;
module.exports.EPD_DOCS = EPD_DOCS;
module.exports.SUB_DOCS = SUB_DOCS;
module.exports.syncItems = syncItems;
