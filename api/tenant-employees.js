// api/tenant-employees.js
//
// Gestion des employés — self-service pour un tenant non-EPD. Réservé aux comptes avec un
// tenantId défini (voir api/_lib/tenant-context.js) et role === 'admin'. Complètement indépendant
// des fichiers EPD (monday.js, employee-admin.js, etc.) — ne les modifie pas, ne les importe pas.
//
// Actions (POST { action, ... }) :
//   list    {}
//   create  { fullName, phone, email, jobTitle, employeeNumber }
//   update  { id, fullName, phone, email, jobTitle, employeeNumber, status }  // status: 'actif' | 'inactif'
//   remove  { id }

const { eq, and } = require('drizzle-orm');
const { getDb, schema } = require('../db/client');
const { requireTenantContext } = require('./_lib/tenant-context');

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
  const { action } = req.body || {};
  const tenantId = ctx.tenantId;

  try {
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
  } catch (err) {
    res.status(502).json({ error: 'Erreur: ' + (err.message || String(err)) });
  }
};
