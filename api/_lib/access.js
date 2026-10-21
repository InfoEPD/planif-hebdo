// api/_lib/access.js — Accès par module (Planif / Admin Punch), géré dans Finance → Configuration → Accès aux modules.
// Lit la table fin_module_access de la base Finance (FINANCE_DATABASE_URL). En cas de panne de la base ou
// d'entrée non définie (hors mode strict), l'ancien système (rôle Clerk admin / lecture-seule) s'applique : aucun verrouillage accidentel.
const { neon } = require('@neondatabase/serverless');
const { createClerkClient } = require('@clerk/backend');

let _sql = null;
async function q(text, params) {
  const cs = process.env.FINANCE_DATABASE_URL || process.env.DATABASE_URL;
  if (!cs) throw new Error('base non configurée');
  if (!_sql) _sql = neon(cs);
  const rows = typeof _sql.query === 'function' ? await _sql.query(text, params || []) : await _sql(text, params || []);
  return Array.isArray(rows) ? rows : (rows && rows.rows) || [];
}
const emailCache = new Map();
async function emailOf(claims) {
  if (claims.email) return String(claims.email).toLowerCase();
  const id = claims.sub; if (!id) return '';
  const c = emailCache.get(id); if (c && Date.now() - c.at < 600000) return c.email;
  let email = '';
  try {
    const u = await createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY }).users.getUser(id);
    const p = (u.emailAddresses || []).find(e => e.id === u.primaryEmailAddressId) || (u.emailAddresses || [])[0];
    email = ((p && p.emailAddress) || '').toLowerCase();
  } catch (e) { email = ''; }
  emailCache.set(id, { at: Date.now(), email });
  return email;
}
const legacy = claims => (claims && claims.role === 'lecture-seule' ? 'read' : 'full');
const cache = new Map();

/** module : 'planif' | 'punch_admin'. Retourne 'none' | 'read' | 'full'. */
async function level(claims, module) {
  const role = claims && claims.role;
  if (role === 'employee' || role === 'employee_disabled') return 'none';
  const email = await emailOf(claims || {});
  const key = email + '|' + module;
  const hit = cache.get(key); if (hit && Date.now() - hit.at < 15000) return hit.v;
  let v;
  try {
    const col = module === 'planif' ? 'planif' : 'punch_admin';
    const env = String(process.env.FINANCE_ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
    let strict = false, admins = env, row = null;
    try {
      const s = await q("SELECT key, value FROM fin_settings WHERE key IN ('module_access_strict','admin_emails')");
      s.forEach(r => { if (r.key === 'module_access_strict') strict = r.value === '1'; if (r.key === 'admin_emails') admins = admins.concat(String(r.value || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)); });
      if (email) row = (await q('SELECT planif, punch_admin FROM fin_module_access WHERE email = $1', [email]))[0] || null;
    } catch (e) { row = null; strict = false; }   // table absente : ancien système
    if (email && admins.includes(email)) v = 'full';
    else if (row && ['none', 'read', 'full'].includes(row[col])) v = row[col];
    else v = strict ? 'none' : legacy(claims);
  } catch (e) { v = legacy(claims); }
  cache.set(key, { at: Date.now(), v });
  return v;
}

/** Administrateur principal : courriel dans FINANCE_ADMIN_EMAILS ou dans fin_settings.admin_emails (voit tout, y compris les employés de bureau). */
async function isSuper(claims) {
  const email = await emailOf(claims || {});
  if (!email) return false;
  let admins = String(process.env.FINANCE_ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  try {
    const s = await q("SELECT value FROM fin_settings WHERE key = 'admin_emails'");
    s.forEach(r => { admins = admins.concat(String(r.value || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)); });
  } catch (e) { /* table absente */ }
  return admins.includes(email);
}
module.exports = { level, emailOf, isSuper };
