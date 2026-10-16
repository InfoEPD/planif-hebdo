// api/_lib/absence-db.js — Demandes d'absence (remplace le formulaire Monday « Formulaire - Absence »).
// Base : Neon (celle de Finance, comme Planif). Courriels : SMTP Office 365 (SMTP_USER / SMTP_PASSWORD).
// Points d'entrée (aucune nouvelle fonction Vercel) :
//   - employé mobile (punch.js)  : absenceMine, absenceCreate
//   - lien dans le courriel (punch.js, sans connexion, jeton secret) : absenceDecisionGet, absenceDecide
//   - administration (monday.js → planif-db.js) : absReqList, absReqCreate, absReqDecide, absReqDelete, absStats, absSettingsGet, absSettingsSave
'use strict';
const crypto = require('crypto');
const { q } = require('./planif-db');

const TYPES = [
  { key: 'cnesst', label: 'Accident de travail - CNESST', blocks: true },
  { key: 'noshow', label: 'Absence non-justifiée (No show)', blocks: false, adminOnly: true },
  { key: 'planifiee', label: 'Absence planifiée et autorisée', blocks: true },
  { key: 'personnel', label: 'Congé personnel (Mobile - Équipe de bureau seulement)', blocks: true },
  { key: 'parental', label: 'Congé parental', blocks: true },
  { key: 'sanssolde', label: 'Congé sans solde', blocks: true },
  { key: 'maladie', label: 'Maladie', blocks: true },
  { key: 'maladie_enfant', label: 'Maladie enfant / responsabilité familiale', blocks: true },
  { key: 'rdv', label: 'RDV médical / familial / personnel', blocks: true },
  { key: 'retard', label: 'Retard / Départ anticipé', blocks: false },
  { key: 'vacances', label: 'Vacances autorisées', blocks: true }
];
const TYPE_BY_KEY = {}; TYPES.forEach(t => { TYPE_BY_KEY[t.key] = t; });
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T12:00:00Z'));
const isId = s => /^\d+$/.test(String(s || ''));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
const STATUS_FR = { pending: 'En attente', approved: 'Approuvée', refused: 'Refusée' };

let ready = null;
function ensureTable() {
  if (!ready) ready = q(`CREATE TABLE IF NOT EXISTS absence_request (
    id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL, employee_name TEXT, start_day DATE NOT NULL, end_day DATE NOT NULL,
    days NUMERIC(6,2) NOT NULL DEFAULT 0, hours NUMERIC(5,2), type TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'pending',
    token TEXT UNIQUE, source TEXT NOT NULL DEFAULT 'employee', decided_by TEXT, decision_comment TEXT, decided_at TIMESTAMPTZ,
    planif_absence_id BIGINT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => q('ALTER TABLE absence_request ADD COLUMN IF NOT EXISTS monday_id TEXT'))
    .then(() => q('CREATE UNIQUE INDEX IF NOT EXISTS absence_request_monday_idx ON absence_request (monday_id)'))
    .then(() => q('CREATE INDEX IF NOT EXISTS absence_request_emp_idx ON absence_request (employee_id, start_day)')).catch(e => { ready = null; throw e; });
  return ready;
}

// ----- Utilitaires ---------------------------------------------------------------------------------------------------
async function countDays(start, end) {
  let holidays = new Set();
  try { holidays = new Set((await q(`SELECT to_char(day,'YYYY-MM-DD') AS d FROM planif_holiday WHERE day BETWEEN $1 AND $2`, [start, end])).map(r => r.d)); } catch (e) { /* ignoré */ }
  let n = 0; const d = new Date(start + 'T12:00:00Z'), e = new Date(end + 'T12:00:00Z');
  for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6 && !holidays.has(d.toISOString().slice(0, 10))) n++; }
  return n;
}
function baseUrl(ctx) { return String(process.env.PUBLIC_BASE_URL || (ctx && ctx.origin) || '').replace(/\/+$/, ''); }
async function getRecipients() {
  let v = '';
  try { const r = await q("SELECT value FROM planif_setting WHERE key = 'absenceRecipients'"); v = (r[0] && r[0].value) || ''; } catch (e) { /* ignoré */ }
  return v.split(/[;,\s]+/).map(s => s.trim()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}
async function sendMail(to, subject, html) {
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) return { ok: false, error: "SMTP_USER / SMTP_PASSWORD non configurés." };
  if (!to || (Array.isArray(to) && !to.length)) return { ok: false, error: 'Aucun destinataire.' };
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, auth: { user, pass } });
    await t.sendMail({ from: user, to, subject, html });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
const fmtDay = d => { const [y, m, j] = String(d).slice(0, 10).split('-'); return `${j}/${m}/${y}`; };
function periodLabel(r) { const s = String(r.s || r.start_day).slice(0, 10), e = String(r.e || r.end_day).slice(0, 10); return s === e ? fmtDay(s) : `${fmtDay(s)} au ${fmtDay(e)}`; }
function durationLabel(r) { return r.hours != null && Number(r.hours) > 0 ? `${Number(r.hours)} h (journée partielle)` : `${Number(r.days)} jour${Number(r.days) > 1 ? 's' : ''} ouvrable${Number(r.days) > 1 ? 's' : ''}`; }
const rowOut = r => ({ id: String(r.id), employeeId: String(r.employee_id), name: r.employee_name || '?', start: r.s, end: r.e, days: Number(r.days), hours: r.hours == null ? null : Number(r.hours),
  type: r.type, typeLabel: (TYPE_BY_KEY[r.type] || {}).label || r.type, details: r.details || '', status: r.status, statusLabel: STATUS_FR[r.status] || r.status, source: r.source,
  decidedBy: r.decided_by || '', comment: r.decision_comment || '', decidedAt: r.decided_at || null, createdAt: r.created_at });
const SEL = `SELECT id, employee_id, employee_name, to_char(start_day,'YYYY-MM-DD') AS s, to_char(end_day,'YYYY-MM-DD') AS e, days, hours, type, details, status, source, decided_by, decision_comment, decided_at, created_at FROM absence_request`;

function mailShell(title, bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#1f2937"><h2 style="margin:0 0 12px;color:#0b3d6e">${esc(title)}</h2>${bodyHtml}<p style="color:#94a3b8;font-size:12px;margin-top:24px">Exacto — EPD</p></div>`;
}
function detailTable(r, withEmployee) {
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${k}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`;
  return `<table style="border-collapse:collapse;font-size:14px">${withEmployee ? row('Employé', esc(r.employee_name || r.name)) : ''}${row('Période', esc(periodLabel(r)))}${row('Durée', esc(durationLabel(r)))}${row('Type', esc((TYPE_BY_KEY[r.type] || {}).label || r.type))}${r.details ? row('Informations', esc(r.details)) : ''}</table>`;
}

// ----- Création / décision -------------------------------------------------------------------------------------------
function validate(b, adminMode) {
  const t = TYPE_BY_KEY[String(b.type || '')];
  if (!t) fail(400, "Type d'absence invalide.");
  if (t.adminOnly && !adminMode) fail(400, "Ce type d'absence est saisi par l'administration.");
  if (!isDay(b.start) || !isDay(b.end) || b.end < b.start) fail(400, "Période d'absence invalide.");
  let hours = null;
  if (b.hours !== undefined && b.hours !== null && String(b.hours).trim() !== '') {
    hours = Number(b.hours);
    if (!isFinite(hours) || hours <= 0 || hours > 24) fail(400, 'Durée invalide (en heures, entre 0 et 24).');
    if (b.start !== b.end) fail(400, "La durée en heures s'applique seulement à une journée partielle (même date de début et de fin).");
  }
  return { t, hours, details: String(b.details || '').slice(0, 1000) };
}
async function employeeInfo(id) {
  const r = await q('SELECT id, name, email_pro, email_personal FROM fin_employee WHERE id = $1', [String(id)]);
  if (!r[0]) fail(400, 'Employé introuvable.');
  return r[0];
}
async function applyPlanifBlock(row) {
  const t = TYPE_BY_KEY[row.type];
  if (!t || !t.blocks || (row.hours != null && Number(row.hours) > 0)) return null;
  const r = await q('INSERT INTO planif_absence (employee_id, start_day, end_day, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [String(row.employee_id), row.s, row.e, t.label.slice(0, 200), 'absence-request:' + row.id]);
  return r[0] ? r[0].id : null;
}
async function fetchOne(id) { const r = await q(`${SEL} WHERE id = $1`, [String(id)]); return r[0] || null; }

async function createRequest(b, source, ctx) {
  await ensureTable();
  const adminMode = source === 'admin';
  const v = validate(b, adminMode);
  const emp = await employeeInfo(b.employeeId);
  const days = v.hours ? 0 : await countDays(b.start, b.end);
  const status = adminMode ? 'approved' : 'pending';
  const token = adminMode ? null : crypto.randomBytes(24).toString('hex');
  const ins = await q(`INSERT INTO absence_request (employee_id, employee_name, start_day, end_day, days, hours, type, details, status, token, source, created_by, decided_by, decided_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [String(emp.id), emp.name, b.start, b.end, days, v.hours, v.t.key, v.details, status, token, source, (ctx && ctx.email) || ('employee:' + emp.id),
      adminMode ? ((ctx && ctx.email) || 'Administration') : null, adminMode ? new Date().toISOString() : null]);
  const id = String(ins[0].id);
  let row = await fetchOne(id);
  if (adminMode) {
    const pid = await applyPlanifBlock(row);
    if (pid) await q('UPDATE absence_request SET planif_absence_id = $2 WHERE id = $1', [id, pid]);
    return { id, mail: null };
  }
  // Courriel aux destinataires configurés, avec boutons Approuver / Refuser.
  const recipients = await getRecipients();
  const base = baseUrl(ctx);
  const link = d => `${base}/absence-reponse.html?t=${token}&d=${d}`;
  const btn = (href, label, color) => `<a href="${href}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:700;margin-right:10px">${label}</a>`;
  const html = mailShell("Nouvelle demande d'absence", `<p>${esc(emp.name)} a soumis une demande d'absence.</p>${detailTable(row, true)}<p style="margin:20px 0">${btn(link('approve'), 'Approuver', '#15803d')}${btn(link('refuse'), 'Refuser', '#b91c1c')}</p><p style="font-size:12px;color:#64748b">Vous pourrez ajouter un commentaire avant de confirmer.</p>`);
  const mail = await sendMail(recipients, `Demande d'absence — ${emp.name} (${periodLabel(row)})`, html);
  return { id, mail };
}

async function decide(where, decision, comment, by, ctx) {
  await ensureTable();
  if (decision !== 'approved' && decision !== 'refused') fail(400, 'Décision invalide.');
  comment = String(comment || '').trim().slice(0, 1000);
  if (decision === 'refused' && !comment) fail(400, 'Un commentaire est requis pour refuser une demande.');
  const cur = await q(`${SEL} WHERE ${where.sql}`, where.params);
  const row = cur[0];
  if (!row) fail(404, 'Demande introuvable.');
  if (row.status !== 'pending') fail(409, `Cette demande a déjà été traitée (${STATUS_FR[row.status] || row.status}).`);
  const upd = await q("UPDATE absence_request SET status = $2, decision_comment = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [String(row.id), decision, comment, String(by || '').slice(0, 120)]);
  if (!upd[0]) fail(409, 'Cette demande vient d’être traitée par quelqu’un d’autre.');
  if (decision === 'approved') { const pid = await applyPlanifBlock(row); if (pid) await q('UPDATE absence_request SET planif_absence_id = $2 WHERE id = $1', [String(row.id), pid]); }
  // Confirmation à l'employé
  let mail = { ok: false, error: 'Aucun courriel au dossier de l’employé.' };
  try {
    const emp = await employeeInfo(row.employee_id);
    const to = emp.email_pro || emp.email_personal;
    if (to) {
      const ok = decision === 'approved';
      const html = mailShell(ok ? "Demande d'absence approuvée" : "Demande d'absence refusée",
        `<p>Bonjour ${esc(emp.name)},</p><p>Votre demande d'absence a été <b style="color:${ok ? '#15803d' : '#b91c1c'}">${ok ? 'approuvée' : 'refusée'}</b>.</p>${detailTable(row, false)}${comment ? `<p style="margin-top:14px"><b>Commentaire :</b><br>${esc(comment).replace(/\n/g, '<br>')}</p>` : ''}`);
      mail = await sendMail(to, `Votre demande d'absence a été ${ok ? 'approuvée' : 'refusée'} (${periodLabel(row)})`, html);
    }
  } catch (e) { mail = { ok: false, error: e.message }; }
  return { ok: true, status: decision, mail };
}

// ----- Employé (mobile) ----------------------------------------------------------------------------------------------
async function employeeList(employeeId) {
  await ensureTable();
  const rows = await q(`${SEL} WHERE employee_id = $1 ORDER BY start_day DESC, id DESC LIMIT 100`, [String(employeeId)]);
  return { requests: rows.map(rowOut), types: TYPES.filter(t => !t.adminOnly).map(t => ({ key: t.key, label: t.label })) };
}
async function employeeCreate(employeeId, b, ctx) {
  const out = await createRequest(Object.assign({}, b, { employeeId }), 'employee', ctx);
  return { ok: true, id: out.id, mailSent: !!(out.mail && out.mail.ok), mailError: out.mail && !out.mail.ok ? out.mail.error : undefined };
}


// ----- Formulaire public (employés sans l'appli Punch) : exactoapp.ca/absenceepd ----------------------------------
const normName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
function publicTypes() { return { types: TYPES.filter(t => !t.adminOnly).map(t => ({ key: t.key, label: t.label })) }; }
async function publicCreate(b, ctx) {
  await ensureTable();
  if (b.website) return { ok: true }; // piège anti-robot : champ caché rempli
  const key = normName(b.name);
  if (key.split(' ').length < 2) fail(400, 'Inscrivez votre nom complet : prénom nom.');
  const emps = (await q("SELECT id, name FROM fin_employee WHERE status = 'Actif' AND company = 'EPD'")).filter(e => normName(e.name) === key);
  if (emps.length !== 1) fail(404, "Nous n'avons pas trouvé cet employé. Vérifiez l'orthographe de votre nom complet (prénom nom) ou communiquez avec l'administration.");
  const pend = await q("SELECT count(*)::int AS n FROM absence_request WHERE employee_id = $1 AND status = 'pending'", [String(emps[0].id)]);
  if (pend[0] && pend[0].n >= 5) fail(429, "Vous avez déjà plusieurs demandes en attente. Veuillez attendre leur traitement.");
  const out = await createRequest(Object.assign({}, b, { employeeId: emps[0].id }), 'public', ctx);
  return { ok: true, id: out.id };
}

// ----- Lien public (courriel) ----------------------------------------------------------------------------------------
async function publicGet(token) {
  await ensureTable();
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) fail(400, 'Lien invalide.');
  const r = await q(`${SEL} WHERE token = $1`, [token]);
  if (!r[0]) fail(404, 'Demande introuvable.');
  const o = rowOut(r[0]); return { request: { name: o.name, start: o.start, end: o.end, days: o.days, hours: o.hours, typeLabel: o.typeLabel, details: o.details, status: o.status, statusLabel: o.statusLabel, comment: o.comment, decidedBy: o.decidedBy } };
}
async function publicDecide(b, ctx) {
  if (!/^[a-f0-9]{48}$/.test(String(b.token || ''))) fail(400, 'Lien invalide.');
  const by = String(b.by || '').trim() || 'Destinataire du courriel';
  return decide({ sql: 'token = $1', params: [b.token] }, b.decision === 'approve' || b.decision === 'approved' ? 'approved' : (b.decision === 'refuse' || b.decision === 'refused' ? 'refused' : ''), b.comment, by, ctx);
}

// ----- Administration ------------------------------------------------------------------------------------------------
async function adminList(b) {
  await ensureTable();
  const where = [], params = [];
  if (isId(b.employeeId)) { params.push(String(b.employeeId)); where.push(`employee_id = $${params.length}`); }
  if (TYPE_BY_KEY[b.type]) { params.push(b.type); where.push(`type = $${params.length}`); }
  if (['pending', 'approved', 'refused'].includes(b.status)) { params.push(b.status); where.push(`status = $${params.length}`); }
  if (isDay(b.from)) { params.push(b.from); where.push(`end_day >= $${params.length}`); }
  if (isDay(b.to)) { params.push(b.to); where.push(`start_day <= $${params.length}`); }
  const rows = await q(`${SEL}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY (status = 'pending') DESC, start_day DESC, id DESC LIMIT 500`, params);
  const emps = await q("SELECT id, name FROM fin_employee WHERE status IN ('Actif','Inactif') ORDER BY name");
  return { requests: rows.map(rowOut), employees: emps.map(e => ({ id: String(e.id), name: e.name })), types: TYPES.map(t => ({ key: t.key, label: t.label })) };
}
async function adminCreate(b, ctx) { const out = await createRequest(b, 'admin', ctx); return { ok: true, id: out.id }; }
async function adminDecide(b, ctx) {
  if (!isId(b.id)) fail(400, 'Demande invalide.');
  return decide({ sql: 'id = $1', params: [String(b.id)] }, b.decision === 'approved' || b.decision === 'refused' ? b.decision : '', b.comment, (ctx && ctx.email) || 'Administration', ctx);
}
async function adminDelete(b) {
  await ensureTable();
  if (!isId(b.id)) fail(400, 'Demande invalide.');
  const r = await q('DELETE FROM absence_request WHERE id = $1 RETURNING planif_absence_id', [String(b.id)]);
  if (r[0] && r[0].planif_absence_id) await q('DELETE FROM planif_absence WHERE id = $1', [r[0].planif_absence_id]);
  return { ok: true };
}
/** Statistiques sur les absences approuvées dont le début tombe dans la période (filtre employé / type facultatif). */
async function adminStats(b) {
  await ensureTable();
  const y = new Date().getFullYear();
  const from = isDay(b.from) ? b.from : y + '-01-01', to = isDay(b.to) ? b.to : y + '-12-31';
  const params = [from, to]; let extra = '';
  if (isId(b.employeeId)) { params.push(String(b.employeeId)); extra += ` AND employee_id = $${params.length}`; }
  if (TYPE_BY_KEY[b.type]) { params.push(b.type); extra += ` AND type = $${params.length}`; }
  const rows = await q(`${SEL} WHERE status = 'approved' AND start_day >= $1 AND start_day <= $2${extra} ORDER BY employee_name`, params);
  const pend = await q("SELECT count(*)::int AS n FROM absence_request WHERE status = 'pending'");
  const byEmp = {}, byType = {}, byMonth = {}, byWeekday = [0, 0, 0, 0, 0];
  const tot = { count: 0, days: 0, hours: 0 };
  const add = (o, k, r) => { const x = o[k] = o[k] || { count: 0, days: 0, hours: 0 }; x.count++; x.days += Number(r.days); x.hours += Number(r.hours || 0); };
  rows.forEach(r => {
    const e = byEmp[r.employee_id] = byEmp[r.employee_id] || { employeeId: String(r.employee_id), name: r.employee_name || '?', total: { count: 0, days: 0, hours: 0 }, types: {}, last: '', noshow: 0 };
    add(e.types, r.type, r); add(byType, r.type, r); add(byMonth, r.s.slice(0, 7), r);
    e.total.count++; e.total.days += Number(r.days); e.total.hours += Number(r.hours || 0); tot.count++; tot.days += Number(r.days); tot.hours += Number(r.hours || 0);
    if (r.type === 'noshow') e.noshow++;
    if (r.e > e.last) e.last = r.e;
    // jours de la semaine touchés (lun-ven)
    const d = new Date(r.s + 'T12:00:00Z'), end = new Date(r.e + 'T12:00:00Z');
    for (let i = 0; d <= end && i < 400; i++, d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w >= 1 && w <= 5) byWeekday[w - 1]++; }
  });
  const emps = Object.values(byEmp).sort((a, c) => c.total.days - a.total.days || c.total.hours - a.total.hours || a.name.localeCompare(c.name));
  return { from, to, employees: emps, totals: Object.assign({ employees: emps.length, pending: pend[0] ? pend[0].n : 0 }, tot),
    byType: TYPES.map(t => ({ key: t.key, label: t.label, ...(byType[t.key] || { count: 0, days: 0, hours: 0 }) })).filter(t => t.count),
    byMonth: Object.keys(byMonth).sort().map(k => ({ month: k, ...byMonth[k] })), byWeekday, types: TYPES.map(t => ({ key: t.key, label: t.label })) };
}
async function settingsGet() { return { recipients: (await getRecipients()).join(', '), smtpConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASSWORD) }; }
async function settingsSave(b) {
  const list = String(b.recipients || '').split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
  const bad = list.find(s => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  if (bad) fail(400, `Adresse courriel invalide : ${bad}`);
  await q("INSERT INTO planif_setting (key, value) VALUES ('absenceRecipients', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [list.join(', ')]);
  return { ok: true };
}

module.exports = { publicTypes, publicCreate, TYPES, employeeList, employeeCreate, publicGet, publicDecide, adminList, adminCreate, adminDecide, adminDelete, adminStats, settingsGet, settingsSave, countDays };
