// api/_lib/modaccess.js — Accès par module (Planif, Admin Punch, Finance), gérés dans Finance → Configuration.
// Table fin_module_access : planif / punch_admin = NULL (non défini) | none | read | full.
// Lue aussi par le projet EPD (www.exactoapp.ca) via la même base.
const { q } = require('./db');
const auth = require('./auth');
const inv = require('./invoice');
const LVL = ['none', 'read', 'full'];
const FIN = ['user', 'accounting', 'admin'];
const emailOk = e => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e);
const norm = v => (LVL.includes(v) ? v : null);
let _ready = null;
function ensure() {
  if (!_ready) _ready = q(`CREATE TABLE IF NOT EXISTS fin_module_access (email TEXT PRIMARY KEY, name TEXT, planif TEXT, punch_admin TEXT, updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`).catch(e => { _ready = null; throw e; });
  return _ready;
}
async function getSetting(k) { try { const r = await q('SELECT value FROM fin_settings WHERE key = $1', [k]); return r[0] ? r[0].value : null; } catch (e) { return null; } }
async function setSetting(k, v, by) {
  await q(`INSERT INTO fin_settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, v, by]);
}

async function get(user) {
  await ensure();
  auth.resetAdminCache();
  const rows = await q('SELECT email, name, planif, punch_admin FROM fin_module_access ORDER BY lower(email)');
  const admins = await auth.dbAdminEmails(), env = auth.adminEmails(), acct = await inv.accountingEmails();
  const m = new Map();
  const add = (email, extra) => { const e = String(email).toLowerCase(); if (!m.has(e)) m.set(e, { email: e, name: '', planif: null, punch: null, finance: 'user', locked: false }); Object.assign(m.get(e), extra || {}); };
  rows.forEach(r => add(r.email, { name: r.name || '', planif: r.planif, punch: r.punch_admin }));
  acct.forEach(e => add(e, { finance: 'accounting' }));
  admins.forEach(e => add(e, { finance: 'admin' }));
  env.forEach(e => add(e, { finance: 'admin', locked: true }));
  return { rows: Array.from(m.values()).sort((a, b) => a.email.localeCompare(b.email)), strict: (await getSetting('module_access_strict')) === '1', me: user.email };
}

async function save(user, b) {
  await ensure();
  const list = Array.isArray(b.rows) ? b.rows : [];
  const seen = new Set(), clean = [];
  for (const r of list) {
    const email = String(r.email || '').trim().toLowerCase(); if (!email) continue;
    if (!emailOk(email)) throw { status: 400, message: 'Courriel invalide : ' + email };
    if (seen.has(email)) continue; seen.add(email);
    clean.push({ email, name: String(r.name || '').trim().slice(0, 120) || null, planif: norm(r.planif), punch: norm(r.punch), finance: FIN.includes(r.finance) ? r.finance : 'user' });
  }
  const envA = auth.adminEmails();
  const admins = clean.filter(r => r.finance === 'admin').map(r => r.email).filter(e => !envA.includes(e));
  if (!envA.includes(user.email) && !clean.some(r => r.email === user.email && r.finance === 'admin')) throw { status: 400, message: 'Vous ne pouvez pas vous retirer vous-même des administrateurs.' };
  const accounting = clean.filter(r => r.finance === 'accounting').map(r => r.email);
  if (!accounting.length && !clean.some(r => r.finance === 'admin')) throw { status: 400, message: 'Indiquez au moins une personne en comptabilité.' };
  await setSetting('admin_emails', admins.join(','), user.email);
  await setSetting('accounting_emails', accounting.join(','), user.email);
  await setSetting('module_access_strict', b.strict ? '1' : '0', user.email);
  const keep = clean.map(r => r.email);
  await q('DELETE FROM fin_module_access WHERE NOT (email = ANY($1::text[]))', [keep.length ? keep : ['']]);
  for (const r of clean) {
    await q(`INSERT INTO fin_module_access (email, name, planif, punch_admin, updated_by) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, planif = EXCLUDED.planif, punch_admin = EXCLUDED.punch_admin, updated_by = EXCLUDED.updated_by, updated_at = now()`, [r.email, r.name, r.planif, r.punch, user.email]);
  }
  auth.resetAdminCache();
  return { ok: true };
}

function clerk() {
  const { createClerkClient } = require('@clerk/backend');
  if (!process.env.CLERK_SECRET_KEY) throw { status: 500, message: 'CLERK_SECRET_KEY manquant.' };
  return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
}
const primary = u => { const e = (u.emailAddresses || []).find(x => x.id === u.primaryEmailAddressId) || (u.emailAddresses || [])[0]; return ((e && e.emailAddress) || '').toLowerCase(); };

/** Propose les comptes de connexion existants (hors employés Punch) avec les droits actuels (admin / lecture-seule). Ne sauvegarde pas. */
async function importClerk() {
  const c = clerk();
  const res = await c.users.getUserList({ limit: 200 });
  const arr = Array.isArray(res) ? res : (res.data || []);
  const out = [];
  for (const u of arr) {
    const role = u.publicMetadata && u.publicMetadata.role;
    if (role === 'employee' || role === 'employee_disabled') continue;
    const email = primary(u); if (!email) continue;
    const lvl = role === 'lecture-seule' ? 'read' : 'full';
    out.push({ email, name: [u.firstName, u.lastName].filter(Boolean).join(' '), planif: lvl, punch: lvl, finance: 'user' });
  }
  return { users: out };
}

/** Crée le compte de connexion (courriel + mot de passe) d'une nouvelle personne. */
async function createLogin(user, b) {
  const email = String(b.email || '').trim().toLowerCase();
  if (!emailOk(email)) throw { status: 400, message: 'Courriel invalide.' };
  const password = String(b.password || ''); if (password.length < 10) throw { status: 400, message: 'Mot de passe : 10 caractères minimum.' };
  const parts = String(b.name || '').trim().split(/\s+/);
  try {
    await clerk().users.createUser({ emailAddress: [email], password, firstName: parts[0] || undefined, lastName: parts.slice(1).join(' ') || undefined });
  } catch (e) {
    const msg = (e && e.errors && e.errors[0] && (e.errors[0].longMessage || e.errors[0].message)) || e.message || 'Erreur Clerk';
    throw { status: 400, message: 'Création du compte impossible : ' + msg };
  }
  return { ok: true };
}
module.exports = { get, save, importClerk, createLogin, ensure };
