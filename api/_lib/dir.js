'use strict';
// api/_lib/dir.js — annuaires Projets (Macro | PROJETS) et Employés hébergés dans Neon (fin_project, fin_employee).
// Remplace les lectures Monday de _lib/monday.js : mêmes formes de données (parseProject), pour que tous les modules continuent de fonctionner.

const { q } = require('./db');

const str = (v, n) => (v == null ? '' : String(v).trim().slice(0, n || 300));
const numOrNull = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
const dateOrNull = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const idArr = v => (Array.isArray(v) ? v : String(v || '').split(/[,\s]+/)).map(x => String(x).trim()).filter(x => /^\d+$/.test(x)).filter((x, i, a) => a.indexOf(x) === i);
const jsonObj = v => { if (v && typeof v === 'object' && !Array.isArray(v)) return v; try { const o = JSON.parse(String(v || '{}')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };

const SKILLS = ['charpente', 'syst_interieur', 'quincaillerie', 'revet_ext', 'coffrage_beton'];
const SKILL_VALUES = ['Très compétent', 'Expérience limitée', 'Aucune compétence', 'N/A', ''];
const PROJECT_STATUSES = ['En planification (Tâches administratives)', 'Projet en cours', 'Attente de libération', 'Projet général', 'Projet terminé', 'Indéterminé'];
const EMPLOYEE_STATUSES = ['Actif', 'Inactif', 'Terminé', 'Invalidité', 'Sous-Traitant', 'Nouveaux employés'];

// ---------- Disponibilité de la table (bascule automatique) -----------------------------------------------
let _on = { at: 0, v: false };
/** Vrai dès que fin_project contient au moins un projet : Exacto devient alors la source (sinon lecture de Monday). */
async function enabled() {
  if (process.env.DIRECTORY_SOURCE === 'monday') return false;
  if (Date.now() - _on.at < 30000) return _on.v;
  let v = false;
  try { v = ((await q('SELECT 1 FROM fin_project LIMIT 1'))[0]) ? true : false; } catch (e) { v = false; }
  _on = { at: Date.now(), v };
  return v;
}
function resetCache() { _on = { at: 0, v: false }; emp = { at: 0, map: null }; }

// ---------- Employés -------------------------------------------------------------------------------------------
const EMP_COLS = `id, monday_id, legacy, name, status, company, avantage_code, job_title, department, to_char(hire_date,'YYYY-MM-DD') AS hire_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
  email_pro, email_personal, phone, address, lat, lng, emergency_name, emergency_phone, notes, skills, punch_access, exclude_payroll, approver, prime_id, clerk_user_id, monday_group,
  to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at, updated_by`;
const empEmail = r => (r.email_pro || r.email_personal || '').trim();
function shapeEmployee(r) {
  let sk = r.skills; if (typeof sk === 'string') { try { sk = JSON.parse(sk); } catch (e) { sk = {}; } }
  return { id: String(r.id), mondayId: r.monday_id || null, legacy: !!r.legacy, name: r.name, status: r.status || '', company: r.company || '', avantageCode: r.avantage_code || '',
    jobTitle: r.job_title || '', department: r.department || '', hireDate: r.hire_date || null, endDate: r.end_date || null,
    emailPro: r.email_pro || '', emailPersonal: r.email_personal || '', email: empEmail(r), phone: r.phone || '', address: r.address || '',
    lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng), emergencyName: r.emergency_name || '', emergencyPhone: r.emergency_phone || '',
    notes: r.notes || '', skills: sk || {}, punchAccess: !!r.punch_access, excludePayroll: !!r.exclude_payroll, approver: !!r.approver, primeId: r.prime_id || '',
    clerkUserId: r.clerk_user_id || '', group: r.monday_group || '', updatedAt: r.updated_at || null, updatedBy: r.updated_by || '' };
}
let emp = { at: 0, map: null };
async function employeeMap(force) {
  if (!force && emp.map && Date.now() - emp.at < 30000) return emp.map;
  const rows = await q(`SELECT ${EMP_COLS} FROM fin_employee`);
  const m = new Map(); rows.forEach(r => m.set(String(r.id), shapeEmployee(r)));
  emp = { at: Date.now(), map: m };
  return m;
}
async function listEmployees() {
  const rows = await q(`SELECT ${EMP_COLS} FROM fin_employee ORDER BY lower(name)`);
  return rows.map(shapeEmployee);
}
async function getEmployee(id) {
  const r = (await q(`SELECT ${EMP_COLS} FROM fin_employee WHERE id = $1`, [String(id)]))[0];
  return r ? shapeEmployee(r) : null;
}
function cleanEmployee(b) {
  const o = {};
  o.name = str(b.name, 160); if (!o.name) throw { status: 400, message: "Le nom de l'employé est obligatoire." };
  o.status = str(b.status, 60); o.company = str(b.company, 60); o.avantage_code = str(b.avantageCode, 30);
  o.job_title = str(b.jobTitle, 80); o.department = str(b.department, 40);
  o.hire_date = dateOrNull(b.hireDate); o.end_date = dateOrNull(b.endDate);
  o.email_pro = str(b.emailPro, 200); o.email_personal = str(b.emailPersonal, 200);
  for (const k of ['email_pro', 'email_personal']) if (o[k] && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o[k])) throw { status: 400, message: 'Courriel invalide : ' + o[k] };
  o.phone = str(b.phone, 40); o.address = str(b.address, 300);
  o.lat = numOrNull(b.lat); o.lng = numOrNull(b.lng);
  o.emergency_name = str(b.emergencyName, 160); o.emergency_phone = str(b.emergencyPhone, 40); o.notes = str(b.notes, 2000);
  const sk = {}; const src = jsonObj(b.skills);
  SKILLS.forEach(k => { const v = str(src[k], 40); if (v && SKILL_VALUES.includes(v)) sk[k] = v; });
  o.skills = JSON.stringify(sk);
  o.punch_access = !!b.punchAccess; o.exclude_payroll = !!b.excludePayroll; o.approver = !!b.approver; o.prime_id = str(b.primeId, 40) || null;
  return o;
}
async function saveEmployee(b, userEmail) {
  const o = cleanEmployee(b);
  const cols = Object.keys(o);
  if (b.id) {
    if (!/^\d+$/.test(String(b.id))) throw { status: 400, message: 'Employé invalide.' };
    const sets = cols.map((k, i) => k + ' = $' + (i + 2) + (k === 'skills' ? '::jsonb' : '')).join(', ');
    const r = await q(`UPDATE fin_employee SET ${sets}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1 RETURNING id`, [String(b.id)].concat(cols.map(k => o[k]), [userEmail]));
    if (!r[0]) throw { status: 404, message: 'Employé introuvable.' };
    resetCache(); return r[0].id;
  }
  const ph = cols.map((k, i) => '$' + (i + 1) + (k === 'skills' ? '::jsonb' : '')).join(',');
  const r = await q(`INSERT INTO fin_employee (${cols.join(',')}, updated_by) VALUES (${ph}, $${cols.length + 1}) RETURNING id`, cols.map(k => o[k]).concat([userEmail]));
  resetCache(); return r[0].id;
}

// ---------- Projets --------------------------------------------------------------------------------------------
const PRJ_COLS = `id, monday_id, legacy, number, name, number_avantage, status, client, client_email, client_phone, owner_name, owner_address, owner_cadastre, owner_email,
  address, lat, lng, billing_type, cost_plus_pct, cost_plus_rate, billing_frequency, next_billing, max_po, insurance_pct, bond_pct, responsible_ids, responsible_text,
  cp_ids, cm_ids, coordo_ids, link, labor_required, planif_comment, labor_week, carpenters_required, carpenters_week, non_ccq_only, punch_radius_m, planif_start, planif_end,
  lift_equipment_ids, rolling_equipment_ids, monday_group, to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at, updated_by`;
const person = (map, id) => { const e = map.get(String(id)); return e ? { id: e.id, name: e.name, email: e.email, phone: e.phone } : null; };
const people = (map, ids) => (ids || []).map(i => person(map, i)).filter(Boolean);
const jv = v => { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return {}; } } return v || {}; };

/** Même forme que monday.parseProject() (+ champs Planif/Punch), pour que tous les modules fonctionnent sans changement. */
function shapeProject(r, map) {
  return {
    id: String(r.id), name: r.name, number: r.number, numberAvantage: r.number_avantage || '', status: r.status || '',
    owner: { name: r.owner_name || '', address: r.owner_address || '', cadastre: r.owner_cadastre || '', email: r.owner_email || '' },
    link: r.link || '', maxPo: Number(r.max_po) || 0, insurancePct: Number(r.insurance_pct) || 0, bondPct: Number(r.bond_pct) || 0,
    cp: people(map, r.cp_ids), cm: people(map, r.cm_ids), coordo: people(map, r.coordo_ids), responsible: people(map, r.responsible_ids),
    // champs additionnels (annuaire, Planif, Punch)
    ownerName: r.owner_name || '', ownerAddress: r.owner_address || '', ownerCadastre: r.owner_cadastre || '', ownerEmail: r.owner_email || '',
    mondayId: r.monday_id || null, legacy: !!r.legacy, client: r.client || '', clientEmail: r.client_email || '', clientPhone: r.client_phone || '',
    address: r.address || '', lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
    billingType: r.billing_type || '', costPlusPct: r.cost_plus_pct == null ? null : Number(r.cost_plus_pct), costPlusRate: r.cost_plus_rate == null ? null : Number(r.cost_plus_rate),
    billingFrequency: r.billing_frequency || '', nextBilling: r.next_billing || '', responsibleText: r.responsible_text || '',
    cpIds: r.cp_ids || [], cmIds: r.cm_ids || [], coordoIds: r.coordo_ids || [], responsibleIds: r.responsible_ids || [],
    laborRequired: r.labor_required || '', planifComment: r.planif_comment || '', laborWeek: jv(r.labor_week), carpentersRequired: r.carpenters_required == null ? null : Number(r.carpenters_required),
    carpentersWeek: jv(r.carpenters_week), nonCcqOnly: !!r.non_ccq_only, punchRadiusM: r.punch_radius_m == null ? null : Number(r.punch_radius_m),
    planifStart: r.planif_start || '', planifEnd: r.planif_end || '', liftEquipmentIds: r.lift_equipment_ids || [], rollingEquipmentIds: r.rolling_equipment_ids || [],
    group: r.monday_group || '', updatedAt: r.updated_at || null, updatedBy: r.updated_by || ''
  };
}
async function listProjects() {
  const map = await employeeMap();
  const rows = await q(`SELECT ${PRJ_COLS} FROM fin_project WHERE number <> '' ORDER BY number`);
  return rows.map(r => shapeProject(r, map));
}
async function getProject(id) {
  if (!/^\d+$/.test(String(id))) throw { status: 400, message: 'Projet invalide.' };
  const map = await employeeMap();
  const r = (await q(`SELECT ${PRJ_COLS} FROM fin_project WHERE id = $1`, [String(id)]))[0];
  if (!r) throw { status: 404, message: 'Projet introuvable.' };
  return shapeProject(r, map);
}
async function setMaxPo(projectId, seq) {
  try { await q('UPDATE fin_project SET max_po = GREATEST(max_po, $2), updated_at = now() WHERE id = $1', [String(projectId), Number(seq) || 0]); return true; }
  catch (e) { console.error('setMaxPo (Neon) a échoué:', e && e.message); return false; }
}
function cleanProject(b) {
  const o = {};
  o.number = str(b.number, 40); o.name = str(b.name, 200);
  if (!o.number) throw { status: 400, message: 'Le numéro de projet est obligatoire.' };
  if (!o.name) throw { status: 400, message: 'Le nom du projet est obligatoire.' };
  o.number_avantage = str(b.numberAvantage, 40); o.status = str(b.status, 80);
  o.client = str(b.client, 200); o.client_email = str(b.clientEmail, 200); o.client_phone = str(b.clientPhone, 40);
  o.owner_name = str(b.ownerName, 200); o.owner_address = str(b.ownerAddress, 300); o.owner_cadastre = str(b.ownerCadastre, 120); o.owner_email = str(b.ownerEmail, 200);
  o.address = str(b.address, 300); o.lat = numOrNull(b.lat); o.lng = numOrNull(b.lng);
  o.billing_type = str(b.billingType, 60); o.cost_plus_pct = numOrNull(b.costPlusPct); o.cost_plus_rate = numOrNull(b.costPlusRate);
  o.billing_frequency = str(b.billingFrequency, 60); o.next_billing = str(b.nextBilling, 40);
  o.insurance_pct = numOrNull(b.insurancePct) || 0; o.bond_pct = numOrNull(b.bondPct) || 0;
  if (b.responsibleIds !== undefined) o.responsible_ids = idArr(b.responsibleIds);
  o.cp_ids = idArr(b.cpIds); o.cm_ids = idArr(b.cmIds); o.coordo_ids = idArr(b.coordoIds);
  o.link = str(b.link, 500);
  o.labor_required = str(b.laborRequired, 20); o.planif_comment = str(b.planifComment, 2000);
  o.carpenters_required = numOrNull(b.carpentersRequired); o.non_ccq_only = !!b.nonCcqOnly;
  const rad = numOrNull(b.punchRadiusM); o.punch_radius_m = rad == null ? null : Math.max(0, Math.round(rad));
  o.planif_start = str(b.planifStart, 10); o.planif_end = str(b.planifEnd, 10);
  for (const k of ['client_email', 'owner_email']) if (o[k] && !/^[^@\s]+@[^@\s]+\.[^@\s]+/.test(o[k])) throw { status: 400, message: 'Courriel invalide : ' + o[k] };
  return o;
}
async function setProjectStatus(id, status) {
  if (!/^\d+$/.test(String(id))) throw { status: 400, message: 'Projet invalide.' };
  const s = String(status || '').trim().slice(0, 80);
  const r = await q('UPDATE fin_project SET status = $2, updated_at = now() WHERE id = $1 RETURNING id', [String(id), s]);
  if (!r[0]) throw { status: 404, message: 'Projet introuvable.' };
  resetCache(); return true;
}
async function deleteEmployee(id) {
  if (!/^\d+$/.test(String(id))) throw { status: 400, message: 'Employé invalide.' };
  id = String(id);
  for (const c of ['responsible_ids', 'cp_ids', 'cm_ids', 'coordo_ids']) await q(`UPDATE fin_project SET ${c} = array_remove(${c}, $1) WHERE $1 = ANY(${c})`, [id]);
  const r = await q('DELETE FROM fin_employee WHERE id = $1 RETURNING id', [id]);
  if (!r[0]) throw { status: 404, message: 'Employé introuvable.' };
  resetCache(); return true;
}
const ARR = new Set(['responsible_ids', 'cp_ids', 'cm_ids', 'coordo_ids']);
async function saveProject(b, userEmail) {
  const o = cleanProject(b);
  const dup = await q('SELECT id FROM fin_project WHERE lower(number) = lower($1) AND ($2::text IS NULL OR id <> $2)', [o.number, b.id ? String(b.id) : null]);
  if (dup[0]) throw { status: 409, message: 'Le numéro de projet ' + o.number + ' existe déjà.' };
  const cols = Object.keys(o);
  const cast = k => (ARR.has(k) ? '::text[]' : '');
  if (b.id) {
    if (!/^\d+$/.test(String(b.id))) throw { status: 400, message: 'Projet invalide.' };
    const sets = cols.map((k, i) => k + ' = $' + (i + 2) + cast(k)).join(', ');
    const r = await q(`UPDATE fin_project SET ${sets}, updated_at = now(), updated_by = $${cols.length + 2} WHERE id = $1 RETURNING id`, [String(b.id)].concat(cols.map(k => o[k]), [userEmail]));
    if (!r[0]) throw { status: 404, message: 'Projet introuvable.' };
    resetCache(); return r[0].id;
  }
  const ph = cols.map((k, i) => '$' + (i + 1) + cast(k)).join(',');
  const r = await q(`INSERT INTO fin_project (${cols.join(',')}, updated_by) VALUES (${ph}, $${cols.length + 1}) RETURNING id`, cols.map(k => o[k]).concat([userEmail]));
  resetCache(); return r[0].id;
}
/** Courriels des chargés de projet / contremaîtres / coordonnateurs d'un employé (autorisations) — via fin_project. */

module.exports = { enabled, resetCache, employeeMap, listEmployees, getEmployee, saveEmployee, deleteEmployee, setProjectStatus, shapeEmployee, listProjects, getProject, saveProject, setMaxPo, shapeProject,
  SKILLS, SKILL_VALUES, PROJECT_STATUSES, EMPLOYEE_STATUSES, cleanEmployee, cleanProject };
