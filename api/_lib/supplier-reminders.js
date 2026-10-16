// api/_lib/supplier-reminders.js — état de conformité des fournisseurs et rappels par courriel.
// Les rappels AUTOMATIQUES sont désactivés tant que l'administrateur ne les active pas (fin_settings « compliance_reminders »).
// Un fournisseur n'est rappelé automatiquement que si sa fiche a « Rappels automatiques = oui ».

const { q } = require('./db');
const mail = require('./mail');

const DEFAULTS = { enabled: false, leadDays: 30, repeatDays: 7, ccAccounting: true };
const KINDS = {
  assurance: { col: 'liability_expiry', label: "Assurance responsabilité", doc: "preuve d'assurance responsabilité" },
  rq: { col: 'rq_expiry', label: 'Attestation de Revenu Québec', doc: "attestation de Revenu Québec à jour" }
};
const esc = mail.esc;
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000);

async function getSettings() {
  let v = null;
  try { const r = await q("SELECT value FROM fin_settings WHERE key = 'compliance_reminders'"); v = r[0] && r[0].value; } catch (e) { /* table absente */ }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  const o = Object.assign({}, DEFAULTS, v && typeof v === 'object' ? v : {});
  o.enabled = o.enabled === true;
  o.leadDays = Math.min(180, Math.max(1, Number(o.leadDays) || DEFAULTS.leadDays));
  o.repeatDays = Math.min(60, Math.max(1, Number(o.repeatDays) || DEFAULTS.repeatDays));
  o.ccAccounting = o.ccAccounting !== false;
  return o;
}
async function saveSettings(s, by) {
  const clean = { enabled: s.enabled === true, leadDays: Math.min(180, Math.max(1, Number(s.leadDays) || DEFAULTS.leadDays)),
    repeatDays: Math.min(60, Math.max(1, Number(s.repeatDays) || DEFAULTS.repeatDays)), ccAccounting: s.ccAccounting !== false };
  await q(`INSERT INTO fin_settings (key, value, updated_by) VALUES ('compliance_reminders', $1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(clean), by || null]);
  return clean;
}

/** État d'un document : conforme | a_renouveler | expire | a_completer (+ jours restants). */
function docStatus(expiry, leadDays, today) {
  if (!expiry) return { status: 'a_completer', days: null };
  const d = diffDays(expiry, today || todayStr());
  if (d < 0) return { status: 'expire', days: d };
  if (d <= leadDays) return { status: 'a_renouveler', days: d };
  return { status: 'conforme', days: d };
}
const RANK = { conforme: 0, a_completer: 1, a_renouveler: 2, expire: 3 };
function compliance(s, leadDays, today) {
  const a = docStatus(s.liability_expiry, leadDays, today), r = docStatus(s.rq_expiry, leadDays, today);
  const overall = RANK[a.status] >= RANK[r.status] ? a.status : r.status;
  return { assurance: a, rq: r, overall };
}

/** Courriels de destination d'un fournisseur (ordre de préférence), sans doublons. */
function recipients(s) {
  const seen = new Set(), out = [];
  [s.email_general, s.email, s.ap_email, s.ord_email, s.email_accounting, s.email_tender].forEach(v => {
    String(v || '').split(/[;,\s]+/).forEach(e => { e = e.trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !seen.has(e)) { seen.add(e); out.push(e); } });
  });
  return out;
}

function buildMail(s, kind, expiry, days) {
  const k = KINDS[kind];
  const expired = days != null && days < 0;
  const dateTxt = expiry || '';
  const subject = (expired ? 'Document expiré' : 'Document à renouveler') + ' — ' + k.label + ' — ' + s.name;
  const intro = expired
    ? 'Notre dossier indique que votre ' + k.label.toLowerCase() + ' est <b>expirée depuis le ' + esc(dateTxt) + '</b>.'
    : 'Notre dossier indique que votre ' + k.label.toLowerCase() + ' <b>expire le ' + esc(dateTxt) + '</b>' + (days != null ? ' (dans ' + days + ' jour' + (days > 1 ? 's' : '') + ')' : '') + '.';
  const html = mail.shell('<p>Bonjour,</p><p>' + intro + '</p>' +
    '<p>Afin de maintenir votre dossier de fournisseur / sous-traitant conforme, merci de nous transmettre votre ' + esc(k.doc) + ' dès que possible, en répondant à ce courriel.</p>' +
    '<p>Merci de votre collaboration.</p>');
  const text = 'Bonjour,\n\n' + intro.replace(/<[^>]+>/g, '') + '\n\nMerci de nous transmettre votre ' + k.doc + ' dès que possible, en répondant à ce courriel.\n\nMerci de votre collaboration.';
  return { subject, html, text };
}

async function accountingCc(settings) {
  if (!settings.ccAccounting) return [];
  try { return await require('./invoice').accountingEmails(); } catch (e) { return []; }
}

async function sendOne(s, kind, mode, by, settings, replyTo) {
  const k = KINDS[kind]; if (!k) throw { status: 400, message: 'Type de rappel invalide.' };
  const expiry = s[k.col];
  const to = recipients(s);
  if (!to.length) throw { status: 400, message: 'Aucun courriel valide pour ce fournisseur.' };
  const days = expiry ? diffDays(expiry, todayStr()) : null;
  const m = buildMail(s, kind, expiry, days);
  const cc = (await accountingCc(settings)).filter(e => !to.includes(e));
  await mail.sendMail({ to: to.join(', '), cc: cc.join(', '), replyTo: replyTo || undefined, subject: m.subject, html: m.html, text: m.text });
  await q('INSERT INTO fin_supplier_reminder (supplier_id, kind, expiry, sent_to, mode, sent_by) VALUES ($1,$2,$3,$4,$5,$6)', [s.id, kind, expiry || null, to.join(', '), mode, by || null]);
  return to;
}

const SEL = `SELECT id, ext_id, name, email, email_general, email_tender, email_accounting, ap_email, ord_email,
  to_char(liability_expiry,'YYYY-MM-DD') AS liability_expiry, to_char(rq_expiry,'YYYY-MM-DD') AS rq_expiry, auto_reminders FROM fin_supplier`;

/** Fournisseurs à rappeler (réglages actuels). Ne tient pas compte de « enabled » : sert aussi à l'aperçu. */
async function candidates(settings) {
  const rows = await q(SEL + " WHERE auto_reminders = 'oui' AND in_avantage AND NOT avantage_inactive AND NOT blacklisted");
  const today = todayStr(), out = [];
  for (const s of rows) {
    for (const kind of Object.keys(KINDS)) {
      const exp = s[KINDS[kind].col]; if (!exp) continue;
      const d = diffDays(exp, today);
      if (d > settings.leadDays) continue;
      const last = await q("SELECT sent_at FROM fin_supplier_reminder WHERE supplier_id = $1 AND kind = $2 AND expiry = $3 ORDER BY sent_at DESC LIMIT 1", [s.id, kind, exp]);
      if (last[0] && (Date.now() - new Date(last[0].sent_at).getTime()) < settings.repeatDays * 86400000) continue;
      out.push({ s, kind, expiry: exp, days: d, recipients: recipients(s) });
    }
  }
  return out;
}

/** Exécution automatique (cron). Aucun courriel si les rappels ne sont pas activés. */
async function runAuto() {
  const settings = await getSettings();
  if (!settings.enabled) return { enabled: false, sent: 0, note: 'Rappels automatiques désactivés.' };
  const list = await candidates(settings);
  let sent = 0; const errors = [];
  for (const c of list.slice(0, 40)) {
    try { await sendOne(c.s, c.kind, 'auto', null, settings); sent++; }
    catch (e) { errors.push(c.s.name + ' : ' + ((e && e.message) || e)); }
  }
  return { enabled: true, candidates: list.length, sent, errors };
}

module.exports = { getSettings, saveSettings, docStatus, compliance, recipients, candidates, sendOne, runAuto, KINDS, DEFAULTS, SEL };
