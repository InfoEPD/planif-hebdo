// api/_lib/auth.js
//
// Vérification du jeton de session Clerk (même patron que api/monday.js) + identification de
// la personne : courriel, nom, et si elle est « administratrice Finance » (peut émettre tout bon
// de commande). Le chargé de projet d'un projet est reconnu par son courriel (colonne « Courriel »
// de la fiche Employé liée au projet dans Monday).
//
// Variables d'environnement :
//   CLERK_SECRET_KEY        (obligatoire)
//   FINANCE_ADMIN_EMAILS    courriels séparés par des virgules (défaut : mayotte@epd.ca) — toujours administrateurs (filet de sécurité)
//   + administrateurs ajoutés dans Configuration → Utilisateurs et profils (table fin_settings, clé admin_emails)

const { verifyToken, createClerkClient } = require('@clerk/backend');

const userCache = new Map(); // userId -> { at, email, name }
const CACHE_MS = 10 * 60 * 1000;

function adminEmails() {
  return String(process.env.FINANCE_ADMIN_EMAILS || 'mayotte@epd.ca')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

let _dbAdmins = { at: 0, list: [] };
/** Administrateurs ajoutés dans Configuration → Utilisateurs et profils (fin_settings « admin_emails »). */
async function dbAdminEmails() {
  if (Date.now() - _dbAdmins.at < 20000) return _dbAdmins.list;
  let list = [];
  try {
    const { q } = require('./db');
    const r = await q("SELECT value FROM fin_settings WHERE key = 'admin_emails'");
    list = r[0] && r[0].value ? String(r[0].value).split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean) : [];
  } catch (e) { list = _dbAdmins.list; }   // base indisponible : on garde la dernière liste connue
  _dbAdmins = { at: Date.now(), list };
  return list;
}
function resetAdminCache() { _dbAdmins = { at: 0, list: [] }; }
async function allAdminEmails() { return Array.from(new Set(adminEmails().concat(await dbAdminEmails()))); }

async function requireUser(req) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw { status: 500, message: "CLERK_SECRET_KEY n'est pas configuré sur le serveur." };
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!bearer) throw { status: 401, message: 'Non authentifié.' };

  let claims;
  try { claims = await verifyToken(bearer, { secretKey }); }
  catch (e) { throw { status: 401, message: 'Session invalide ou expirée. Veuillez vous reconnecter.' }; }

  // Réservé aux comptes EPD (mêmes règles que api/monday.js).
  if (claims.tenantId && claims.tenantId !== 'EPD') throw { status: 403, message: "Ce compte n'a pas accès à cette application." };
  const role = claims.role;
  if (role === 'employee' || role === 'employee_disabled') throw { status: 403, message: 'Accès non autorisé pour ce type de compte.' };

  const userId = claims.sub;
  let email = (claims.email || claims.primaryEmail || '').toLowerCase();
  let name = claims.name || '';
  if (!email) {
    const cached = userCache.get(userId);
    if (cached && Date.now() - cached.at < CACHE_MS) { email = cached.email; name = name || cached.name; }
    else {
      try {
        const clerk = createClerkClient({ secretKey });
        const u = await clerk.users.getUser(userId);
        const primary = (u.emailAddresses || []).find(e => e.id === u.primaryEmailAddressId) || (u.emailAddresses || [])[0];
        email = ((primary && primary.emailAddress) || '').toLowerCase();
        name = name || [u.firstName, u.lastName].filter(Boolean).join(' ') || email;
        userCache.set(userId, { at: Date.now(), email, name });
      } catch (e) {
        throw { status: 502, message: "Impossible de lire le profil Clerk : " + (e.message || e) };
      }
    }
  }
  const isAdmin = (await allAdminEmails()).includes(email);
  return { userId, email, name: name || email, role, isAdmin };
}

module.exports = { requireUser, adminEmails, dbAdminEmails, allAdminEmails, resetAdminCache };
