// api/schedules.js — Module Échéancier : dépôt de la dernière version de l'échéancier d'un projet, envoi par courriel
// aux intervenants choisis, mémoire des envois, pastille « projets en cours sans envoi depuis 30 jours » et rappel facultatif.

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const monday = require('./_lib/monday');
const inv = require('./_lib/invoice');
const po = require('./_lib/po');
const mx = require('./_lib/mailx');
const dash = require('./dashboard');

const isId = v => /^\d+$/.test(String(v || ''));
const isUuid = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const str = po.str;
const MAX_FILE = 20 * 1024 * 1024;
const CHUNK_B64 = 2097152;
const STALE_DAYS = 30;
const { inProgress } = require('./_lib/projstatus');
const TYPES = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', mpp: 'application/vnd.ms-project', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

async function who(user) { const acct = await inv.accountingEmails(); return { isAccounting: user.isAdmin || acct.includes(user.email) }; }
async function projectAccess(user, projectItemId) {
  if (!isId(projectItemId)) throw { status: 400, message: 'Projet invalide.' };
  const w = await who(user);
  const project = await monday.fetchProject(projectItemId);
  const isCp = project.cp.some(c => (c.email || '').toLowerCase() === user.email);
  if (!w.isAccounting && !isCp) throw { status: 403, message: "Vous n'avez pas accès à ce projet." };
  return { project, isAccounting: w.isAccounting };
}
async function myProjects(user) {
  const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(false)]);
  return w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
}
const daysSince = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;

const ACTIONS = {
  async projects(user, b) {
    const [w, list] = await Promise.all([who(user), monday.fetchProjectsLite(!!(b && b.refresh))]);
    const mine = w.isAccounting ? list : list.filter(p => p.cp.some(c => (c.email || '').toLowerCase() === user.email));
    return { me: { email: user.email, name: user.name, isAdmin: user.isAdmin, isAccounting: w.isAccounting }, projects: mine.map(p => ({ id: p.id, number: p.number, name: p.name, status: p.status, cp: p.cp.map(c => c.name || c.email) })) };
  },

  async list(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const [versions, sends, pref] = await Promise.all([
      q('SELECT id, version, filename, size_bytes, note, uploaded_by, created_at FROM fin_schedule WHERE project_item_id = $1 ORDER BY version DESC', [project.id]),
      q('SELECT id, version, sent_at, sent_by, recipients, cc, subject FROM fin_schedule_send WHERE project_item_id = $1 ORDER BY sent_at DESC LIMIT 100', [project.id]),
      q('SELECT remind FROM fin_schedule_pref WHERE project_item_id = $1', [project.id])]);
    const last = sends[0] || null;
    return { project: { id: project.id, number: project.number, name: project.name, status: project.status }, versions, sends, remind: !!(pref[0] && pref[0].remind),
      lastSentAt: last ? last.sent_at : null, lastSentVersion: last ? last.version : null, daysSinceSent: last ? daysSince(last.sent_at) : null, stale: inProgress(project) && (!last || daysSince(last.sent_at) >= STALE_DAYS) };
  },

  /** Pastille rouge : projets en cours (accessibles à l'utilisateur) dont l'échéancier n'a pas été envoyé depuis 30 jours (ou jamais). */
  async badge(user) {
    const mine = (await myProjects(user)).filter(inProgress);
    if (!mine.length) return { count: 0, projects: [] };
    const rows = await q('SELECT project_item_id, max(sent_at) AS last FROM fin_schedule_send WHERE project_item_id = ANY($1::text[]) GROUP BY project_item_id', [mine.map(p => String(p.id))]);
    const last = new Map(rows.map(r => [String(r.project_item_id), r.last]));
    const stale = mine.filter(p => { const l = last.get(String(p.id)); return !l || daysSince(l) >= STALE_DAYS; });
    return { count: stale.length, projects: stale.slice(0, 50).map(p => ({ id: String(p.id), number: p.number, name: p.name, days: last.get(String(p.id)) ? daysSince(last.get(String(p.id))) : null })) };
  },

  async setReminder(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    await q(`INSERT INTO fin_schedule_pref (project_item_id, remind, updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (project_item_id) DO UPDATE SET remind = EXCLUDED.remind, updated_by = EXCLUDED.updated_by, updated_at = now()`, [project.id, b.remind === true, user.email]);
    return { ok: true, remind: b.remind === true };
  },

  /** Destinataires possibles : la liste des intervenants du projet (client, professionnels, équipe EPD, sous-traitants, fournisseurs). */
  async recipients(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    const iv = await dash.buildInterv(project);
    const list = [], seen = new Set();
    const add = (group, name, company, email) => { const e = String(email || '').trim().toLowerCase(); if (!e || seen.has(e)) return; seen.add(e); list.push({ group, name: name || '', company: company || '', email: e }); };
    if (iv.owner) add("Maître de l'ouvrage", iv.owner.name, '', iv.owner.email);
    (iv.pros || []).forEach(p => add('Professionnels', p.contact, p.company + (p.specialty ? ' — ' + p.specialty : ''), p.email));
    (iv.cp || []).forEach(p => add('Équipe EPD', p.name, 'Chargé de projets', p.email));
    (iv.cm || []).forEach(p => add('Équipe EPD', p.name, 'Contremaître', p.email));
    (iv.coordo || []).forEach(p => add('Équipe EPD', p.name, 'Coordination', p.email));
    (iv.subs || []).forEach(s => add('Sous-traitants', s.contact, s.company, s.email));
    (iv.suppliers || []).forEach(s => add('Fournisseurs', s.contact, s.company, s.email));
    const cc = [user.email].concat(project.cp.map(c => (c.email || '').toLowerCase())).filter((e, i, a) => e && a.indexOf(e) === i);
    return { recipients: list, cc };
  },

  async send(user, b) {
    const { project } = await projectAccess(user, b.projectItemId);
    if (!isUuid(b.scheduleId)) throw { status: 400, message: 'Choisissez la version à envoyer.' };
    const sc = (await q('SELECT * FROM fin_schedule WHERE id = $1 AND project_item_id = $2', [b.scheduleId, project.id]))[0];
    if (!sc) throw { status: 404, message: 'Version introuvable.' };
    const to = mx.cleanEmails(b.to || []);
    if (!to.length) throw { status: 400, message: 'Choisissez au moins un destinataire.' };
    const cc = mx.ccFor(user, project, mx.cleanEmails(b.cc || []), to);
    const subject = str(b.subject, 200) || ('Échéancier à jour (version ' + sc.version + ') — Projet ' + project.number + ' ' + project.name);
    const message = String(b.message || '').replace(/\r/g, '').slice(0, 4000) ||
      ('Bonjour,\n\nVeuillez trouver ci-joint la version à jour de l\'échéancier du projet ' + project.number + ' — ' + project.name + ' (version ' + sc.version + ').\n\nN\'hésitez pas à nous contacter pour toute question.');
    await mx.send({ user, to, cc, subject, message, attachments: [{ filename: sc.filename, content: Buffer.from(sc.data_b64, 'base64'), contentType: sc.content_type || undefined }] });
    await q('INSERT INTO fin_schedule_send (schedule_id, project_item_id, version, sent_by, recipients, cc, subject) VALUES ($1,$2,$3,$4,$5,$6,$7)', [sc.id, project.id, sc.version, user.email, to.join(', '), cc.join(', '), subject]);
    return { ok: true, sentTo: to, version: sc.version };
  },

  // --- Dépôt par blocs ---
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
    const data = rows.map(r => r.data_b64).join('');
    const size = Math.floor(data.length * 3 / 4);
    if (size > MAX_FILE) throw { status: 413, message: 'Fichier trop volumineux (max 20 Mo).' };
    const filename = str(b.filename || 'echeancier', 150).replace(/[\\/:*?"<>|]/g, '_');
    const ext = (/\.([A-Za-z0-9]{2,5})$/.exec(filename) || [])[1];
    if (!ext || !TYPES[ext.toLowerCase()]) throw { status: 400, message: 'Format non pris en charge (PDF, Excel, MS Project ou image).' };
    let version = 0;
    for (let t = 0; t < 4; t++) {
      version = (await q('SELECT COALESCE(max(version),0)::int + 1 AS v FROM fin_schedule WHERE project_item_id = $1', [project.id]))[0].v;
      try {
        const r = await q('INSERT INTO fin_schedule (project_item_id, project_number, project_name, version, filename, content_type, size_bytes, data_b64, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
          [project.id, project.number, project.name, version, filename, TYPES[ext.toLowerCase()], size, data, str(b.note, 300) || null, user.email]);
        return { ok: true, id: r[0].id, version };
      } catch (e) { if (!/duplicate|unique/i.test(String(e && e.message))) throw e; }
    }
    throw { status: 409, message: 'Impossible de réserver un numéro de version. Réessayez.' };
  },
  async getChunk(user, b) {
    if (!isUuid(b.id)) throw { status: 400, message: 'Identifiant invalide.' };
    const s = (await q('SELECT project_item_id FROM fin_schedule WHERE id = $1', [b.id]))[0];
    if (!s) throw { status: 404, message: 'Version introuvable.' };
    await projectAccess(user, s.project_item_id);
    const idx = Math.max(0, parseInt(b.idx, 10) || 0);
    const r = (await q('SELECT filename, content_type, length(data_b64) AS len, substr(data_b64, $2::int, $3::int) AS part FROM fin_schedule WHERE id = $1', [b.id, idx * CHUNK_B64 + 1, CHUNK_B64]))[0];
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
    if (status >= 500) console.error('schedules.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
module.exports.ACTIONS = ACTIONS;
module.exports.inProgress = inProgress;
