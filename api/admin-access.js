// api/admin-access.js
// Gestion des accès du Portail Admin (rôles "admin" à accès complet vs "lecture-seule"),
// directement depuis l'interface plutôt que via le tableau de bord Clerk. Ne concerne PAS
// les comptes employés (poinçon mobile, gérés dans api/employee-admin.js) — ceux-ci sont
// explicitement exclus de la liste ci-dessous.
//
// Réservé aux comptes à accès complet (ni "employee"/"employee_disabled", ni "lecture-seule" —
// un compte en lecture seule ne peut donc pas modifier les accès des autres, ni le sien).
//
// Actions (POST { action, ... }) :
//   list      {}
//   setRole   { clerkUserId, role }   // role: 'admin' | 'lecture-seule'

const { verifyToken, createClerkClient } = require('@clerk/backend');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) { res.status(500).json({ error: 'Configuration serveur incomplète.' }); return; }
  const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!bearerToken) { res.status(401).json({ error: 'Non authentifié.' }); return; }

  let claims;
  try {
    claims = await verifyToken(bearerToken, { secretKey });
  } catch (err) {
    res.status(401).json({ error: 'Session invalide ou expirée. Veuillez vous reconnecter.' });
    return;
  }
  const role = claims.role;
  if (role === 'employee' || role === 'employee_disabled' || role === 'lecture-seule') {
    res.status(403).json({ error: 'Accès réservé aux administrateurs à accès complet.' });
    return;
  }

  const clerk = createClerkClient({ secretKey });
  const { action } = req.body || {};
  const callerId = claims.sub;

  try {
    if (action === 'list') {
      const list = await clerk.users.getUserList({ limit: 200 });
      const rawUsers = Array.isArray(list) ? list : (list.data || []);
      const users = rawUsers
        .filter(u => {
          const r = u.publicMetadata && u.publicMetadata.role;
          return r !== 'employee' && r !== 'employee_disabled';
        })
        .map(u => ({
          clerkUserId: u.id,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || '(sans nom)',
          email: (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) || '',
          role: (u.publicMetadata && u.publicMetadata.role === 'lecture-seule') ? 'lecture-seule' : 'admin',
          isSelf: u.id === callerId
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.status(200).json({ users });
      return;
    }

    if (action === 'setRole') {
      const { clerkUserId, role: newRole } = req.body || {};
      if (!clerkUserId || (newRole !== 'admin' && newRole !== 'lecture-seule')) {
        res.status(400).json({ error: "clerkUserId et role ('admin' ou 'lecture-seule') sont requis." });
        return;
      }
      if (clerkUserId === callerId) {
        res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre accès.' });
        return;
      }
      const user = await clerk.users.getUser(clerkUserId);
      const nextMeta = Object.assign({}, user.publicMetadata || {});
      if (newRole === 'admin') delete nextMeta.role; else nextMeta.role = 'lecture-seule';
      await clerk.users.updateUser(clerkUserId, { publicMetadata: nextMeta });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    const msg = (err && err.errors && err.errors[0] && err.errors[0].message) || err.message || String(err);
    res.status(502).json({ error: 'Erreur: ' + msg });
  }
};
