// api/tenant-config.js
//
// Onglet Configuration — self-service pour un tenant non-EPD. Réservé aux comptes avec un
// tenantId défini et role === 'admin'. Indépendant des fichiers EPD.
//
// Actions (POST { action, ... }) :
//   get               {}                                    // réglages + métiers + primes
//   updateSettings    { primesEnabled, payrollSoftware }     // ccqEnabled/planifEnabled sont gérés
//                                                             // par le superuser, jamais ici
//   createJobTitle    { name }
//   updateJobTitle    { id, name }
//   deleteJobTitle    { id }
//   createPrime       { name, percentage, code }
//   updatePrime       { id, name, percentage, code }
//   deletePrime       { id }

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
  } catch (err) {
    res.status(502).json({ error: 'Erreur: ' + (err.message || String(err)) });
  }
};
