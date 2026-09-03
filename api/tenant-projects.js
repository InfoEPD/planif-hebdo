// api/tenant-projects.js
//
// Gestion des projets — self-service pour un tenant non-EPD. Réservé aux comptes avec un
// tenantId défini et role === 'admin'. Indépendant des fichiers EPD.
//
// Actions (POST { action, ... }) :
//   list    {}
//   create  { name, code, address, status }   // status: 'en_planification' | 'en_cours' | 'termine'
//   update  { id, name, code, address, status }
//   remove  { id }

const { eq, and } = require('drizzle-orm');
const { getDb, schema } = require('../db/client');
const { requireTenantContext } = require('./_lib/tenant-context');

const VALID_STATUSES = ['en_planification', 'en_cours', 'termine'];

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
      const rows = await db.select().from(schema.projects).where(eq(schema.projects.tenantId, tenantId));
      res.status(200).json({ projects: rows });
      return;
    }

    if (action === 'create') {
      const { name, code, address, status } = req.body || {};
      if (!name) { res.status(400).json({ error: 'Le nom du projet est requis.' }); return; }
      const [row] = await db.insert(schema.projects).values({
        tenantId, name, code: code || null, address: address || null,
        status: VALID_STATUSES.includes(status) ? status : 'en_planification',
      }).returning();
      res.status(200).json({ ok: true, project: row });
      return;
    }

    if (action === 'update') {
      const { id, name, code, address, status } = req.body || {};
      if (!id) { res.status(400).json({ error: 'id est requis.' }); return; }
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (code !== undefined) patch.code = code || null;
      if (address !== undefined) patch.address = address || null;
      if (status !== undefined) {
        if (!VALID_STATUSES.includes(status)) { res.status(400).json({ error: 'Statut invalide.' }); return; }
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
  } catch (err) {
    res.status(502).json({ error: 'Erreur: ' + (err.message || String(err)) });
  }
};
