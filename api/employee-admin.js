// api/employee-admin.js
// Gestion des comptes employés (accès à l'interface mobile de poinçon), réservée
// à l'administrateur (tout compte Clerk dont le claim role n'est PAS
// "employee"/"employee_disabled" — c.-à-d. les comptes bureau existants).
//
// Actions (POST { action, ... }) :
//   createAccount  { employeeItemId, employeeName, phone, password }
//   resetPassword  { clerkUserId, password }
//   setAccess      { clerkUserId, employeeItemId, enabled }
//   deleteAccount  { clerkUserId, employeeItemId }
//
// IMPORTANT — configuration Clerk requise une seule fois (dashboard Clerk) :
//   1) User & authentication → Phone : activer sign-up/sign-in par téléphone.
//      User & authentication → Password : activer sign-up par mot de passe.
//   2) Sessions → Edit → "Customize session token", coller dans l'éditeur de claims :
//      { "role": "{{user.public_metadata.role}}",
//        "employeeItemId": "{{user.public_metadata.employeeItemId}}",
//        "employeeName": "{{user.public_metadata.employeeName}}" }

const { verifyToken, createClerkClient } = require('@clerk/backend');

const EMPLOYEES_BOARD = 8371777574;
const COL_CLERK_ID = 'text_mm6dqed0';
const COL_ACCESS = 'boolean_mm6dd03t';

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
  const role = claims.role;
  if (role === 'employee' || role === 'employee_disabled') {
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
      if (password.length < 8) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' }); return; }

      const user = await clerk.users.createUser({
        phoneNumber: [e164],
        password,
        skipPasswordChecks: false,
        publicMetadata: { role: 'employee', employeeItemId: String(employeeItemId), employeeName: employeeName || '' }
      });
      await mondaySetEmployeeAccess(mondayToken, employeeItemId, user.id, true);
      res.status(200).json({ clerkUserId: user.id });
      return;
    }

    if (action === 'resetPassword') {
      const { clerkUserId, password } = req.body || {};
      if (!clerkUserId || !password) { res.status(400).json({ error: 'clerkUserId et password sont requis.' }); return; }
      if (password.length < 8) { res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' }); return; }
      await clerk.users.updateUser(clerkUserId, { password });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setAccess') {
      const { clerkUserId, employeeItemId, enabled } = req.body || {};
      if (!clerkUserId || !employeeItemId) { res.status(400).json({ error: 'clerkUserId et employeeItemId sont requis.' }); return; }
      const user = await clerk.users.getUser(clerkUserId);
      const employeeName = (user.publicMetadata && user.publicMetadata.employeeName) || '';
      await clerk.users.updateUser(clerkUserId, {
        publicMetadata: { role: enabled ? 'employee' : 'employee_disabled', employeeItemId: String(employeeItemId), employeeName }
      });
      await mondaySetEmployeeAccess(mondayToken, employeeItemId, clerkUserId, !!enabled);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'deleteAccount') {
      const { clerkUserId, employeeItemId } = req.body || {};
      if (!clerkUserId) { res.status(400).json({ error: 'clerkUserId est requis.' }); return; }
      await clerk.users.deleteUser(clerkUserId);
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
