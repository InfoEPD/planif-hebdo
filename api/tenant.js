// api/tenant.js
//
// Endpoint unique self-service pour un tenant non-EPD (fusion de tenant-employees.js,
// tenant-projects.js et tenant-config.js — fusionnés pour rester sous la limite de 12
// fonctions Serverless du plan Vercel Hobby). Réservé aux comptes avec un tenantId défini
// et role === 'admin'. Complètement indépendant des fichiers EPD (monday.js, employee-admin.js,
// etc.) — ne les modifie pas, ne les importe pas.
//
// Body attendu (POST) : { resource, action, ...params }
//
//   resource: 'employees'
//     action: list    {}
//     action: create  { fullName, phone, email, jobTitle, employeeNumber }
//     action: update  { id, fullName, phone, email, jobTitle, employeeNumber, status }  // status: 'actif' | 'inactif'
//     action: remove  { id }
//
//   resource: 'projects'
//     action: list    {}
//     action: create  { name, code, address, status }   // status: 'en_planification' | 'en_cours' | 'termine'
//     action: update  { id, name, code, address, status }
//     action: remove  { id }
//
//   resource: 'config'
//     action: get               {}                                    // réglages + métiers + primes
//     action: updateSettings    { primesEnabled, payrollSoftware }     // ccqEnabled/planifEnabled gérés par le superuser
//     action: createJobTitle    { name }
//     action: updateJobTitle    { id, name }
//     action: deleteJobTitle    { id }
//     action: createPrime       { name, percentage, code }
//     action: updatePrime       { id, name, percentage, code }
//     action: deletePrime       { id }
 
const { eq, and } = require('drizzle-orm');
const { getDb, schema } = require('./_db/client');
const { requireTenantContext } = require('./_lib/tenant-context');
 
const VALID_PROJECT_STATUSES = ['en_planification', 'en_cours', 'termine'];
 
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }
 
  let ctx;
  try {
    ctx = await requireTenantContext(req);
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Non autorisé.' });
    return;
  }
  if (ctx.role !== 'admin') {
    res.status(403).json({ error: 'Accès réservé aux administrateurs de votre entreprise.' });
    return;
  }
 
  const db = getDb();
  const { resource, action } = req.body || {};
  const tenantId = ctx.tenantId;
 
  try {
    // ===================== Employés =====================
    if (resource === 'employees') {
      if (action === 'list') {
        const rows = await db.select().from(schema.employees).where(eq(schema.employees.tenantId, tenantId));
        res.status(200).json({ employees: rows });
        return;
      }
      if (action === 'create') {
        const { fullName, phone, email, jobTitle, employeeNumber } = req.body || {};
        if (!fullName) { res.status(400).json({ error: 'Le nom complet est requis.' }); return; }
        const [row] = await db.insert(schema.employees).values({
          tenantId, fullName, phone: phone || null, email: email || null,
          jobTitle: jobTitle || null, employeeNumber: employeeNumber || null,
        }).returning();
        res.status(200).json({ ok: true, employee: row });
        return;
      }
      if (action === 'update') {
        const { id, fullName, phone, email, jobTitle, employeeNumber, status } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (fullName !== undefined) patch.fullName = fullName;
        if (phone !== undefined) patch.phone = phone || null;
        if (email !== undefined) patch.email = email || null;
        if (jobTitle !== undefined) patch.jobTitle = jobTitle || null;
        if (employeeNumber !== undefined) patch.employeeNumber = employeeNumber || null;
        if (status !== undefined) patch.status = (status === 'inactif') ? 'inactif' : 'actif';
        await db.update(schema.employees).set(patch)
          .where(and(eq(schema.employees.id, id), eq(schema.employees.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'remove') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.employees)
          .where(and(eq(schema.employees.id, id), eq(schema.employees.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }
 
    // ===================== Projets =====================
    if (resource === 'projects') {
      if (action === 'list') {
        const rows = await db.select().from(schema.projects).where(eq(schema.projects.tenantId, tenantId));
        res.status(200).json({ projects: rows });
        return;
      }
      if (action === 'create') {
        const { name, code, address, lat, lng, status } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom du projet est requis.' }); return; }
        if (address && (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))) {
          res.status(400).json({ error: "L'adresse doit être sélectionnée dans la liste de suggestions (géolocalisation requise)." });
          return;
        }
        const [row] = await db.insert(schema.projects).values({
          tenantId, name, code: code || null, address: address || null,
          lat: address ? lat : null, lng: address ? lng : null,
          status: VALID_PROJECT_STATUSES.includes(status) ? status : 'en_planification',
        }).returning();
        res.status(200).json({ ok: true, project: row });
        return;
      }
      if (action === 'update') {
        const { id, name, code, address, lat, lng, status } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (code !== undefined) patch.code = code || null;
        if (address !== undefined) {
          if (address && (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng))) {
            res.status(400).json({ error: "L'adresse doit être sélectionnée dans la liste de suggestions (géolocalisation requise)." });
            return;
          }
          patch.address = address || null;
          patch.lat = address ? lat : null;
          patch.lng = address ? lng : null;
        }
        if (status !== undefined) {
          if (!VALID_PROJECT_STATUSES.includes(status)) { res.status(400).json({ error: 'Statut invalide.' }); return; }
          patch.status = status;
        }
        await db.update(schema.projects).set(patch)
          .where(and(eq(schema.projects.id, id), eq(schema.projects.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'remove') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.projects)
          .where(and(eq(schema.projects.id, id), eq(schema.projects.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }
 
    // ===================== Configuration =====================
    if (resource === 'config') {
      if (action === 'get') {
        const [settings] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
        const jobTitles = await db.select().from(schema.jobTitles).where(eq(schema.jobTitles.tenantId, tenantId));
        const primes = await db.select().from(schema.primes).where(eq(schema.primes.tenantId, tenantId));
        res.status(200).json({ settings: settings || null, jobTitles, primes });
        return;
      }
      if (action === 'updateSettings') {
        const { primesEnabled, payrollSoftware } = req.body || {};
        await db.update(schema.tenantSettings)
          .set({
            primesEnabled: !!primesEnabled,
            payrollSoftware: payrollSoftware || null,
          })
          .where(eq(schema.tenantSettings.tenantId, tenantId));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'createJobTitle') {
        const { name } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom est requis.' }); return; }
        const [row] = await db.insert(schema.jobTitles).values({ tenantId, name }).returning();
        res.status(200).json({ ok: true, jobTitle: row });
        return;
      }
      if (action === 'updateJobTitle') {
        const { id, name } = req.body || {};
        if (!id || !name) { res.status(400).json({ error: 'id et name sont requis.' }); return; }
        await db.update(schema.jobTitles).set({ name })
          .where(and(eq(schema.jobTitles.id, id), eq(schema.jobTitles.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'deleteJobTitle') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.jobTitles)
          .where(and(eq(schema.jobTitles.id, id), eq(schema.jobTitles.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'createPrime') {
        const { name, percentage, code } = req.body || {};
        if (!name) { res.status(400).json({ error: 'Le nom est requis.' }); return; }
        const [row] = await db.insert(schema.primes).values({
          tenantId, name, percentage: percentage || null, code: code || null,
        }).returning();
        res.status(200).json({ ok: true, prime: row });
        return;
      }
      if (action === 'updatePrime') {
        const { id, name, percentage, code } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (percentage !== undefined) patch.percentage = percentage || null;
        if (code !== undefined) patch.code = code || null;
        await db.update(schema.primes).set(patch)
          .where(and(eq(schema.primes.id, id), eq(schema.primes.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'deletePrime') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
        await db.delete(schema.primes)
          .where(and(eq(schema.primes.id, id), eq(schema.primes.tenantId, tenantId)));
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Action inconnue.' });
      return;
    }
 
    res.status(400).json({ error: 'Resource inconnue.' });
  } catch (err) {
    res.status(502).json({ error: 'Erreur: ' + (err.message || String(err)) });
  }
};
