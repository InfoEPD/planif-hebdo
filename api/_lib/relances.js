// api/_lib/relances.js — relances AUTOMATIQUES aux sous-traitants : première relance après 7 jours calendrier (5 jours pour les prix des directives de changement),
// puis tous les 7 jours tant que rien n'est reçu. Un seul courriel par sous-traitant et par type
// (tous les DA en attente ensemble, tous les documents de fin de chantier ensemble, tous les prix de directives ensemble).
// Déclenchée par le cron existant (invoices?cron=1), au plus une fois par jour (après 7 h, heure de Toronto).
// Désactivable : fin_settings « auto_relances » = {"enabled":false}.

const { q } = require('./db');
const mx = require('./mailx');
const monday = require('./monday');
const po = require('./po');

const EVERY_MS = 7 * 86400000 - 12 * 3600000;   // 7 jours (marge de 12 h pour la dérive du cron quotidien)
const SENDER = { name: 'Exacto-Finance', email: '' };
const torontoParts = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value;
  return { day: g('year') + '-' + g('month') + '-' + g('day'), hour: parseInt(g('hour'), 10) % 24 };
};
const isDue = (requestedAt, lastAt, now) => {
  const ref = lastAt || requestedAt;
  return !!ref && (now - new Date(ref).getTime()) >= EVERY_MS;
};
async function setting(key) {
  try { const r = await q('SELECT value FROM fin_settings WHERE key = $1', [key]); let v = r[0] && r[0].value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } } return v; }
  catch (e) { return null; }
}
async function setSetting(key, value) {
  await q(`INSERT INTO fin_settings (key, value, updated_by) VALUES ($1, $2, 'système') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
let projCache = null;
async function projectOf(itemId) {
  if (!projCache) { try { projCache = await monday.fetchProjectsLite(false); } catch (e) { projCache = []; } }
  return projCache.find(p => String(p.id) === String(itemId)) || { id: itemId, number: '', name: '', cp: [] };
}
function ccList(project, to) {
  return Array.from(new Set((project.cp || []).map(c => String(c.email || '').toLowerCase()).filter(e => e && po.isEmail(e) && !to.includes(e))));
}
const emailsOf = v => Array.from(new Set(String(v || '').split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(e => po.isEmail(e))));
/** Regroupe des lignes { key, email, name, project_item_id, ... } par (sous-traitant, projet). */
function group(rows) {
  const m = new Map();
  rows.forEach(r => {
    const k = (r.email || '') + '|' + (r.supplier_key || r.name || '') + '|' + r.project_item_id;
    if (!m.has(k)) m.set(k, { email: r.email, name: r.name, project_item_id: r.project_item_id, rows: [] });
    m.get(k).rows.push(r);
  });
  return Array.from(m.values());
}
const intro = (kind, project) => ({
  da: 'Bonjour,\n\nCeci est un rappel : nous sommes toujours en attente des dessins d\'atelier / fiches techniques suivants pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nMerci de nous les transmettre par courriel, en format PDF, dans les meilleurs délais.',
  fc: 'Bonjour,\n\nCeci est un rappel : nous sommes toujours en attente des documents de fin de chantier suivants pour le projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nMerci de nous les faire parvenir par courriel, en format PDF, dans les meilleurs délais.',
  prix: 'Bonjour,\n\nCeci est un rappel : nous sommes toujours en attente de votre prix pour les demandes de changement suivantes du projet ' + project.number + ' — ' + project.name + ' :\n\n{{LISTE}}\nMerci de nous transmettre votre soumission par courriel dans les meilleurs délais.'
})[kind];
const subjectOf = (kind, project) => 'RAPPEL — ' + ({ da: 'Dessins d\'atelier / fiches techniques', fc: 'Documents de fin de chantier', prix: 'Prix demandés (demandes de changement)' })[kind] + ' — Projet ' + project.number + ' ' + project.name;

async function sendGroup(kind, g, headers, toRow) {
  const to = emailsOf(g.email);
  if (!to.length) return false;
  const project = await projectOf(g.project_item_id);
  const blk = mx.table(headers, g.rows.map(toRow));
  await mx.send({ user: Object.assign({}, SENDER, { email: process.env.SMTP_USER || '' }), to, cc: ccList(project, to), subject: subjectOf(kind, project), message: intro(kind, project), blockHtml: blk.html, blockText: blk.text });
  return true;
}

async function runDa(now, out) {
  const rows = (await q("SELECT id, project_item_id, ref, description, spec_section, supplier_item_id, supplier_name, supplier_email, requested_at, last_reminder_at FROM fin_da WHERE status = 'demande' AND deleted_at IS NULL AND supplier_email IS NOT NULL AND supplier_email <> ''"))
    .filter(r => isDue(r.requested_at, r.last_reminder_at, now)).map(r => Object.assign(r, { email: r.supplier_email, name: r.supplier_name, supplier_key: r.supplier_item_id || r.supplier_name }));
  // tous les DA toujours demandés du sous-traitant (pas seulement ceux échus) sont listés dans le même courriel
  for (const g of group(rows)) {
    const all = await q("SELECT id, ref, description, spec_section FROM fin_da WHERE project_item_id = $1 AND status = 'demande' AND deleted_at IS NULL AND lower(supplier_email) = lower($2) ORDER BY seq", [g.project_item_id, g.email]);
    g.rows = all.length ? all : g.rows;
    try {
      if (await sendGroup('da', g, ['Réf.', 'Description', 'Section de devis'], r => [r.ref, r.description, r.spec_section || ''])) {
        await q("UPDATE fin_da SET reminders = reminders + 1, last_reminder_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])", [g.rows.map(r => r.id)]);
        for (const r of g.rows) await q("INSERT INTO fin_da_event (da_id, event, actor, detail) VALUES ($1,'relance','système',$2)", [r.id, 'Relance automatique → ' + g.email]);
        out.da += g.rows.length; out.emails++;
      }
    } catch (e) { out.errors.push('DA ' + g.name + ' : ' + ((e && e.message) || e)); }
  }
}
async function runFc(now, out) {
  const rows = (await q("SELECT id, project_item_id, supplier_key, supplier_name, supplier_email, label, requested_at, last_reminder_at FROM fin_fc_item WHERE party = 'sub' AND applicable AND status = 'demande' AND supplier_email IS NOT NULL AND supplier_email <> ''"))
    .filter(r => isDue(r.requested_at, r.last_reminder_at, now)).map(r => Object.assign(r, { email: r.supplier_email, name: r.supplier_name }));
  for (const g of group(rows)) {
    const all = await q("SELECT id, label, status FROM fin_fc_item WHERE project_item_id = $1 AND party = 'sub' AND supplier_key = $2 AND applicable ORDER BY sort, created_at", [g.project_item_id, g.rows[0].supplier_key]);
    const pending = all.filter(r => r.status === 'a_demander' || r.status === 'demande');
    try {
      const gg = Object.assign({}, g, { rows: pending.length ? pending : g.rows });
      if (await sendGroup('fc', gg, ['Document', 'État'], r => [r.label, 'À fournir'])) {
        await q("UPDATE fin_fc_item SET reminders = reminders + 1, last_reminder_at = now(), updated_at = now() WHERE id = ANY($1::uuid[]) AND status = 'demande'", [gg.rows.map(r => r.id)]);
        for (const r of gg.rows) await q("INSERT INTO fin_fc_event (item_id, project_item_id, event, actor, detail) VALUES ($1,$2,'relance','système',$3)", [r.id, g.project_item_id, 'Relance automatique → ' + g.email]).catch(() => {});
        out.fc += gg.rows.length; out.emails++;
      }
    } catch (e) { out.errors.push('FC ' + g.name + ' : ' + ((e && e.message) || e)); }
  }
}
/** Directives de changement : prix demandés aux sous-traitants (fin_change.price_requests).
 *  Relance après 5 jours (puis tous les 5 jours) tant qu'au moins une ligne de ce sous-traitant est encore à 0 $.
 *  Quand toutes ses lignes ont un prix, la demande est marquée « reçue » automatiquement. */
const EVERY_PRIX_MS = 5 * 86400000 - 12 * 3600000;
const jarr = v => { if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return []; } } return Array.isArray(v) ? v : []; };
function linesOf(ch, p) {
  const em = String(p.email || '').toLowerCase(), nm = String(p.name || '').trim().toLowerCase(), id = String(p.supplierItemId || '');
  return jarr(ch.lines).filter(l => (id && String(l.supplierItemId || '') === id) || (em && String(l.supplierEmail || '').toLowerCase() === em) || (nm && String(l.supplierName || '').trim().toLowerCase() === nm));
}
/** true = le prix manque encore (une ligne à 0 $, ou aucune ligne rattachée à ce sous-traitant : on relance par prudence). */
function stillMissing(ch, p) {
  const m = linesOf(ch, p);
  return !m.length || m.some(l => !(Number(l.price) > 0 || Number(l.price) < 0));
}
async function runPrix(now, out) {
  const chs = await q("SELECT id, project_item_id, legacy, avc_number, ddc_number, title, lines, price_requests FROM fin_change WHERE status = 'attente_prix'");
  const due = [];
  for (const ch of chs) {
    let prs = jarr(ch.price_requests), changed = false;
    prs = prs.map(p => {
      if (!p.received_at && linesOf(ch, p).length && !stillMissing(ch, p)) { changed = true; return Object.assign({}, p, { received_at: new Date().toISOString(), auto_received: true }); }
      return p;
    });
    if (changed) {
      await q('UPDATE fin_change SET price_requests = $2::jsonb, updated_at = now() WHERE id = $1', [ch.id, JSON.stringify(prs)]);
      await q("INSERT INTO fin_change_event (change_id, event, actor, detail) VALUES ($1,'prix_recu','système',$2)", [ch.id, 'Prix inscrits sur les lignes (reçu automatiquement)']).catch(() => {});
    }
    ch.price_requests = prs;
    prs.forEach((p, i) => {
      const ref = p.last_reminder_at || p.sent_at;
      if (!p.received_at && p.email && ref && (now - new Date(ref).getTime()) >= EVERY_PRIX_MS && stillMissing(ch, p)) due.push({ ch, i, p, email: p.email, name: p.name, project_item_id: ch.project_item_id, supplier_key: p.supplierItemId || p.name });
    });
  }
  for (const g of group(due)) {
    // toutes les directives de ce sous-traitant, sur ce projet, dont le prix manque encore
    const lc = String(g.email).toLowerCase();
    const mine = chs.filter(ch => String(ch.project_item_id) === String(g.project_item_id) && jarr(ch.price_requests).some(p => !p.received_at && String(p.email || '').toLowerCase() === lc && stillMissing(ch, p)));
    const gg = Object.assign({}, g, { rows: mine });
    try {
      if (await sendGroup('prix', gg, ['N° demande', 'Objet'], ch => [String(ch.ddc_number || '').trim() || (ch.legacy ? ch.avc_number : '') || '—', ch.title || ''])) {
        for (const ch of mine) {
          const prs = jarr(ch.price_requests).map(p => (!p.received_at && String(p.email || '').toLowerCase() === lc) ? Object.assign({}, p, { last_reminder_at: new Date().toISOString(), reminders: (p.reminders || 0) + 1 }) : p);
          await q('UPDATE fin_change SET price_requests = $2::jsonb, updated_at = now() WHERE id = $1', [ch.id, JSON.stringify(prs)]);
          await q("INSERT INTO fin_change_event (change_id, event, actor, detail) VALUES ($1,'relance_prix','système',$2)", [ch.id, 'Relance automatique → ' + g.email]);
        }
        out.prix += mine.length; out.emails++;
      }
    } catch (e) { out.errors.push('Prix ' + g.name + ' : ' + ((e && e.message) || e)); }
  }
}


/** Échéanciers : rappel (facultatif, case cochée par projet) aux chargés de projets quand l'échéancier n'a pas été envoyé depuis 30 jours. */
async function runSchedules(now, out) {
  const prefs = await q("SELECT project_item_id, last_reminder_at FROM fin_schedule_pref WHERE remind");
  if (!prefs.length) return;
  const sendRows = await q("SELECT project_item_id, max(sent_at) AS last FROM fin_schedule_send WHERE project_item_id = ANY($1::text[]) GROUP BY project_item_id", [prefs.map(p => String(p.project_item_id))]);
  const lastSent = new Map(sendRows.map(r => [String(r.project_item_id), r.last]));
  const inProgress = require('./projstatus').inProgress;
  const byCp = new Map();
  for (const pr of prefs) {
    const project = await projectOf(pr.project_item_id);
    if (!project.number || !inProgress(project)) continue;
    const ls = lastSent.get(String(pr.project_item_id));
    if (ls && now - new Date(ls).getTime() < 30 * 86400000) continue;                 // envoyé récemment
    if (pr.last_reminder_at && now - new Date(pr.last_reminder_at).getTime() < EVERY_MS) continue;   // déjà rappelé cette semaine
    const days = ls ? Math.floor((now - new Date(ls).getTime()) / 86400000) : null;
    (project.cp || []).forEach(c => { const e = String(c.email || '').toLowerCase(); if (!e || !po.isEmail(e)) return; if (!byCp.has(e)) byCp.set(e, { name: c.name || '', rows: [] }); byCp.get(e).rows.push({ id: String(pr.project_item_id), number: project.number, name: project.name, days }); });
  }
  const done = new Set();
  for (const [email, g] of byCp) {
    try {
      const blk = mx.table(['Projet', 'Dernier envoi'], g.rows.map(r => [r.number + ' — ' + r.name, r.days == null ? 'Jamais envoyé' : 'Il y a ' + r.days + ' jours']));
      await mx.send({ user: Object.assign({}, SENDER, { email: process.env.SMTP_USER || '' }), to: [email], cc: [], subject: 'RAPPEL — Échéancier à envoyer (' + g.rows.length + ' projet' + (g.rows.length > 1 ? 's' : '') + ')',
        message: 'Bonjour' + (g.name ? ' ' + g.name.split(' ')[0] : '') + ',\n\nL\'échéancier à jour n\'a pas été transmis depuis plus de 30 jours pour le(s) projet(s) suivant(s) :\n\n{{LISTE}}\nVous pouvez déposer la dernière version et l\'envoyer aux intervenants dans Exacto-Finance (module Échéancier). Ce rappel est envoyé parce que la case « Me rappeler » est cochée sur ces projets.',
        blockHtml: blk.html, blockText: blk.text });
      g.rows.forEach(r => done.add(r.id)); out.emails++;
    } catch (e) { out.errors.push('Échéancier ' + email + ' : ' + ((e && e.message) || e)); }
  }
  if (done.size) { await q("UPDATE fin_schedule_pref SET last_reminder_at = now() WHERE project_item_id = ANY($1::text[])", [Array.from(done)]); out.echeancier += done.size; }
}

/** Point d'entrée du cron. force=true ignore la limite d'une exécution par jour. */
async function runAuto(force) {
  const cfg = await setting('auto_relances');
  if (cfg && cfg.enabled === false) return { enabled: false };
  const t = torontoParts();
  if (!force) {
    if (t.hour < 7) return { skipped: 'avant 7 h' };
    const last = await setting('relances_last_run');
    if (last && last.day === t.day) return { skipped: 'déjà exécutée aujourd\'hui' };
  }
  await setSetting('relances_last_run', { day: t.day });   // marqué d'abord : pas de double envoi si une exécution plante à mi-chemin
  projCache = null;
  const out = { da: 0, fc: 0, prix: 0, echeancier: 0, emails: 0, errors: [] };
  const now = Date.now();
  for (const fn of [runDa, runFc, runPrix, runSchedules]) { try { await fn(now, out); } catch (e) { out.errors.push(String((e && e.message) || e)); } }
  return Object.assign({ ok: true }, out);
}

module.exports = { runAuto, isDue, group, EVERY_MS };
