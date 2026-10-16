// api/deficiencies.js — Module Déficiences : listes de déficiences de chantier, attribution aux sous-traitants
// (d'après les bons de commande du projet), validation des attributions incertaines, suivi et envoi groupé.
// Statuts : a_valider (attribution incertaine) -> ouverte -> corrigee -> fermee.

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const inv = require('./_lib/invoice');
const po = require('./_lib/po');
const mx = require('./_lib/mailx');
const df = require('./_lib/deficiency');

const isId = v => /^\d+$/.test(String(v || ''));
const isUuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const str = po.str;
const MAX_FILE = 20 * 1024 * 1024;
const CHUNK_B64 = 2097152;
const STATUSES = ['a_valider', 'ouverte', 'corrigee', 'fermee'];

async function who(user) { const acct = await inv.accountingEmails(); return { isAccounting: user.isAdmin || acct.includes(user.email) }; }
async function projectAccess(user, projectItemId) {
  if (!isId(projectItemId)) throw { status: 400, message: 'Projet invalide.' };
  const w = await who(user);
  const project = await monday.fetchProject(projectItemId);
  const isCp = project.cp.some(c => (c.email || '').toLowerCase() === user.email);
  if (!w.isAccounting && !isCp) throw { status: 403, message: "Vous n'avez pas accès à ce projet." };
  return { project, isAccounting: w.isAccounting };
}
async function loadDef(user, id) {
  if (!isUuid(id)) throw { status: 400, message: 'Identifiant invalide.' };
  const r = (await q('SELECT * FROM fin_deficiency WHERE id = $1', [id]))[0];
  if (!r) throw { status: 404, message: 'Déficience introuvable.' };
  const ctx = await projectAccess(user, r.project_item_id);
  return Object.assign({ d: r }, ctx);
}
async function logEvent(id, event, actor, detail) { await q('INSERT INTO fin_deficiency_event (deficiency_id, event, actor, detail) VALUES ($1,$2,$3,$4)', [id, event, actor || null, detail ? String(detail).slice(0, 2000) : null]); }
const COLS = 'id, ref, list_id, description, location, trade, supplier_key, supplier_name, supplier_email, assign_confidence, assign_reason, status, sent_at, corrected_at, closed_at, note, created_by, created_at';

const ACTIONS = {
  async projects(user, b) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(!!(b && b.refresh))]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    return { me: { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting }, projects: mine.map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status, cp: p.cp.map(c => c.name || c.email) })) };
  },

  async list(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const [rows, subs, lists] = await Promise.all([
      q('SELECT ' + COLS + ' FROM fin_deficiency WHERE project_item_id = $1 ORDER BY seq', [project.id]),
      df.projectSubs(project.id),
      q('SELECT id, title, filename, source, email_from, email_subject, ai_notes, created_at FROM fin_def_list WHERE project_item_id = $1 ORDER BY created_at DESC LIMIT 30', [project.id])]);
    return { project: { id: project.id, number: project.number, name: project.name }, deficiencies: rows, subs: subs.map(s => ({ key: s.key, name: s.name, email: s.email })), lists };
  },
  /** Pastille : nombre de déficiences à valider (tous les projets accessibles). */
  async counts(user) {
    const w = await who(user);
    const mine = w.isAccounting ? null : (await monday.fetchProjectsLite(false)).filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email)).map(p => String(p.id));
    const r = await q("SELECT count(*)::int AS n FROM fin_deficiency WHERE status = 'a_valider' AND ($2::boolean OR project_item_id = ANY($1::text[]))", [mine || [], !mine]);
    return { toValidate: r[0].n };
  },

  async add(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const description = str(b.description, 600); if (!description) throw { status: 400, message: 'Décrivez la déficience.' };
    const subs = await df.projectSubs(project.id);
    const sub = subs.find(s => s.key === String(b.supplierKey || ''));
    const r = await df.addOne(project, { description, location: str(b.location, 160), trade: str(b.trade, 80), supplier_key: sub && sub.key, supplier_name: sub && sub.name, supplier_email: sub && sub.email,
      assign_confidence: sub ? 'manuel' : null, status: sub ? 'ouverte' : 'a_valider' }, user.email);
    return { ok: true, id: r.id, ref: r.ref };
  },

  async update(user, b) {
    const { d, project } = await loadDef(user, b.id);
    const f = b.fields || {};
    const subs = await df.projectSubs(project.id);
    const sets = [], p = [d.id];
    const set = (col, v) => { p.push(v); sets.push(col + ' = $' + p.length); };
    if ('description' in f) { const v = str(f.description, 600); if (!v) throw { status: 400, message: 'La description est obligatoire.' }; set('description', v); }
    if ('location' in f) set('location', str(f.location, 160) || null);
    if ('trade' in f) set('trade', str(f.trade, 80) || null);
    if ('note' in f) set('note', str(f.note, 600) || null);
    if ('supplierKey' in f) {
      const sub = subs.find(s => s.key === String(f.supplierKey || ''));
      if (f.supplierKey && !sub) throw { status: 400, message: 'Sous-traitant inconnu pour ce projet.' };
      set('supplier_key', sub ? sub.key : null); set('supplier_name', sub ? sub.name : null); set('supplier_email', sub ? sub.email : null); set('assign_confidence', sub ? 'manuel' : null);
      if (sub && d.status === 'a_valider') set('status', 'ouverte');
      await logEvent(d.id, 'attribuee', user.email, sub ? sub.name : 'aucun');
    }
    if (!sets.length) return { ok: true };
    await q('UPDATE fin_deficiency SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1', p);
    return { ok: true };
  },
  /** Valide l'attribution proposée (statut À valider -> Ouverte). */
  async confirm(user, b) {
    const { d } = await loadDef(user, b.id);
    if (d.status !== 'a_valider') throw { status: 409, message: "Cette déficience n'est pas à valider." };
    if (!d.supplier_key) throw { status: 400, message: "Choisissez d'abord un sous-traitant." };
    await q("UPDATE fin_deficiency SET status = 'ouverte', assign_confidence = 'manuel', updated_at = now() WHERE id = $1", [d.id]);
    await logEvent(d.id, 'validee', user.email, d.supplier_name);
    return { ok: true };
  },
  async setStatus(user, b) {
    const { d } = await loadDef(user, b.id);
    const to = b.status;
    if (!['ouverte', 'corrigee', 'fermee'].includes(to)) throw { status: 400, message: 'Statut invalide.' };
    if (d.status === 'a_valider') throw { status: 409, message: "Validez d'abord l'attribution de cette déficience." };
    await q(`UPDATE fin_deficiency SET status = $2, corrected_at = CASE WHEN $2 = 'corrigee' THEN now() WHEN $2 = 'ouverte' THEN NULL ELSE corrected_at END,
        closed_at = CASE WHEN $2 = 'fermee' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [d.id, to]);
    await logEvent(d.id, to, user.email, null);
    return { ok: true };
  },
  async remove(user, b) {
    const { d } = await loadDef(user, b.id);
    await q('DELETE FROM fin_deficiency WHERE id = $1', [d.id]);
    return { ok: true };
  },

  /** Envoie à chaque sous-traitant coché UN courriel avec toutes ses déficiences ouvertes. */
  async send(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const keys = (Array.isArray(b.supplierKeys) ? b.supplierKeys : []).map(String).filter(Boolean);
    if (!keys.length) throw { status: 400, message: 'Cochez au moins un sous-traitant.' };
    const sent = [], skipped = [];
    for (const key of keys) {
      const rows = await q("SELECT id, ref, description, location, supplier_name, supplier_email FROM fin_deficiency WHERE project_item_id = $1 AND supplier_key = $2 AND status = 'ouverte' ORDER BY seq", [project.id, key]);
      if (!rows.length) { skipped.push({ supplier: key, reason: 'Aucune déficience ouverte.' }); continue; }
      const name = rows[0].supplier_name;
      const email = String((b.emails && b.emails[key]) || rows[0].supplier_email || '').trim().toLowerCase();
      if (!email || !po.isEmail(email)) { skipped.push({ supplier: name, reason: 'Courriel manquant ou invalide.' }); continue; }
      const to = [email];
      const cc = mx.ccFor(user, project, mx.cleanEmails(b.cc || []), to);
      const blk = mx.table(['Réf.', 'Déficience', 'Endroit'], rows.map(r => [r.ref, r.description, r.location || '']));
      let message = String(b.message || '').replace(/\r/g, '').slice(0, 4000);
      if (!message) message = 'Bonjour,\n\nVoici la liste des déficiences à corriger pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nMerci de nous confirmer la correction de chaque élément dès que les travaux sont complétés.';
      if (message.indexOf('{{LISTE}}') < 0) message += '\n\n{{LISTE}}';
      await mx.send({ user, to, cc, subject: str(b.subject, 200) || ('Déficiences à corriger — Projet ' + project.number + ' ' + project.name), message, blockHtml: blk.html, blockText: blk.text });
      await q('UPDATE fin_deficiency SET sent_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])', [rows.map(r => r.id)]);
      for (const r of rows) await logEvent(r.id, 'envoyee', user.email, email);
      sent.push({ supplier: name, to: email, count: rows.length });
    }
    if (!sent.length) throw { status: 409, message: skipped.map(s => s.supplier + ' : ' + s.reason).join(' ') || 'Rien à envoyer.' };
    return { ok: true, sent, skipped };
  },

  // --- Dépôt d'une liste (PDF / image) par blocs, puis lecture ---
  async fileChunk(user, b) {
    await projectAccess(user, b.projectItemId);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const idx = parseInt(b.idx, 10), data = String(b.data || '');
    if (!(idx >= 0 && idx < 20) || !data || data.length > 2200000 || /[^A-Za-z0-9+/=]/.test(data)) throw { status: 400, message: 'Bloc invalide.' };
    await q('INSERT INTO fin_change_chunk (upload_id, idx, data_b64) VALUES ($1,$2,$3) ON CONFLICT (upload_id, idx) DO UPDATE SET data_b64 = EXCLUDED.data_b64', [up, idx, data]);
    return { ok: true };
  },
  async fileFinish(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const up = String(b.uploadId || '');
    if (!/^[A-Za-z0-9-]{8,60}$/.test(up)) throw { status: 400, message: 'Téléversement invalide.' };
    const n = parseInt(b.count, 10);
    const rows = await q('SELECT data_b64 FROM fin_change_chunk WHERE upload_id = $1 ORDER BY idx', [up]);
    if (!(n > 0) || rows.length !== n) throw { status: 400, message: 'Téléversement incomplet (' + rows.length + '/' + n + ' blocs). Réessayez.' };
    await q('DELETE FROM fin_change_chunk WHERE upload_id = $1', [up]);
    const bytes = Buffer.from(rows.map(r => r.data_b64).join(''), 'base64');
    if (bytes.length > MAX_FILE) throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' };
    const filename = str(b.filename || 'deficiences', 150).replace(/[\\/:*?"<>|]/g, '_');
    const isPdf = bytes.slice(0, 4).toString('latin1') === '%PDF';
    const ct = isPdf ? 'application/pdf' : (/\.png$/i.test(filename) ? 'image/png' : /\.jpe?g$/i.test(filename) ? 'image/jpeg' : /\.webp$/i.test(filename) ? 'image/webp' : '');
    if (!ct) throw { status: 400, message: 'Format non pris en charge : utilisez un PDF ou une image (PNG, JPG).' };
    const r = await df.ingest({ project, docs: [{ filename, bytes, contentType: ct }], source: 'manuel', user });
    return Object.assign({ ok: true }, r);
  },
  async listGetChunk(user, b) {
    if (!isUuid(b.id)) throw { status: 400, message: 'Identifiant invalide.' };
    const l = (await q('SELECT project_item_id FROM fin_def_list WHERE id = $1', [b.id]))[0];
    if (!l) throw { status: 404, message: 'Liste introuvable.' };
    await projectAccess(user, l.project_item_id);
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = (await q('SELECT filename, content_type, length(data_b64) AS len, substr(data_b64, $2::int, $3::int) AS part FROM fin_def_list WHERE id = $1', [b.id, idx * CHUNK_B64 + 1, CHUNK_B64]))[0];
    return { filename: r.filename, contentType: r.content_type, data: r.part || '', chunks: Math.max(1, Math.ceil(Number(r.len) / CHUNK_B64)), idx };
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
    if (status >= 500) console.error('deficiencies.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
module.exports.ACTIONS = ACTIONS;
