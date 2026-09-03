// api/superuser-tenants.js
//
// Gestion des entreprises (tenants) — réservé au rôle "superuser". Complètement indépendant de
// api/monday.js et api/admin-access.js : ne les modifie pas, ne les importe pas.
//
// Actions (POST { action, ... }) :
//   list              {}
//   create            { name, slug, ccqEnabled, planifEnabled }
//   updateSettings    { tenantId, ccqEnabled, planifEnabled }
//   setStatus         { tenantId, status }                 // status: 'active' | 'suspended'
//   createFirstAdmin  { tenantId, name, email, password }   // crée le premier accès admin du tenant
//
// Note : primesEnabled et payrollSoftware ne sont PAS gérés ici — chaque tenant les configure
// lui-même dans son propre onglet Configuration (voir api/tenant-config.js). Ce fichier ne les
// touche jamais, pour ne pas écraser un réglage fait par le tenant.

const { createClerkClient } = require('@clerk/backend');
const { eq } = require('drizzle-orm');
const { getDb, schema } = require('./_db/client');
const { requireSuperuserContext } = require('./_lib/tenant-context');

const DIACRITICS_RE = new RegExp('[̀-ͯ]', 'g');
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(DIACRITICS_RE, '') // retire les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function logAudit(db, ctx, action, tenantId, details) {
  try {
    await db.insert(schema.superuserAuditLog).values({
      actorClerkUserId: ctx.callerId,
      actorLabel: (ctx.claims && (ctx.claims.name || ctx.claims.email)) || ctx.callerId,
      action,
      tenantId: tenantId || null,
      details: details || null,
    });
  } catch (err) {
    // Le journal d'audit ne doit jamais faire échouer l'action elle-même.
    console.error('Échec de journalisation superuser_audit_log:', err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  let ctx;
  try {
    ctx = await requireSuperuserContext(req);
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Non autorisé.' });
    return;
  }

  const db = getDb();
  const { action } = req.body || {};

  try {
    if (action === 'list') {
      const tenants = await db.select().from(schema.tenants);
      const settings = await db.select().from(schema.tenantSettings);
      const settingsByTenant = Object.fromEntries(settings.map(s => [s.tenantId, s]));
      const result = tenants.map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        createdAt: t.createdAt,
        settings: settingsByTenant[t.id] || null,
      }));
      res.status(200).json({ tenants: result });
      return;
    }

    if (action === 'create') {
      const { name, ccqEnabled, planifEnabled } = req.body || {};
      let { slug } = req.body || {};
      if (!name) { res.status(400).json({ error: 'Le nom de l\'entreprise est requis.' }); return; }
      slug = slugify(slug || name);
      if (!slug) { res.status(400).json({ error: 'Impossible de générer un identifiant (slug) valide.' }); return; }
      if (slug === 'epd') {
        res.status(400).json({ error: '"epd" est réservé — EPD reste géré via son chemin Monday dédié.' });
        return;
      }
      const existing = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
      if (existing.length) { res.status(400).json({ error: `Un tenant avec l'identifiant "${slug}" existe déjà.` }); return; }

      const [tenant] = await db.insert(schema.tenants).values({ name, slug }).returning();
      await db.insert(schema.tenantSettings).values({
        tenantId: tenant.id,
        ccqEnabled: !!ccqEnabled,
        planifEnabled: !!planifEnabled,
      });
      await logAudit(db, ctx, 'create_tenant', tenant.id, { name, slug });
      res.status(200).json({ ok: true, tenant });
      return;
    }

    if (action === 'updateSettings') {
      const { tenantId, ccqEnabled, planifEnabled } = req.body || {};
      if (!tenantId) { res.status(400).json({ error: 'tenantId est requis.' }); return; }
      // Ne touche volontairement PAS à primesEnabled/payrollSoftware — gérés par le tenant lui-même.
      await db.update(schema.tenantSettings)
        .set({
          ccqEnabled: !!ccqEnabled,
          planifEnabled: !!planifEnabled,
        })
        .where(eq(schema.tenantSettings.tenantId, tenantId));
      await logAudit(db, ctx, 'update_settings', tenantId, { ccqEnabled, planifEnabled });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setStatus') {
      const { tenantId, status } = req.body || {};
      if (!tenantId || (status !== 'active' && status !== 'suspended')) {
        res.status(400).json({ error: "tenantId et status ('active' ou 'suspended') sont requis." });
        return;
      }
      await db.update(schema.tenants).set({ status }).where(eq(schema.tenants.id, tenantId));
      await logAudit(db, ctx, 'set_status', tenantId, { status });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'createFirstAdmin') {
      const { tenantId, name, email, password } = req.body || {};
      if (!tenantId || !email || !password) {
        res.status(400).json({ error: 'tenantId, email et password sont requis.' });
        return;
      }
      if (password.length < 5) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 5 caractères.' }); return; }
      const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      if (!tenant) { res.status(404).json({ error: 'Tenant introuvable.' }); return; }

      const secretKey = process.env.CLERK_SECRET_KEY;
      const clerk = createClerkClient({ secretKey });
      const parts = String(name || '').trim().split(/\s+/);
      const firstName = parts.shift() || undefined;
      const lastName = parts.length ? parts.join(' ') : undefined;

      // Même patron que api/admin-access.js (action 'create') : mot de passe temporaire marqué
      // "compromis" pour forcer une réinitialisation à la première connexion.
      const user = await clerk.users.createUser({
        emailAddress: [email],
        password,
        firstName,
        lastName,
        skipPasswordChecks: true,
        publicMetadata: { tenantId: tenant.id, role: 'admin' },
      });
      await clerk.users.setPasswordCompromised(user.id, { revokeAllSessions: true });
      await logAudit(db, ctx, 'create_first_admin', tenantId, { email, clerkUserId: user.id });
      res.status(200).json({ ok: true, clerkUserId: user.id });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    const msg = (err && err.errors && err.errors[0] && err.errors[0].message) || err.message || String(err);
    res.status(502).json({ error: 'Erreur: ' + msg });
  }
};
