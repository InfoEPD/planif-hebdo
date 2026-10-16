// api/directory.js
//
// Annuaires Exacto : « Projets » (ex Macro | PROJETS) et « Employés ». Source unique pour Finance, Planif et Punch (tables Neon fin_project / fin_employee).
//   POST { action, ... } authentifié par Clerk.
//   Projets  : lecture = tout utilisateur connecté; écriture = comptabilité + administrateurs.
//   Employés : fiche complète (coordonnées personnelles, urgence) = administrateurs seulement; liste allégée (nom, titre, département) = tout utilisateur connecté.

const { q } = require('./_lib/db');
const { requireUser } = require('./_lib/auth');
const inv = require('./_lib/invoice');
const dir = require('./_lib/dir');

async function who(user) {
  const acct = await inv.accountingEmails();
  return { isAdmin: !!user.isAdmin, isAccounting: !!user.isAdmin || acct.includes(user.email) };
}
const needEdit = async user => { const w = await who(user); if (!w.isAccounting) throw { status: 403, message: 'Réservé à la comptabilité et aux administrateurs.' }; return w; };
const needAdmin = async user => { const w = await who(user); if (!w.isAdmin) throw { status: 403, message: "Réservé à l'administrateur." }; return w; };

const lite = e => ({ id: e.id, name: e.name, status: e.status, jobTitle: e.jobTitle, department: e.department, company: e.company });
const summary = p => ({ id: p.id, number: p.number, name: p.name, status: p.status, client: p.client, address: p.address, maxPo: p.maxPo,
  cp: p.cp.map(x => x.name), cm: p.cm.map(x => x.name), coordo: p.coordo.map(x => x.name), responsible: p.responsible.map(x => x.name).concat(p.responsibleText ? [p.responsibleText] : []),
  numberAvantage: p.numberAvantage, laborRequired: p.laborRequired, legacy: p.legacy });

const ACTIONS = {
  async status(user) {
    const w = await who(user);
    let enabled = false; try { enabled = await dir.enabled(); } catch (e) { /* ignore */ }
    const s = await require('./_lib/dirsync').status();
    return { canEdit: w.isAccounting, isAdmin: w.isAdmin, enabled, sync: s };
  },

  // ----- Projets -----
  async projectList(user) {
    const w = await who(user);
    const [projects, emps] = await Promise.all([dir.listProjects(), dir.listEmployees()]);
    return { projects: projects.map(summary), employees: emps.filter(e => !/^(Terminé)$/i.test(e.status)).map(lite), canEdit: w.isAccounting,
      statuses: dir.PROJECT_STATUSES, enabled: await dir.enabled() };
  },
  async projectGet(user, b) { await who(user); return { project: await dir.getProject(b.id) }; },
  async projectSave(user, b) {
    await needEdit(user);
    const id = await dir.saveProject(b.project || {}, user.email);
    return { ok: true, project: await dir.getProject(id) };
  },

  async projectSetStatus(user, b) {
    await needEdit(user);
    await dir.setProjectStatus(b.id, b.status);
    return { ok: true };
  },

  // ----- Employés -----
  async employeeLite(user) { await who(user); return { employees: (await dir.listEmployees()).map(lite) }; },
  async employeeList(user) {
    await needAdmin(user);
    return { employees: await dir.listEmployees(), statuses: dir.EMPLOYEE_STATUSES, skillValues: dir.SKILL_VALUES, skills: dir.SKILLS };
  },
  async employeeGet(user, b) {
    await needAdmin(user);
    const e = await dir.getEmployee(b.id); if (!e) throw { status: 404, message: 'Employé introuvable.' };
    return { employee: e };
  },
  async employeeSave(user, b) {
    await needAdmin(user);
    const id = await dir.saveEmployee(b.employee || {}, user.email);
    return { ok: true, employee: await dir.getEmployee(id) };
  },
  async employeeDelete(user, b) {
    await needAdmin(user);
    await dir.deleteEmployee(b.id);
    return { ok: true };
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
    if (status >= 500) console.error('directory.js', body.action, e);
    res.status(status).json({ error: (e && e.message) || 'Erreur serveur.' });
  }
};
module.exports.ACTIONS = ACTIONS;
