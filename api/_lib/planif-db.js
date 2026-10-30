// api/_lib/planif-db.js
//
// Données de Planif hébergées dans Neon (remplace les tableau « Planification chantier », fériés, réglages,
// distances, équipements, absences, historique des changements et historique des horaires envoyés).
// Employés et projets proviennent des annuaires Exacto (fin_employee / fin_project — créés par le projet Finance, MÊME base Neon).
// Les identifiants d'employés et de projets sont ceux de l’ancien système (texte numérique) : rien ne change pour les autres modules.
//
// Appelé par api/monday.js (corps { planif: '<action>', ... }) — aucune nouvelle fonction Vercel n'est créée.

const { neon } = require('@neondatabase/serverless');

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  // Les annuaires (fin_employee / fin_project) et les tables planif_* vivent dans la base du projet Finance :
  // FINANCE_DATABASE_URL = l'URL de connexion de cette base. Les tables propres à Punch/multi-entreprise restent dans DATABASE_URL.
  const cs = process.env.FINANCE_DATABASE_URL || process.env.DATABASE_URL;
  if (!cs) throw new Error("FINANCE_DATABASE_URL n'est pas configuré sur le serveur (base Neon du projet Finance).");
  _sql = neon(cs);
  return _sql;
}
async function q(text, params) {
  const s = getSql();
  const rows = typeof s.query === 'function' ? await s.query(text, params || []) : await s(text, params || []);
  return Array.isArray(rows) ? rows : (rows && rows.rows) || [];
}

const LABOR_ACTIVE_LABEL = 'Active';
const LABOR_INACTIVE_LABEL = "Inactive (M.O. terminée)";
const PLANNING_STAGES = ['Projet en cours', 'Projet terminé', 'Attente de libération', 'En planification (Tâches administratives)'];
const SKILL_KEYS = { charpente: 'charpente', interieur: 'syst_interieur', quincaillerie: 'quincaillerie', exterieur: 'revet_ext', coffrage: 'coffrage_beton' };
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isId = s => /^\d+$/.test(String(s || ''));
const fail = (status, message) => { throw { status, message }; };
const jobj = v => { if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return {}; } } return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
const dstr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

// ----- Lecture --------------------------------------------------------------------------------------------------
const EMP_SQL = `SELECT id, name, job_title, to_char(end_date,'YYYY-MM-DD') AS end_date, email_pro, email_personal, phone, address, lat, lng, skills, status, department, company FROM fin_employee`;
const classifyTitre = t => t || 'Autre';
function shapeEmp(r) {
  const sk = jobj(r.skills), competencies = {};
  Object.keys(SKILL_KEYS).forEach(k => { competencies[k] = sk[SKILL_KEYS[k]] || ''; });
  return { id: String(r.id), name: r.name, titre: classifyTitre(r.job_title), endDate: r.end_date || null, emailPro: r.email_pro || '', emailPerso: r.email_personal || '', phone: r.phone || '', competencies };
}
function parseComments(raw) {
  if (!raw) return {};
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : { __default__: raw }; } catch (e) { return { __default__: raw }; }
}

async function load() {
  const [emps, projs, cells, abs, hol, sets, dist, equip] = await Promise.all([
    q(EMP_SQL), 
    q(`SELECT id, name, number, status, address, lat, lng, labor_required, labor_week, planif_comment, carpenters_required, carpenters_week, planif_start, planif_end, responsible_ids, responsible_text, cp_ids, cm_ids
       FROM fin_project WHERE status = ANY($1::text[])`, [PLANNING_STAGES]),
    q(`SELECT id, project_id, to_char(day,'YYYY-MM-DD') AS day, employee_ids, assigned_at, created_at FROM planif_cell`),
    q(`SELECT employee_id, to_char(start_day,'YYYY-MM-DD') AS s, to_char(end_day,'YYYY-MM-DD') AS e FROM planif_absence`),
    q(`SELECT to_char(day,'YYYY-MM-DD') AS day FROM planif_holiday`),
    q(`SELECT key, value FROM planif_setting`),
    q(`SELECT employee_id, data, to_char(computed_on,'YYYY-MM-DD') AS d FROM planif_distance`),
    q(`SELECT kind, active, brand, model, year, name, employee_ids FROM planif_equipment WHERE active`)
  ]);
  const byId = new Map(emps.map(r => [String(r.id), r]));
  const isEPD = r => /^epd$/i.test(String(r.company || '').trim());
  const chantier = r => /^chantier$/i.test(String(r.department || '').trim());       // Planif : SEULEMENT le département Chantier
  const sel = st => emps.filter(r => isEPD(r) && chantier(r) && String(r.status || '').trim().toLowerCase() === st).map(shapeEmp).sort((a, b) => a.name.localeCompare(b.name));
  const employees = sel('actif'), inactiveEmployees = sel('inactif');

  const nm = ids => (ids || []).map(i => byId.get(String(i))).filter(Boolean).map(r => r.name);
  const projects = projs.map(r => {
    const people = nm(r.cp_ids);   // Chargé(s) de projet uniquement (le champ Responsable est masqué)
    return {
      id: String(r.id), name: r.name, numero: r.number || '', responsable: people.join(', '), charge: (people[0] || '').trim(),
      contremaitre: nm(r.cm_ids).join(', '), adresse: r.address || '', etape: r.status || '',
      laborActive: (r.labor_required || '') !== LABOR_INACTIVE_LABEL, requiredCountDefault: Number(r.carpenters_required) || 0,
      requiredByWeek: jobj(r.carpenters_week), laborByWeek: jobj(r.labor_week), commentsByWeek: parseComments(r.planif_comment),
      heureDebut: String(r.planif_start || '').trim(), heureFin: String(r.planif_end || '').trim()
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const projectCoords = {}, projectAddresses = {}, employeeCoords = {}, employeeAddresses = {};
  projs.forEach(r => { if (r.address) projectAddresses[String(r.id)] = r.address; if (r.lat != null && r.lng != null) projectCoords[String(r.id)] = { lat: Number(r.lat), lng: Number(r.lng) }; });
  employees.concat(inactiveEmployees).forEach(e => {
    const r = byId.get(e.id); if (!r) return;
    if (r.address) employeeAddresses[e.id] = r.address;
    if (r.lat != null && r.lng != null) employeeCoords[e.id] = { lat: Number(r.lat), lng: Number(r.lng) };
  });

  const cellMap = {};
  cells.forEach(c => {
    const ids = c.employee_ids || [];
    cellMap[`${c.project_id}|${c.day}`] = {
      itemId: String(c.id), createdAt: c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at || ''), assignedAt: jobj(c.assigned_at),
      employees: ids.map(id => ({ id: String(id), name: (byId.get(String(id)) || {}).name || '?' }))
    };
  });

  const absences = {};
  abs.forEach(a => { (absences[String(a.employee_id)] = absences[String(a.employee_id)] || []).push({ start: a.s, end: a.e }); });
  const holidays = {}; hol.forEach(h => { holidays[h.day] = h.day; });

  const sm = {}; sets.forEach(s => { sm[s.key] = s.value; });
  const settings = { startDefault: sm.startDefault || '07:00', endDefault: sm.endDefault || '15:30', showWeekend: sm.showWeekend === '1' };

  const roadDistances = {}; let roadDistancesDate = null;
  dist.forEach(d => { roadDistances[String(d.employee_id)] = jobj(d.data); if (d.d && (!roadDistancesDate || d.d > roadDistancesDate)) roadDistancesDate = d.d; });

  const equipmentByEmployee = {}, liftByEmployee = {}, liftMarquesByEmployee = {};
  equip.forEach(e => {
    (e.employee_ids || []).forEach(id => {
      if (e.kind === 'rolling') equipmentByEmployee[id] = (equipmentByEmployee[id] || 0) + 1;
      else {
        liftByEmployee[id] = (liftByEmployee[id] || 0) + 1;
        const label = (([e.brand, e.model].filter(Boolean).join(' ')) + (e.year ? ` (${e.year})` : '')).trim() || e.name || 'Équipement de levage';
        (liftMarquesByEmployee[id] = liftMarquesByEmployee[id] || []).push(label);
      }
    });
  });

  return { employees, inactiveEmployees, projects, cells: cellMap, absences, holidays, settings, projectCoords, projectAddresses, employeeCoords, employeeAddresses,
    roadDistances, roadDistancesDate, equipmentByEmployee, liftByEmployee, liftMarquesByEmployee };
}

// ----- Écritures : cases ----------------------------------------------------------------------------------------
const idArr = a => (Array.isArray(a) ? a : []).map(String).filter(isId).filter((x, i, arr) => arr.indexOf(x) === i);
async function cellCreate(b) {
  if (!isId(b.projectId) || !isDay(b.date)) fail(400, 'Case invalide.');
  const r = await q(`INSERT INTO planif_cell (project_id, day, employee_ids, assigned_at) VALUES ($1,$2,$3::text[],$4::jsonb)
    ON CONFLICT (project_id, day) DO UPDATE SET employee_ids = (SELECT array(SELECT DISTINCT unnest(planif_cell.employee_ids || EXCLUDED.employee_ids))), assigned_at = planif_cell.assigned_at || EXCLUDED.assigned_at, updated_at = now()
    RETURNING id`, [String(b.projectId), b.date, idArr(b.employeeIds), JSON.stringify(jobj(b.assignedAt))]);
  return { id: String(r[0].id) };
}
async function cellUpdate(b) {
  if (!isId(b.id)) fail(400, 'Case invalide.');
  const r = await q('UPDATE planif_cell SET employee_ids = $2::text[], assigned_at = COALESCE($3::jsonb, assigned_at), updated_at = now() WHERE id = $1 RETURNING id',
    [b.id, idArr(b.employeeIds), b.assignedAt ? JSON.stringify(jobj(b.assignedAt)) : null]);
  if (!r[0]) fail(404, 'Case introuvable.');
  return { ok: true };
}
async function cellAssignedAt(b) {
  if (!isId(b.id)) fail(400, 'Case invalide.');
  await q('UPDATE planif_cell SET assigned_at = $2::jsonb, updated_at = now() WHERE id = $1', [b.id, JSON.stringify(jobj(b.assignedAt))]);
  return { ok: true };
}
async function cellDelete(b) {
  if (!isId(b.id)) fail(400, 'Case invalide.');
  await q('DELETE FROM planif_cell WHERE id = $1', [b.id]);
  return { ok: true };
}

// ----- Écritures : projets (champs de planification seulement) --------------------------------------------------
async function projectWeekSet(b) {
  if (!isId(b.id) || !isDay(b.weekKey)) fail(400, 'Projet ou semaine invalide.');
  if (b.kind === 'labor') {
    await q(`UPDATE fin_project SET labor_week = COALESCE(labor_week, '{}'::jsonb) || jsonb_build_object($2::text, $3::boolean), updated_at = now() WHERE id = $1`, [b.id, b.weekKey, !!b.value]);
  } else if (b.kind === 'required') {
    const n = Math.max(0, Math.round(Number(b.value) || 0));
    await q(`UPDATE fin_project SET carpenters_week = COALESCE(carpenters_week, '{}'::jsonb) || jsonb_build_object($2::text, $3::int), updated_at = now() WHERE id = $1`, [b.id, b.weekKey, n]);
  } else if (b.kind === 'comment') {
    const cur = (await q('SELECT planif_comment FROM fin_project WHERE id = $1', [b.id]))[0];
    if (!cur) fail(404, 'Projet introuvable.');
    const map = parseComments(cur.planif_comment); map[b.weekKey] = String(b.value || '').slice(0, 2000);
    await q('UPDATE fin_project SET planif_comment = $2, updated_at = now() WHERE id = $1', [b.id, JSON.stringify(map)]);
  } else fail(400, 'Type de champ inconnu.');
  return { ok: true };
}
async function projectLabor(b) {
  if (!isId(b.id)) fail(400, 'Projet invalide.');
  await q('UPDATE fin_project SET labor_required = $2, updated_at = now() WHERE id = $1', [b.id, b.active ? LABOR_ACTIVE_LABEL : LABOR_INACTIVE_LABEL]);
  return { ok: true };
}
async function projectHours(b) {
  if (!isId(b.id)) fail(400, 'Projet invalide.');
  const v = String(b.value || '').trim();
  if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail(400, "Format d'heure invalide (HH:MM).");
  await q(`UPDATE fin_project SET ${b.field === 'end' ? 'planif_end' : 'planif_start'} = $2, updated_at = now() WHERE id = $1`, [b.id, v]);
  return { ok: true };
}

// ----- Fériés, réglages, absences, historiques -----------------------------------------------------------------
async function holidaySet(b) {
  if (!isDay(b.date)) fail(400, 'Date invalide.');
  if (b.on) await q('INSERT INTO planif_holiday (day) VALUES ($1) ON CONFLICT (day) DO NOTHING', [b.date]);
  else await q('DELETE FROM planif_holiday WHERE day = $1', [b.date]);
  return { ok: true };
}
async function settingsSave(b) {
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hm.test(String(b.startDefault || '')) || !hm.test(String(b.endDefault || ''))) fail(400, 'Heures invalides (HH:MM).');
  const rows = [['startDefault', b.startDefault], ['endDefault', b.endDefault], ['showWeekend', b.showWeekend ? '1' : '0']];
  for (const [k, v] of rows) await q('INSERT INTO planif_setting (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
  return { ok: true };
}
const EQ_COLS = `id, kind, name, active, status, brand, model, year, serial, department, ownership, to_char(end_date,'YYYY-MM-DD') AS end_date, km::float AS km, to_char(purchase_date,'YYYY-MM-DD') AS purchase_date, hours_at_purchase::float AS hours_at_purchase, notes, employee_ids`;
const eqOut = e => ({ id: String(e.id), kind: e.kind === 'rolling' ? 'rolling' : 'lift', name: e.name || '', active: !!e.active, status: e.status || (e.active ? 'actif' : 'inactif'), brand: e.brand || '', model: e.model || '', year: e.year || '',
  serial: e.serial || '', department: e.department || '', ownership: e.ownership || '', endDate: e.end_date || '', km: e.km == null ? '' : e.km, purchaseDate: e.purchase_date || '', hoursAtPurchase: e.hours_at_purchase == null ? '' : e.hours_at_purchase, notes: e.notes || '', employeeIds: (e.employee_ids || []).map(String) });
let eqReady = null;
function ensureEq() {
  if (!eqReady) eqReady = (async () => {
    for (const c of ['serial TEXT', 'department TEXT', 'ownership TEXT', 'end_date DATE', 'km NUMERIC', 'purchase_date DATE', 'hours_at_purchase NUMERIC', "status TEXT NOT NULL DEFAULT 'actif'", 'notes TEXT'])
      await q('ALTER TABLE planif_equipment ADD COLUMN IF NOT EXISTS ' + c);
  })().catch(e => { eqReady = null; throw e; });
  return eqReady;
}
async function equipList() {
  await ensureEq();
  const rows = await q(`SELECT ${EQ_COLS} FROM planif_equipment ORDER BY kind, active DESC, name`);
  return { equipment: rows.map(eqOut) };
}
async function equipAssign(b, ctx) {
  if (!isId(b.id)) fail(400, 'Équipement invalide.');
  const ids = (Array.isArray(b.employeeIds) ? b.employeeIds : []).map(String);
  if (ids.some(x => !isId(x))) fail(400, 'Employé invalide.');
  const r = await q('UPDATE planif_equipment SET employee_ids = $2::text[] WHERE id = $1 RETURNING id', [b.id, ids]);
  if (!r.length) fail(404, 'Équipement introuvable.');
  console.log('Équipement', b.id, 'réaffecté à', ids.join(',') || '(personne)', 'par', ctx && ctx.email);
  return { ok: true };
}
/** Ajoute (sans id) ou modifie (avec id) un camion / appareil de levage. */
async function equipSave(b, ctx) {
  await ensureEq();
  const kind = b.kind === 'rolling' ? 'rolling' : (b.kind === 'lift' ? 'lift' : '');
  if (!kind) fail(400, "Choisissez le type (camion ou appareil de levage).");
  const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const name = t(b.name, 200); if (!name) fail(400, 'Le nom est obligatoire.');
  const status = b.status === 'vendu' ? 'vendu' : 'actif';
  const day = v => (isDay(v) ? v : null);
  const nm = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); if (!isFinite(n)) fail(400, 'Nombre invalide.'); return n; };
  const emp = b.employeeId ? String(b.employeeId) : '';
  if (emp && !isId(emp)) fail(400, 'Employé invalide.');
  const ids = emp ? [emp] : (Array.isArray(b.employeeIds) ? b.employeeIds.map(String).filter(isId) : []);
  const vals = [kind, name, status === 'actif', t(b.brand, 100), t(b.model, 100), t(b.year, 10), ids, t(b.serial, 60), t(b.department, 30), t(b.ownership, 40), day(b.endDate), nm(b.km), day(b.purchaseDate), nm(b.hoursAtPurchase), status, t(b.notes, 500)];
  if (b.id) {
    if (!isId(b.id)) fail(400, 'Équipement invalide.');
    const r = await q(`UPDATE planif_equipment SET kind=$2, name=$3, active=$4, brand=$5, model=$6, year=$7, employee_ids=$8::text[], serial=$9, department=$10, ownership=$11, end_date=$12, km=$13, purchase_date=$14, hours_at_purchase=$15, status=$16, notes=$17 WHERE id=$1 RETURNING id`, [b.id].concat(vals));
    if (!r.length) fail(404, 'Équipement introuvable.');
    return { id: String(r[0].id) };
  }
  const r = await q(`INSERT INTO planif_equipment (kind, name, active, brand, model, year, employee_ids, serial, department, ownership, end_date, km, purchase_date, hours_at_purchase, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, vals);
  console.log('Équipement ajouté', r[0].id, name, 'par', ctx && ctx.email);
  return { id: String(r[0].id) };
}
async function equipDelete(b, ctx) {
  if (!isId(b.id)) fail(400, 'Équipement invalide.');
  const r = await q('DELETE FROM planif_equipment WHERE id = $1 RETURNING name', [b.id]);
  if (!r.length) fail(404, 'Équipement introuvable.');
  console.log('Équipement retiré', b.id, r[0].name, 'par', ctx && ctx.email);
  return { ok: true };
}
async function absenceSave(b, ctx) {
  if (!isId(b.employeeId) || !isDay(b.start) || !isDay(b.end) || b.end < b.start) fail(400, 'Absence invalide (employé, dates).');
  const r = await q('INSERT INTO planif_absence (employee_id, start_day, end_day, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [b.employeeId, b.start, b.end, String(b.note || '').slice(0, 200), ctx.email || '']);
  return { id: String(r[0].id) };
}
async function absenceList() {
  const rows = await q(`SELECT a.id, a.employee_id, to_char(a.start_day,'YYYY-MM-DD') AS s, to_char(a.end_day,'YYYY-MM-DD') AS e, a.note, e.name FROM planif_absence a LEFT JOIN fin_employee e ON e.id = a.employee_id
    WHERE a.end_day >= current_date - 30 ORDER BY a.start_day`);
  return { absences: rows.map(r => ({ id: String(r.id), employeeId: String(r.employee_id), name: r.name || '?', start: r.s, end: r.e, note: r.note || '' })) };
}
async function absenceDelete(b) { if (!isId(b.id)) fail(400, 'Absence invalide.'); await q('DELETE FROM planif_absence WHERE id = $1', [b.id]); return { ok: true }; }
async function historyAdd(b) {
  await q('INSERT INTO planif_history (week_key, description, user_label, diff) VALUES ($1,$2,$3,$4::jsonb)',
    [String(b.weekKey || '').slice(0, 20), String(b.description || '').slice(0, 4000), String(b.user || '').slice(0, 120), JSON.stringify(jobj(b.diff))]);
  return { ok: true };
}
async function historyList(b) {
  const rows = await q('SELECT id, description, user_label, diff, created_at FROM planif_history WHERE week_key = $1 ORDER BY created_at DESC LIMIT 200', [String(b.weekKey || '')]);
  return { items: rows.map(r => ({ id: String(r.id), description: r.description || '', user: r.user_label || '', diff: jobj(r.diff), created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) })) };
}
async function sendRecordGet(b) {
  const r = (await q("SELECT payload, to_char(sent_date,'YYYY-MM-DD') AS sent_date, corrupted FROM planif_send_log WHERE week_key = $1", [String(b.weekKey || '')]))[0];
  return { record: r ? { payload: r.payload || '', sentDate: r.sent_date || null, corrupted: !!r.corrupted } : null };
}
async function sendRecordSave(b) {
  if (!isDay(b.weekKey)) fail(400, 'Semaine invalide.');
  const payload = String(b.payload || '');
  if (payload.length > 400000) fail(400, "L'horaire de cette semaine est trop volumineux pour être enregistré.");
  await q(`INSERT INTO planif_send_log (week_key, payload, sent_date, corrupted) VALUES ($1,$2,current_date,false)
    ON CONFLICT (week_key) DO UPDATE SET payload = EXCLUDED.payload, sent_date = current_date, corrupted = false`, [b.weekKey, payload]);
  return { ok: true };
}
async function draftCandidates() {
  const rows = await q(`SELECT id, name, job_title, email_pro, email_personal FROM fin_employee WHERE lower(trim(coalesce(company,''))) = 'epd' AND lower(trim(coalesce(status,''))) = 'actif' ORDER BY name`);
  return { people: rows.map(r => ({ id: String(r.id), name: r.name, titre: r.job_title || 'Autre', emailPro: r.email_pro || '', emailPerso: r.email_personal || '' })) };
}

// ----- Distances routières (OSRM public) ------------------------------------------------------------------------
async function distancesRefresh(b) {
  const lock = (await q("SELECT value FROM planif_setting WHERE key = 'dist_lock'"))[0];
  if (lock && Date.now() - Number(lock.value) < 5 * 60 * 1000 && !b.force) return { skipped: 'déjà en cours' };
  await q("INSERT INTO planif_setting (key, value) VALUES ('dist_lock', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(Date.now())]);
  const emps = (await q(`SELECT id, lat, lng FROM fin_employee WHERE lower(trim(coalesce(company,''))) = 'epd' AND lower(trim(coalesce(department,''))) = 'chantier'
    AND lower(trim(coalesce(status,''))) IN ('actif','inactif') AND lat IS NOT NULL AND lng IS NOT NULL`));
  const projs = (await q(`SELECT id, lat, lng FROM fin_project WHERE status = ANY($1::text[]) AND lat IS NOT NULL AND lng IS NOT NULL`, [PLANNING_STAGES]));
  const result = {}; emps.forEach(e => { result[String(e.id)] = {}; });
  const SRC = 10, DST = 80, base = 'https://router.project-osrm.org/table/v1/driving/';
  const t0 = Date.now();
  for (let i = 0; i < emps.length; i += SRC) {
    const es = emps.slice(i, i + SRC);
    for (let j = 0; j < projs.length; j += DST) {
      if (Date.now() - t0 > 50000) { await q("DELETE FROM planif_setting WHERE key = 'dist_lock'"); return { partial: true, employees: Object.keys(result).length }; }
      const ps = projs.slice(j, j + DST);
      const coords = es.concat(ps).map(x => `${Number(x.lng)},${Number(x.lat)}`).join(';');
      const src = es.map((_, k) => k).join(';'), dst = ps.map((_, k) => es.length + k).join(';');
      const res = await fetch(`${base}${coords}?annotations=distance&sources=${src}&destinations=${dst}`);
      const js = await res.json().catch(() => null);
      if (!js || js.code !== 'Ok' || !js.distances) fail(502, 'Service de distances indisponible (OSRM).');
      es.forEach((e, a) => ps.forEach((p, c) => { const m = js.distances[a][c]; if (typeof m === 'number') result[String(e.id)][String(p.id)] = Math.round(m / 1000); }));
    }
  }
  for (const id of Object.keys(result)) {
    await q(`INSERT INTO planif_distance (employee_id, data, computed_on) VALUES ($1,$2::jsonb,current_date) ON CONFLICT (employee_id) DO UPDATE SET data = EXCLUDED.data, computed_on = current_date`, [id, JSON.stringify(result[id])]);
  }
  await q("DELETE FROM planif_setting WHERE key = 'dist_lock'");
  return { ok: true, employees: Object.keys(result).length, projects: projs.length };
}

// ----- Lectures pour les autres fonctions (mobile, tableau de bord Punch) ---------------------------------------
/** Planification d'un jour ou d'une plage : [{ projectId, projectName, day, employeeIds, createdAt }]. */
async function cellsBetween(from, to) {
  const rows = await q(`SELECT c.project_id, p.name AS project_name, to_char(c.day,'YYYY-MM-DD') AS day, c.employee_ids, c.assigned_at, c.created_at
    FROM planif_cell c LEFT JOIN fin_project p ON p.id = c.project_id WHERE c.day BETWEEN $1 AND $2 ORDER BY c.created_at`, [from, to]);
  return rows.map(r => ({ projectId: String(r.project_id), projectName: r.project_name || '', day: r.day, employeeIds: (r.employee_ids || []).map(String), assignedAt: jobj(r.assigned_at),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || '') }));
}
async function distancesFor(employeeId) {
  const r = (await q('SELECT data FROM planif_distance WHERE employee_id = $1', [String(employeeId)]))[0];
  return r ? jobj(r.data) : {};
}
async function allDistances() {
  const rows = await q('SELECT employee_id, data FROM planif_distance');
  const m = {}; rows.forEach(r => { m[String(r.employee_id)] = jobj(r.data); }); return m;
}
async function activeProjectsLite() {
  const rows = await q(`SELECT id, name, non_ccq_only FROM fin_project WHERE status = 'Projet en cours' ORDER BY name`);
  return rows.map(r => ({ id: String(r.id), name: r.name, horsCcq: !!r.non_ccq_only }));
}

async function planToday(b) {
  const day = isDay(b.date) ? b.date : new Date().toISOString().slice(0, 10);
  const cells = await cellsBetween(day, day);
  const names = new Map((await q('SELECT id, name FROM fin_employee')).map(r => [String(r.id), r.name]));
  return { cells: cells.map(c => ({ projectId: c.projectId, projectName: c.projectName, employeeIds: c.employeeIds, employeeNames: c.employeeIds.map(i => names.get(i) || '?') })) };
}
async function allDistancesAction() { return { map: await allDistances() }; }

/** Statistiques Exacto Heures : poinçons (board 18427410930) entre deux dates + tables de référence. Lecture seule. */
async function punchStats(b) {
  const isD = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const to = isD(b.to) ? b.to : new Date().toISOString().slice(0, 10);
  const from = isD(b.from) ? b.from : new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
  const rows = await q(`SELECT id, cv FROM pb_item WHERE board = $1 AND cv->'date_mm6d1p6e'->>'text' BETWEEN $2 AND $3`, ['18427410930', from, to]);
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
  const punches = rows.map(r => {
    const cv = jobj(r.cv), t = k => (cv[k] && cv[k].text) || '', id0 = k => ((cv[k] && cv[k].ids) || [])[0] || '';
    const hrs = t('numeric_mm6d8c9m') !== '' ? num(t('numeric_mm6d8c9m')) : num(t('numeric_mm6d12a7'));
    const km = t('numeric_mm6dxafw') !== '' ? num(t('numeric_mm6dxafw')) : num(t('numeric_mm6d4hvv'));
    return { id: String(r.id), e: String(id0('board_relation_mm6d1zaz')), p: String(id0('board_relation_mm6ddgy')), d: t('date_mm6d1p6e'), h: hrs, o15: num(t('numeric_mm6k81gj')), o2: num(t('numeric_mm6kefh3')), km, t: t('text_mm6enx2b'), s: t('color_mm6dxpt7') || 'En attente', hd: t('hour_mm6dfaha'), hf: t('hour_mm6dfqfg') };
  });
  const [emps, projs, tasks] = await Promise.all([
    q('SELECT id, name, department, status FROM fin_employee'),
    q('SELECT id, name, number, cp_ids FROM fin_project'),
    q(`SELECT name, cv->'boolean_mm6e9yfa'->>'text' AS ccq FROM pb_item WHERE board = $1`, ['18427580795']).catch(() => [])
  ]);
  const nameById = new Map(emps.map(r => [String(r.id), r.name]));
  return {
    from, to, punches,
    employees: emps.map(r => ({ id: String(r.id), name: r.name, chantier: /^chantier$/i.test(String(r.department || '').trim()), status: r.status })),
    projects: projs.map(r => ({ id: String(r.id), name: r.name, number: r.number || '', cp: (Array.isArray(r.cp_ids) ? r.cp_ids : []).map(i => nameById.get(String(i))).filter(Boolean) })),
    tasks: tasks.map(r => ({ name: r.name, ccq: r.ccq === 'v' }))
  };
}

const ab = () => require('./absence-db');
const READ = new Set(['punchStats', 'equipList', 'absReqList', 'absStats', 'absSettingsGet', 'planToday', 'allDistances', 'load', 'absenceList', 'historyList', 'sendRecordGet', 'draftCandidates']);
const ACTIONS = { punchStats, planToday, allDistances: allDistancesAction, load, cellCreate, cellUpdate, cellAssignedAt, cellDelete, projectWeekSet, projectLabor, projectHours, holidaySet, settingsSave, absenceSave, absenceList, absenceDelete,
  equipList, equipAssign, equipSave, equipDelete, historyAdd, historyList, sendRecordGet, sendRecordSave, draftCandidates, distancesRefresh,
  absReqList: b => ab().adminList(b), absReqCreate: (b, c) => ab().adminCreate(b, c), absReqDecide: (b, c) => ab().adminDecide(b, c), absReqDelete: b => ab().adminDelete(b),
  absStats: b => ab().adminStats(b), absSettingsGet: () => ab().settingsGet(), absSettingsSave: b => ab().settingsSave(b) };

/** Point d'entrée : retourne l'objet de réponse JSON. ctx = { email, readonly }. */
async function handle(action, body, ctx) {
  const fn = ACTIONS[action];
  if (!fn) fail(400, 'Action Planif inconnue : ' + action);
  if (ctx && ctx.readonly && !READ.has(action)) fail(403, 'Accès en lecture seule : cette action est désactivée pour votre compte.');
  return await fn(body || {}, ctx || {});
}

module.exports = { handle, cellsBetween, distancesFor, allDistances, activeProjectsLite, q };
