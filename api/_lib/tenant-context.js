// api/_lib/tenant-context.js
//
// Helper de vérification/résolution du tenant, réservé aux NOUVEAUX points d'entrée liés au
// multi-tenant (api/tenant-*.js, api/superuser-tenants.js). api/monday.js et tous les autres
// fichiers api/*.js existants gardent leur propre vérification Clerk telle quelle, inchangée —
// ce fichier n'est importé par aucun d'entre eux.
//
// Convention réutilisée (même patron que api/monday.js et api/admin-access.js) : le jeton Clerk
// est vérifié côté serveur via verifyToken(), jamais fait confiance à une valeur fournie par le
// client. `claims.role` existe déjà comme claim personnalisé (gabarit de jeton Clerk) — on
// ajoute `claims.tenantId` du même gabarit. Tant que ce claim n'est pas encore présent dans le
// gabarit Clerk (avant migration), on retombe sur 'EPD' par défaut — mais en pratique, les
// endpoints EPD n'appellent jamais ce helper (ils passent par api/monday.js), donc ce défaut ne
// sert que de garde-fou.

const { verifyToken } = require('@clerk/backend');

/**
 * Vérifie le jeton Clerk de la requête et retourne le contexte tenant/rôle.
 * Lance une erreur { status, message } en cas de problème — à catcher dans le handler appelant.
 */
async function getTenantContext(req) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw { status: 500, message: "CLERK_SECRET_KEY n'est pas configuré sur le serveur." };
  }
  const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!bearerToken) {
    throw { status: 401, message: 'Non authentifié.' };
  }

  let claims;
  try {
    claims = await verifyToken(bearerToken, { secretKey });
  } catch (err) {
    throw { status: 401, message: 'Session invalide ou expirée. Veuillez vous reconnecter.' };
  }

  const role = claims.role || 'admin';
  const tenantId = claims.tenantId || null;
  const isSuperuser = role === 'superuser';

  return { claims, callerId: claims.sub, role, tenantId, isSuperuser };
}

/**
 * Variante stricte : exige un tenantId résolu (utilisée par les endpoints CRUD tenant, jamais
 * par les endpoints superuser qui opèrent au-dessus des tenants).
 */
async function requireTenantContext(req) {
  const ctx = await getTenantContext(req);
  if (!ctx.tenantId) {
    throw { status: 403, message: 'Aucun tenant associé à ce compte.' };
  }
  return ctx;
}

/**
 * Variante superuser : exige role === 'superuser'.
 */
async function requireSuperuserContext(req) {
  const ctx = await getTenantContext(req);
  if (!ctx.isSuperuser) {
    throw { status: 403, message: 'Accès réservé à la gestion de plateforme (superuser).' };
  }
  return ctx;
}

module.exports = { getTenantContext, requireTenantContext, requireSuperuserContext };
