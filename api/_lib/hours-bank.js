// api/_lib/hours-bank.js
//
// Banques de temps et feuilles de temps (Exacto-Heures / Exacto-Punch), dans Neon (même base que Planif).
//
// Banques (une transaction = un mouvement en heures, le solde = somme des transactions) :
//   ccq    — banque d'heures CCQ des employés de chantier
//   hccq   — banque d'heures hors CCQ des employés de chantier
//   bureau — banque de temps des employés de bureau (heures travaillées − heures payées)
//   mobile — banque d'heures mobiles des employés de bureau (utilisables à volonté sur la feuille de temps)
//
// Chantier : dans la « Vue de la semaine », l'administrateur inscrit les heures PAYÉES (par défaut = travaillées).
//   mouvement de la semaine = travaillées − payées (positif = l'employé met des heures en banque, négatif = il en retire).
// Bureau : l'employé saisit sa feuille de temps (hebdomadaire, dimanche → samedi) ; à la soumission, un courriel est
//   envoyé au responsable désigné (Comptes employés) ; mouvement « bureau » = Σ(travaillées + mobiles utilisées − payées),
//   mouvement « mobile » = − Σ mobiles utilisées.
//
// Ressource 'hours' de api/punch.js : { resource: 'hours', action, ...params }. Rôles : admin (tout), lecture-seule
// (consultation), employee (ses propres données seulement).

'use strict';
const { q } = require('./planif-db');

const BANKS = ['ccq', 'hccq', 'bureau', 'mobile'];
const BANK_LABEL = { ccq: 'Banque CCQ', hccq: 'Banque hors CCQ', bureau: 'Banque de temps (bureau)', mobile: 'Banque d\'heures mobiles' };
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T12:00:00Z'));
const isId = s => /^\d+$/.test(String(s || ''));
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
function num(v, { min = -1000, max = 1000 } = {}) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(n)) fail(400, 'Nombre invalide.');
  return Math.max(min, Math.min(max, r2(n)));
}
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
/** Dimanche de la semaine qui contient d (semaines dimanche → samedi, comme les poinçons). */
function sundayOf(d) { if (!isDay(d)) fail(400, 'Date invalide.'); const t = new Date(d + 'T12:00:00Z'); return addDays(d, -t.getUTCDay()); }
const fmtDay = d => { const [y, m, j] = String(d).slice(0, 10).split('-'); return j + '/' + m + '/' + y; };
const DOW = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

let ready = null;
function ensure() {
  if (!ready) {
    ready = (async () => {
      await q(`CREATE TABLE IF NOT EXISTS hb_cfg (employee_id TEXT PRIMARY KEY, timesheet BOOLEAN NOT NULL DEFAULT FALSE, approver_employee_id TEXT, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS hb_tx (id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL, bank TEXT NOT NULL, kind TEXT NOT NULL, day DATE NOT NULL, hours NUMERIC(8,2) NOT NULL,
        note TEXT, ref TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (employee_id, bank, ref))`);
      await q('CREATE INDEX IF NOT EXISTS hb_tx_emp_idx ON hb_tx (employee_id, bank, day)');
      await q(`CREATE TABLE IF NOT EXISTS hb_pay (employee_id TEXT NOT NULL, week_start DATE NOT NULL, worked_ccq NUMERIC(8,2) NOT NULL DEFAULT 0, worked_hccq NUMERIC(8,2) NOT NULL DEFAULT 0,
        paid_ccq NUMERIC(8,2) NOT NULL DEFAULT 0, paid_hccq NUMERIC(8,2) NOT NULL DEFAULT 0, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (employee_id, week_start))`);
      await q(`CREATE TABLE IF NOT EXISTS hb_ts (id BIGSERIAL PRIMARY KEY, employee_id TEXT NOT NULL, week_start DATE NOT NULL, status TEXT NOT NULL DEFAULT 'brouillon', days JSONB NOT NULL DEFAULT '{}'::jsonb,
        comment TEXT, approver_email TEXT, submitted_at TIMESTAMPTZ, mail_status TEXT, reopened_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (employee_id, week_start))`);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

async function sendMail(to, subject, html) {
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) return { ok: false, error: 'SMTP_USER / SMTP_PASSWORD non configurés.' };
  if (!to || (Array.isArray(to) && !to.length)) return { ok: false, error: 'Aucun destinataire.' };
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true, auth: { user, pass } });
    await t.sendMail({ from: user, to, subject, html });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ───────────────────────── Soldes et transactions ─────────────────────────
async function balancesFor(ids) {
  const rows = ids ? await q('SELECT employee_id, bank, SUM(hours)::float AS h FROM hb_tx WHERE employee_id = ANY($1::text[]) GROUP BY employee_id, bank', [ids.map(String)])
    : await q('SELECT employee_id, bank, SUM(hours)::float AS h FROM hb_tx GROUP BY employee_id, bank');
  const out = {};
  rows.forEach(r => { (out[String(r.employee_id)] = out[String(r.employee_id)] || {})[r.bank] = r2(r.h); });
  return out;
}
const blank = b => Object.assign({ ccq: 0, hccq: 0, bureau: 0, mobile: 0 }, b || {});
const txOut = t => ({ id: String(t.id), bank: t.bank, kind: t.kind, day: String(t.d), hours: Number(t.hours), note: t.note || '', by: t.created_by || '', at: t.created_at });
const KIND_LABEL = { opening: 'Solde d\'ouverture', week: 'Semaine', adjust: 'Ajustement', ts: 'Feuille de temps' };

async function setTx(employeeId, bank, ref, kind, day, hours, note, by) {
  if (!hours) { await q('DELETE FROM hb_tx WHERE employee_id = $1 AND bank = $2 AND ref = $3', [employeeId, bank, ref]); return; }
  await q(`INSERT INTO hb_tx (employee_id, bank, kind, day, hours, note, ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (employee_id, bank, ref) DO UPDATE SET kind = EXCLUDED.kind, day = EXCLUDED.day, hours = EXCLUDED.hours, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()`,
    [employeeId, bank, kind, day, hours, note || null, ref, by || null]);
}

// ───────────────────────── Administration ─────────────────────────
const ADMIN = {
  /** Semaine : heures payées saisies + soldes de tous les employés. */
  async weekGet(b) {
    const ws = sundayOf(b.weekStart);
    const rows = await q('SELECT employee_id, worked_ccq::float AS wc, worked_hccq::float AS wh, paid_ccq::float AS pc, paid_hccq::float AS ph FROM hb_pay WHERE week_start = $1', [ws]);
    const pay = {};
    rows.forEach(r => { pay[String(r.employee_id)] = { workedCcq: r.wc, workedHccq: r.wh, paidCcq: r.pc, paidHccq: r.ph }; });
    const bal = await balancesFor(null);
    Object.keys(bal).forEach(k => { bal[k] = blank(bal[k]); });
    return { weekStart: ws, pay, balances: bal };
  },

  /** Heures payées d'un employé pour une semaine (travaillées fournies par l'écran, calculées à partir des poinçons). */
  async paySave(b, ctx) {
    if (!isId(b.employeeId)) fail(400, 'Employé invalide.');
    const ws = sundayOf(b.weekStart);
    const wc = num(b.workedCcq, { min: 0 }) || 0, wh = num(b.workedHccq, { min: 0 }) || 0;
    const pc = num(b.paidCcq, { min: 0 }), ph = num(b.paidHccq, { min: 0 });
    const paidC = pc == null ? wc : pc, paidH = ph == null ? wh : ph;
    const note = 'Semaine du ' + fmtDay(ws) + ' : travaillées ' + (wc + wh).toFixed(2) + ' h';
    await q(`INSERT INTO hb_pay (employee_id, week_start, worked_ccq, worked_hccq, paid_ccq, paid_hccq, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (employee_id, week_start) DO UPDATE SET worked_ccq = EXCLUDED.worked_ccq, worked_hccq = EXCLUDED.worked_hccq, paid_ccq = EXCLUDED.paid_ccq, paid_hccq = EXCLUDED.paid_hccq, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.employeeId, ws, wc, wh, paidC, paidH, ctx.email || '']);
    await setTx(b.employeeId, 'ccq', 'wk:' + ws, 'week', ws, r2(wc - paidC), note + ' (CCQ ' + wc.toFixed(2) + ' / payées ' + paidC.toFixed(2) + ')', ctx.email);
    await setTx(b.employeeId, 'hccq', 'wk:' + ws, 'week', ws, r2(wh - paidH), note + ' (hors CCQ ' + wh.toFixed(2) + ' / payées ' + paidH.toFixed(2) + ')', ctx.email);
    const bal = blank((await balancesFor([b.employeeId]))[b.employeeId]);
    return { ok: true, paidCcq: paidC, paidHccq: paidH, balance: bal };
  },

  async balances() {
    const [emps, bal, cfg] = await Promise.all([
      q(`SELECT id::text AS id, name, status, department, job_title FROM fin_employee WHERE company = 'EPD' ORDER BY name`),
      balancesFor(null), q('SELECT employee_id, timesheet FROM hb_cfg')]);
    const ts = {}; cfg.forEach(c => { ts[String(c.employee_id)] = !!c.timesheet; });
    return { employees: emps.map(e => ({ id: e.id, name: e.name, status: e.status, department: e.department, title: e.job_title, timesheet: !!ts[e.id], balances: blank(bal[e.id]) })) };
  },

  async txList(b) {
    if (!isId(b.employeeId)) fail(400, 'Employé invalide.');
    const rows = await q(`SELECT id, bank, kind, to_char(day,'YYYY-MM-DD') AS d, hours::float AS hours, note, created_by, created_at FROM hb_tx WHERE employee_id = $1 ORDER BY day DESC, id DESC LIMIT 500`, [b.employeeId]);
    return { transactions: rows.map(txOut), balances: blank((await balancesFor([b.employeeId]))[b.employeeId]) };
  },

  /** Solde d'ouverture (remplace l'existant pour la banque) ou ajustement manuel (peut être négatif). */
  async txAdd(b, ctx) {
    if (!isId(b.employeeId)) fail(400, 'Employé invalide.');
    if (!BANKS.includes(b.bank)) fail(400, 'Banque invalide.');
    const hours = num(b.hours); if (hours == null) fail(400, 'Indiquez un nombre d\'heures.');
    const day = isDay(b.day) ? b.day : new Date().toISOString().slice(0, 10);
    const note = String(b.note || '').slice(0, 200);
    if (b.kind === 'opening') {
      await q('DELETE FROM hb_tx WHERE employee_id = $1 AND bank = $2 AND ref = $3', [b.employeeId, b.bank, 'opening']);
      await q(`INSERT INTO hb_tx (employee_id, bank, kind, day, hours, note, ref, created_by) VALUES ($1,$2,'opening',$3,$4,$5,'opening',$6)`, [b.employeeId, b.bank, day, hours, note || 'Solde d\'ouverture', ctx.email || '']);
    } else if (b.kind === 'adjust') {
      if (!hours) fail(400, 'Le nombre d\'heures ne peut pas être 0.');
      await q(`INSERT INTO hb_tx (employee_id, bank, kind, day, hours, note, created_by) VALUES ($1,$2,'adjust',$3,$4,$5,$6)`, [b.employeeId, b.bank, day, hours, note || 'Ajustement', ctx.email || '']);
    } else fail(400, 'Type de transaction invalide.');
    return ADMIN.txList({ employeeId: b.employeeId });
  },
  async txDelete(b) {
    if (!isId(b.id)) fail(400, 'Transaction invalide.');
    const r = await q("DELETE FROM hb_tx WHERE id = $1 AND kind IN ('opening','adjust') RETURNING employee_id", [b.id]);
    if (!r.length) fail(409, 'Seuls un solde d\'ouverture ou un ajustement manuel peuvent être supprimés.');
    return ADMIN.txList({ employeeId: String(r[0].employee_id) });
  },

  // ----- Configuration par employé (Comptes employés) -----
  async cfgList() {
    const rows = await q('SELECT employee_id, timesheet, approver_employee_id FROM hb_cfg');
    const cfg = {}; rows.forEach(r => { cfg[String(r.employee_id)] = { timesheet: !!r.timesheet, approverEmployeeId: r.approver_employee_id || '' }; });
    return { cfg };
  },
  async cfgSave(b, ctx) {
    if (!isId(b.employeeId)) fail(400, 'Employé invalide.');
    const appr = b.approverEmployeeId ? String(b.approverEmployeeId) : null;
    if (appr && !isId(appr)) fail(400, 'Responsable invalide.');
    if (b.timesheet && !appr) {
      const cur = await q('SELECT approver_employee_id FROM hb_cfg WHERE employee_id = $1', [b.employeeId]);
      if (!(cur[0] && cur[0].approver_employee_id)) { /* permis : le responsable peut être choisi ensuite, la soumission sera refusée tant qu'il manque */ }
    }
    await q(`INSERT INTO hb_cfg (employee_id, timesheet, approver_employee_id, updated_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT (employee_id) DO UPDATE SET timesheet = EXCLUDED.timesheet, approver_employee_id = EXCLUDED.approver_employee_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.employeeId, !!b.timesheet, appr, ctx.email || '']);
    return { ok: true };
  },

  // ----- Feuilles de temps (vue administrateur) -----
  async tsList(b) {
    const params = []; let where = 'TRUE';
    if (b.weekStart) { params.push(sundayOf(b.weekStart)); where += ' AND t.week_start = $' + params.length; }
    if (b.status) { params.push(String(b.status)); where += ' AND t.status = $' + params.length; }
    const rows = await q(`SELECT t.id, t.employee_id, e.name, to_char(t.week_start,'YYYY-MM-DD') AS ws, t.status, t.days, t.comment, t.approver_email, t.submitted_at, t.mail_status
      FROM hb_ts t LEFT JOIN fin_employee e ON e.id::text = t.employee_id WHERE ${where} ORDER BY t.week_start DESC, e.name LIMIT 300`, params);
    return { sheets: rows.map(r => Object.assign(tsOut(r), { employeeName: r.name || '?' })) };
  },
  /** Rouvre une feuille soumise (l'employé peut la corriger et la soumettre de nouveau) : ses mouvements de banque sont annulés. */
  async tsReopen(b, ctx) {
    if (!isId(b.id)) fail(400, 'Feuille invalide.');
    const r = await q("UPDATE hb_ts SET status = 'brouillon', reopened_by = $2, updated_at = now() WHERE id = $1 RETURNING employee_id", [b.id, ctx.email || '']);
    if (!r.length) fail(404, 'Feuille introuvable.');
    await q("DELETE FROM hb_tx WHERE employee_id = $1 AND ref LIKE $2", [String(r[0].employee_id), 'ts:' + b.id + ':%']);
    return { ok: true };
  }
};

// ───────────────────────── Feuilles de temps ─────────────────────────
function tsTotals(days) {
  let worked = 0, paid = 0, mobile = 0;
  Object.values(days || {}).forEach(d => { worked += Number(d.worked) || 0; paid += Number(d.paid) || 0; mobile += Number(d.mobile) || 0; });
  return { worked: r2(worked), paid: r2(paid), mobile: r2(mobile), bankDelta: r2(worked + mobile - paid) };
}
function tsOut(r) {
  const days = r.days && typeof r.days === 'object' ? r.days : {};
  return { id: String(r.id), employeeId: String(r.employee_id), weekStart: r.ws, status: r.status, days, comment: r.comment || '', approverEmail: r.approver_email || '', submittedAt: r.submitted_at, mailStatus: r.mail_status || '', totals: tsTotals(days) };
}
function cleanDays(ws, input) {
  const out = {};
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i), x = (input && input[d]) || {};
    const worked = num(x.worked, { min: 0, max: 24 }) || 0, mobile = num(x.mobile, { min: 0, max: 24 }) || 0;
    const paidIn = num(x.paid, { min: 0, max: 24 });
    out[d] = { worked, mobile, paid: paidIn == null ? r2(worked + mobile) : paidIn, note: String(x.note || '').slice(0, 200) };
  }
  return out;
}
async function empInfo(id) {
  const r = await q(`SELECT id::text AS id, name, email_pro, email_personal, department, status FROM fin_employee WHERE id::text = $1`, [String(id)]);
  return r[0] || null;
}
async function approverOf(employeeId) {
  const c = await q('SELECT approver_employee_id FROM hb_cfg WHERE employee_id = $1', [String(employeeId)]);
  const aid = c[0] && c[0].approver_employee_id;
  if (!aid) return { id: '', name: '', email: '' };
  const a = await empInfo(aid);
  return a ? { id: a.id, name: a.name, email: (a.email_pro || a.email_personal || '').trim() } : { id: '', name: '', email: '' };
}
async function loadTs(employeeId, ws) {
  const r = await q(`SELECT id, employee_id, to_char(week_start,'YYYY-MM-DD') AS ws, status, days, comment, approver_email, submitted_at, mail_status FROM hb_ts WHERE employee_id = $1 AND week_start = $2`, [String(employeeId), ws]);
  return r[0] ? tsOut(r[0]) : null;
}
function tsHtml(emp, ws, sheet, approverName) {
  const t = sheet.totals;
  const rows = Object.keys(sheet.days).sort().map((d, i) => { const x = sheet.days[d];
    return `<tr><td style="padding:4px 8px;border:1px solid #ddd">${DOW[i]} ${fmtDay(d)}</td><td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${x.worked.toFixed(2)}</td><td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${x.mobile ? x.mobile.toFixed(2) : '—'}</td><td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${x.paid.toFixed(2)}</td><td style="padding:4px 8px;border:1px solid #ddd">${esc(x.note)}</td></tr>`; }).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#17223b"><h2 style="margin:0 0 6px">Feuille de temps — ${esc(emp.name)}</h2>
    <p style="margin:0 0 10px">Semaine du ${fmtDay(ws)} au ${fmtDay(addDays(ws, 6))}${approverName ? ' · Responsable : ' + esc(approverName) : ''}</p>
    <table style="border-collapse:collapse;font-size:13px"><thead><tr style="background:#eef2fb"><th style="padding:4px 8px;border:1px solid #ddd;text-align:left">Jour</th><th style="padding:4px 8px;border:1px solid #ddd">Travaillées (h)</th><th style="padding:4px 8px;border:1px solid #ddd">Banque mobile (h)</th><th style="padding:4px 8px;border:1px solid #ddd">Payées (h)</th><th style="padding:4px 8px;border:1px solid #ddd;text-align:left">Note</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr style="font-weight:700;background:#f6f8fc"><td style="padding:4px 8px;border:1px solid #ddd">Total</td><td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${t.worked.toFixed(2)}</td><td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${t.mobile.toFixed(2)}</td><td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${t.paid.toFixed(2)}</td><td style="padding:4px 8px;border:1px solid #ddd">Mouvement banque de temps : ${t.bankDelta >= 0 ? '+' : ''}${t.bankDelta.toFixed(2)} h</td></tr></tfoot></table>
    ${sheet.comment ? `<p style="margin:12px 0 0"><b>Commentaires de l'employé :</b><br>${esc(sheet.comment).replace(/\n/g, '<br>')}</p>` : ''}</div>`;
}

const EMPLOYEE = {
  async myOverview(ctx) {
    const id = ctx.employeeId;
    const [cfg, bal, tx] = await Promise.all([
      q('SELECT timesheet FROM hb_cfg WHERE employee_id = $1', [id]),
      balancesFor([id]),
      q(`SELECT id, bank, kind, to_char(day,'YYYY-MM-DD') AS d, hours::float AS hours, note, created_by, created_at FROM hb_tx WHERE employee_id = $1 ORDER BY day DESC, id DESC LIMIT 200`, [id])]);
    return { timesheet: !!(cfg[0] && cfg[0].timesheet), balances: blank(bal[id]), transactions: tx.map(txOut), labels: BANK_LABEL, kinds: KIND_LABEL };
  },

  async tsGet(ctx, b) {
    const id = ctx.employeeId;
    const cfg = await q('SELECT timesheet FROM hb_cfg WHERE employee_id = $1', [id]);
    if (!(cfg[0] && cfg[0].timesheet)) fail(403, 'La feuille de temps n\'est pas activée pour votre compte.');
    const ws = sundayOf(b.weekStart || new Date().toISOString().slice(0, 10));
    const sheet = (await loadTs(id, ws)) || { id: '', employeeId: id, weekStart: ws, status: 'brouillon', days: cleanDays(ws, {}), comment: '', approverEmail: '', submittedAt: null, mailStatus: '', totals: tsTotals({}) };
    const appr = await approverOf(id);
    const bal = blank((await balancesFor([id]))[id]);
    return { sheet, balances: bal, approverName: appr.name, approverMissing: !appr.email };
  },

  async tsSave(ctx, b) {
    const id = ctx.employeeId;
    const cfg = await q('SELECT timesheet FROM hb_cfg WHERE employee_id = $1', [id]);
    if (!(cfg[0] && cfg[0].timesheet)) fail(403, 'La feuille de temps n\'est pas activée pour votre compte.');
    const ws = sundayOf(b.weekStart);
    const cur = await loadTs(id, ws);
    if (cur && cur.status === 'soumise') fail(409, 'Cette feuille a déjà été soumise. Demandez sa réouverture à un administrateur pour la corriger.');
    const days = cleanDays(ws, b.days), comment = String(b.comment || '').slice(0, 2000);
    const totals = tsTotals(days);
    const submit = !!b.submit;
    let appr = { id: '', name: '', email: '' };
    if (submit) {
      appr = await approverOf(id);
      if (!appr.email) fail(409, 'Aucun responsable (avec courriel) n\'est désigné pour votre feuille de temps. Contactez un administrateur.');
      if (totals.mobile > 0) {
        const avail = ((await balancesFor([id]))[id] || {}).mobile || 0;
        if (totals.mobile > avail + 0.001) fail(409, 'Banque d\'heures mobiles insuffisante : ' + avail.toFixed(2) + ' h disponibles, ' + totals.mobile.toFixed(2) + ' h demandées.');
      }
    }
    const r = await q(`INSERT INTO hb_ts (employee_id, week_start, status, days, comment, approver_email, submitted_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7, now())
      ON CONFLICT (employee_id, week_start) DO UPDATE SET status = EXCLUDED.status, days = EXCLUDED.days, comment = EXCLUDED.comment, approver_email = EXCLUDED.approver_email, submitted_at = EXCLUDED.submitted_at, updated_at = now() RETURNING id`,
      [id, ws, submit ? 'soumise' : 'brouillon', JSON.stringify(days), comment, submit ? appr.email : null, submit ? new Date().toISOString() : null]);
    const tsId = String(r[0].id);
    let mail = null;
    if (submit) {
      await setTx(id, 'bureau', 'ts:' + tsId + ':bureau', 'ts', ws, totals.bankDelta, 'Feuille de temps du ' + fmtDay(ws) + ' (travaillées ' + totals.worked.toFixed(2) + ' + mobiles ' + totals.mobile.toFixed(2) + ' − payées ' + totals.paid.toFixed(2) + ')', 'employé');
      await setTx(id, 'mobile', 'ts:' + tsId + ':mobile', 'ts', ws, -totals.mobile, 'Utilisation — feuille de temps du ' + fmtDay(ws), 'employé');
      const emp = await empInfo(id);
      const sheet = { days, comment, totals };
      mail = await sendMail(appr.email, 'Feuille de temps — ' + (emp ? emp.name : 'Employé') + ' (semaine du ' + fmtDay(ws) + ')', tsHtml(emp || { name: '?' }, ws, sheet, appr.name));
      await q('UPDATE hb_ts SET mail_status = $2 WHERE id = $1', [tsId, mail.ok ? 'envoye' : ('echec: ' + String(mail.error || '').slice(0, 150))]);
    }
    const out = await EMPLOYEE.tsGet(ctx, { weekStart: ws });
    out.mail = mail;
    return out;
  }
};

const ADMIN_READ = new Set(['weekGet', 'balances', 'txList', 'cfgList', 'tsList']);

/** role : 'admin' | 'lecture-seule' | 'employee'. ctx : { email, employeeId }. */
async function handle(role, action, body, ctx) {
  await ensure();
  if (role === 'employee') {
    if (!ctx.employeeId) fail(403, 'Compte employé invalide.');
    if (!['myOverview', 'tsGet', 'tsSave'].includes(action)) fail(403, 'Action non permise.');
    return await EMPLOYEE[action](ctx, body || {});
  }
  if (role !== 'admin' && role !== 'lecture-seule') fail(403, 'Accès réservé aux administrateurs.');
  const fn = ADMIN[action];
  if (!fn) fail(400, 'Action inconnue : ' + action);
  if (role === 'lecture-seule' && !ADMIN_READ.has(action)) fail(403, 'Accès en lecture seule : cette action est désactivée pour votre compte.');
  return await fn(body || {}, ctx || {});
}

module.exports = { handle, ensure, BANKS, sundayOf, tsTotals };
