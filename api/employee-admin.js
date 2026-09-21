// api/employee-admin.js
// Gestion des comptes employés (accès à l'interface mobile de poinçon EPD, punch.html), réservée
// à l'administrateur (tout compte Clerk dont publicMetadata.role n'est PAS
// "employee"/"employee_disabled" — c.-à-d. les comptes bureau existants). Ce fichier lui-même
// reste protégé par Clerk (comptes admin/bureau) — seule l'authentification des EMPLOYÉS mobiles
// a été abandonnée au profit d'un système maison téléphone + mot de passe, voir api/punch.js
// action 'login' et api/_auth/employeeAuth.js. Les mots de passe hachés sont stockés dans la
// table Postgres employee_credentials (voir db/schema.js et migration-employee-credentials.sql) —
// PAS dans Monday, qui ne stocke que le numéro de téléphone (EMP_PHONE_COL, déjà utilisé partout
// ailleurs dans l'app) et un indicateur d'accès (COL_ACCESS).
//
// Actions (POST { action, ... }) :
//   createAccount  { employeeItemId, employeeName, phone, password }
//   resetPassword  { clerkUserId, password }  — "clerkUserId" ici est en fait employeeItemId
//                                                (voir data-clerk dans admin.html — nom conservé
//                                                pour minimiser le diff front-end, mais ne
//                                                référence plus Clerk du tout)
//   setAccess      { clerkUserId, employeeItemId, enabled }
//   deleteAccount  { clerkUserId, employeeItemId }

const { verifyToken } = require('@clerk/backend');
const { eq } = require('drizzle-orm');
const { getDb, schema } = require('./_db/client');
const { hashPassword } = require('./_auth/employeeAuth');

const EMPLOYEES_BOARD = 8371777574;
// Ne contient plus un ID Clerk : simple marqueur non vide ("has account") écrit/effacé par ce
// fichier — voir commentaire d'action ci-dessus. Conservé (nom de colonne + logique 3-états dans
// admin.html : Aucun compte / Actif / Désactivé) pour minimiser le diff front-end.
const COL_CLERK_ID = 'text_mm6dqed0';
const COL_ACCESS = 'boolean_mm6dd03t';
const EMP_PHONE_COL = 't_l_phone_mkmx24h2'; // # Téléphone (Employés) — même colonne que partout ailleurs

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 11) return '+' + digits;
  return '+1' + digits;
}

async function mondaySetEmployeeAccount(mondayToken, employeeItemId, { hasAccount, enabled, phone }) {
  const columnValues = {
    [COL_CLERK_ID]: hasAccount ? String(employeeItemId) : '',
    [COL_ACCESS]: { checked: enabled ? 'true' : 'false' }
  };
  if (phone !== undefined) columnValues[EMP_PHONE_COL] = phone;
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

  const { action } = req.body || {};
  // Libellé de l'admin ayant effectué l'action — journalisé dans employee_credentials.updated_by.
  const adminLabel = claims.name || claims.email || claims.sub || 'admin';

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

      const db = getDb();
      const passwordHash = hashPassword(password);
      const [existing] = await db.select().from(schema.employeeCredentials)
        .where(eq(schema.employeeCredentials.employeeItemId, String(employeeItemId)));
      if (existing) {
        await db.update(schema.employeeCredentials)
          .set({ passwordHash, mustChangePassword: true, updatedAt: new Date(), updatedBy: adminLabel })
          .where(eq(schema.employeeCredentials.employeeItemId, String(employeeItemId)));
      } else {
        await db.insert(schema.employeeCredentials).values({
          employeeItemId: String(employeeItemId), passwordHash, mustChangePassword: true, updatedBy: adminLabel
        });
      }
      // Le téléphone saisi ici (potentiellement corrigé par l'admin) devient la valeur Monday
      // faisant autorité — c'est elle que api/punch.js (action 'login') utilise pour retrouver
      // l'employé à la connexion, donc les deux doivent rester synchronisés.
      await mondaySetEmployeeAccount(mondayToken, employeeItemId, { hasAccount: true, enabled: true, phone: phone });
      res.status(200).json({ ok: true, clerkUserId: String(employeeItemId) });
      return;
    }

    if (action === 'resetPassword') {
      // "clerkUserId" ici est en réalité employeeItemId (voir data-clerk dans admin.html / en-tête
      // de ce fichier) — nom conservé pour minimiser le diff front-end.
      const { clerkUserId, password } = req.body || {};
      if (!clerkUserId || !password) { res.status(400).json({ error: 'clerkUserId et password sont requis.' }); return; }
      if (password.length < 5) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 5 caractères.' }); return; }

      const db = getDb();
      const passwordHash = hashPassword(password);
      const [existing] = await db.select().from(schema.employeeCredentials)
        .where(eq(schema.employeeCredentials.employeeItemId, String(clerkUserId)));
      if (existing) {
        await db.update(schema.employeeCredentials)
          .set({ passwordHash, mustChangePassword: true, updatedAt: new Date(), updatedBy: adminLabel })
          .where(eq(schema.employeeCredentials.employeeItemId, String(clerkUserId)));
      } else {
        await db.insert(schema.employeeCredentials).values({
          employeeItemId: String(clerkUserId), passwordHash, mustChangePassword: true, updatedBy: adminLabel
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setAccess') {
      const { clerkUserId, employeeItemId, enabled } = req.body || {};
      if (!clerkUserId || !employeeItemId) { res.status(400).json({ error: 'clerkUserId et employeeItemId sont requis.' }); return; }
      await mondaySetEmployeeAccount(mondayToken, employeeItemId, { hasAccount: true, enabled: !!enabled });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'deleteAccount') {
      const { employeeItemId } = req.body || {};
      if (!employeeItemId) { res.status(400).json({ error: 'employeeItemId est requis.' }); return; }
      const db = getDb();
      await db.delete(schema.employeeCredentials)
        .where(eq(schema.employeeCredentials.employeeItemId, String(employeeItemId)));
      await mondaySetEmployeeAccount(mondayToken, employeeItemId, { hasAccount: false, enabled: false });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    const msg = (err && err.errors && err.errors[0] && err.errors[0].message) || err.message || String(err);
    res.status(502).json({ error: 'Erreur: ' + msg });
  }
};
