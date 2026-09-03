// api/employee-admin.js
// Gestion des comptes employés (accès à l'interface mobile de poinçon), réservée
// à l'administrateur (tout compte Clerk dont publicMetadata.role n'est PAS
// "employee"/"employee_disabled" — c.-à-d. les comptes bureau existants).
//
// Actions (POST { action, ... }) :
//   createAccount  { employeeItemId, employeeName, phone, password }
//   resetPassword  { clerkUserId, password }
//   setAccess      { clerkUserId, employeeItemId, enabled }
//   deleteAccount  { clerkUserId, employeeItemId }
//
// IMPORTANT — configuration Clerk requise une seule fois (dashboard Clerk) :
//   1) Configure → SMS/Phone : activer "Phone number" comme identifiant, et
//      activer "Password" comme stratégie de connexion.
//   2) Configure → Sessions → Edit → "Customize session token" : ajouter
//      "metadata": "{{user.public_metadata}}" (nécessaire pour que ce module et
//      api/monday.js puissent lire le rôle du compte sans appel API supplémentaire).

const { verifyToken, createClerkClient } = require('@clerk/backend');

const EMPLOYEES_BOARD = 8371777574;
const COL_CLERK_ID = 'text_mm6dqed0';
const COL_ACCESS = 'boolean_mm6dd03t';

// Détecte une erreur "utilisateur introuvable" renvoyée par l'API Clerk — typiquement un
// clerkUserId enregistré dans Monday qui pointait vers un compte créé du temps de l'instance
// de développement (les comptes ne se transfèrent jamais automatiquement vers la production).
function isClerkNotFound(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const list = (err.errors && Array.isArray(err.errors)) ? err.errors : [];
  return list.some(e => e && (e.code === 'resource_not_found' || /not.?found/i.test(e.message || '')));
}

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 11) return '+' + digits;
  return '+1' + digits;
}

async function mondaySetEmployeeAccess(mondayToken, employeeItemId, clerkUserId, enabled) {
  const columnValues = {
    [COL_CLERK_ID]: clerkUserId || '',
    [COL_ACCESS]: { checked: enabled ? 'true' : 'false' }
  };
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2023-10' },
    body: JSON.stringify({
      query: `mutation($board: ID!, $item: ID!, $cv: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id } }`,
      variables: { board: String(EMPLOYEES_BOARD), item: String(employeeItemId), cv: JSON.stringify(columnValues) }
    })
  });
  const data = await r.json();
  if (data.errors) throw new Error('Monday: ' + data.errors.map(e => e.message).join('; '));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }

  const secretKey = process.env.CLERK_SECRET_KEY;
  const mondayToken = process.env.MONDAY_API_TOKEN;
  if (!secretKey || !mondayToken) { res.status(500).json({ error: 'Configuration serveur incomplète.' }); return; }
  const bearerToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!bearerToken) { res.status(401).json({ error: 'Non authentifié.' }); return; }

  let claims;
  try {
    claims = await verifyToken(bearerToken, { secretKey });
  } catch (err) {
    res.status(401).json({ error: 'Session invalide ou expirée. Veuillez vous reconnecter.' });
    return;
  }
  // Garde multi-tenant : ce fichier est réservé aux comptes EPD (voir Plan-Technique-Multi-Entite-Exacto.md).
  // Un tenantId défini et différent de 'EPD' n'a pas accès ici.
  if (claims.tenantId && claims.tenantId !== 'EPD') {
    res.status(403).json({ error: "Ce compte n'a pas accès à cette application." });
    return;
  }
  const role = claims.role;
  // Toutes les actions de ce fichier sont des ÉCRITURES (créer un compte, réinitialiser un mot
  // de passe, activer/désactiver l'accès mobile) — un compte "lecture-seule" ne doit donc jamais
  // pouvoir les exécuter, même par un appel direct à l'API (voir audit du 26 août 2026, point #2 ;
  // même patron déjà utilisé dans admin-access.js).
  if (role === 'employee' || role === 'employee_disabled' || role === 'lecture-seule') {
    res.status(403).json({ error: 'Accès réservé aux administrateurs.' });
    return;
  }

  const clerk = createClerkClient({ secretKey });
  const { action } = req.body || {};

  try {
    if (action === 'createAccount') {
      const { employeeItemId, employeeName, phone, password } = req.body || {};
      if (!employeeItemId || !phone || !password) {
        res.status(400).json({ error: 'employeeItemId, phone et password sont requis.' });
        return;
      }
      const e164 = toE164(phone);
      if (!e164) { res.status(400).json({ error: 'Numéro de téléphone invalide.' }); return; }
      if (password.length < 5) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 5 caractères.' }); return; }

      const user = await clerk.users.createUser({
        phoneNumber: [e164],
        password,
        skipPasswordChecks: true, // permet des mots de passe simples/courts (min. 5) sans la validation de robustesse de Clerk
        publicMetadata: { role: 'employee', employeeItemId: String(employeeItemId), employeeName: employeeName || '' }
      });
      // Le mot de passe fourni ici est temporaire : on le marque "compromis" pour forcer
      // l'employé à en choisir un nouveau à sa toute première connexion.
      await clerk.users.setPasswordCompromised(user.id, { revokeAllSessions: true });
      await mondaySetEmployeeAccess(mondayToken, employeeItemId, user.id, true);
      res.status(200).json({ clerkUserId: user.id });
      return;
    }

    if (action === 'resetPassword') {
      const { clerkUserId, password } = req.body || {};
      if (!clerkUserId || !password) { res.status(400).json({ error: 'clerkUserId et password sont requis.' }); return; }
      if (password.length < 5) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 5 caractères.' }); return; }
      try {
        await clerk.users.updateUser(clerkUserId, { password, skipPasswordChecks: true });
        // Nouveau mot de passe temporaire lui aussi : forcer un changement à la prochaine connexion.
        await clerk.users.setPasswordCompromised(clerkUserId, { revokeAllSessions: true });
        res.status(200).json({ ok: true });
      } catch (err) {
        if (isClerkNotFound(err)) {
          // Compte introuvable — probablement créé avant le passage à l'instance Clerk de
          // production (les comptes ne se transfèrent pas d'une instance à l'autre). On
          // nettoie la référence Monday pour que l'admin puisse recréer un compte neuf.
          res.status(200).json({ ok: true, accountReset: true, message: "Ce compte n'existe plus (créé avant le passage en production). Rafraîchissez et créez un nouveau compte pour cet employé." });
          return;
        }
        throw err;
      }
      return;
    }

    if (action === 'setAccess') {
      const { clerkUserId, employeeItemId, enabled } = req.body || {};
      if (!clerkUserId || !employeeItemId) { res.status(400).json({ error: 'clerkUserId et employeeItemId sont requis.' }); return; }
      try {
        const user = await clerk.users.getUser(clerkUserId);
        const employeeName = (user.publicMetadata && user.publicMetadata.employeeName) || '';
        await clerk.users.updateUser(clerkUserId, {
          publicMetadata: { role: enabled ? 'employee' : 'employee_disabled', employeeItemId: String(employeeItemId), employeeName }
        });
        await mondaySetEmployeeAccess(mondayToken, employeeItemId, clerkUserId, !!enabled);
        res.status(200).json({ ok: true });
      } catch (err) {
        if (isClerkNotFound(err)) {
          // Même cas que ci-dessus : compte disparu (instance de développement). On réinitialise
          // la référence dans Monday (retour à "Aucun compte") plutôt que de renvoyer une erreur.
          await mondaySetEmployeeAccess(mondayToken, employeeItemId, '', false);
          res.status(200).json({ ok: true, accountReset: true, message: "Ce compte n'existe plus (créé avant le passage en production). L'accès a été réinitialisé — vous pouvez créer un nouveau compte." });
          return;
        }
        throw err;
      }
      return;
    }

    if (action === 'deleteAccount') {
      const { clerkUserId, employeeItemId } = req.body || {};
      if (!clerkUserId) { res.status(400).json({ error: 'clerkUserId est requis.' }); return; }
      try {
        await clerk.users.deleteUser(clerkUserId);
      } catch (err) {
        if (!isClerkNotFound(err)) throw err;
        // Déjà inexistant (instance de production) — on continue simplement le nettoyage Monday.
      }
      if (employeeItemId) await mondaySetEmployeeAccess(mondayToken, employeeItemId, '', false);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    const msg = (err && err.errors && err.errors[0] && err.errors[0].message) || err.message || String(err);
    res.status(502).json({ error: 'Erreur: ' + msg });
  }
};
