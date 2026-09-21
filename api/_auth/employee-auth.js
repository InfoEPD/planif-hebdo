// api/_auth/employeeAuth.js
// Authentification maison (téléphone + mot de passe) pour l'interface mobile de poinçon EPD
// (punch.html), en remplacement de Clerk — voir migration-employee-credentials.sql pour le
// stockage (table Postgres employee_credentials, base Neon existante).
//
// Aucune nouvelle dépendance npm : le hachage de mot de passe utilise le module natif `crypto`
// de Node (scrypt) plutôt que bcrypt, et le jeton de session est un jeton maison signé (HMAC
// SHA-256) plutôt qu'un JWT Clerk — même forme de contrat que l'ancien verifyToken() de
// @clerk/backend (jette une erreur si invalide/expiré, retourne les claims sinon), pour que
// punch.js / employee-today.js / employee-messages.js n'aient qu'à remplacer l'appel, pas leur
// logique autour.
//
// Variable d'environnement requise : EMPLOYEE_AUTH_SECRET (chaîne aléatoire longue — ex.
// générée via `openssl rand -hex 32`). Ne JAMAIS réutiliser CLERK_SECRET_KEY ici.

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours — pas de rafraîchissement silencieux
// comme Clerk en faisait ; ajuster ici si besoin d'une durée différente.

function getSecret() {
  const secret = process.env.EMPLOYEE_AUTH_SECRET;
  if (!secret) throw new Error('EMPLOYEE_AUTH_SECRET manquant dans la configuration serveur.');
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ───────────────────────── Mots de passe (scrypt, natif Node) ──────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ───────────────────────── Jeton de session (HMAC signé, sans dépendance JWT) ──────────────────

// payload attendu par les endpoints existants : { role:'employee', employeeItemId, employeeName,
// tenantId:'EPD' } — même forme que les claims publicMetadata que Clerk fournissait, pour que
// employee-today.js / employee-messages.js / punch.js n'aient rien d'autre à changer.
function createEmployeeToken(payload) {
  const body = { ...payload, tenantId: 'EPD', iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  const bodyB64 = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', getSecret()).update(bodyB64).digest();
  return `${bodyB64}.${b64url(sig)}`;
}

// Vérifie et décode le jeton — jette une erreur (comme le faisait verifyToken() de Clerk) si
// invalide, mal signé, ou expiré. Retourne les claims sinon.
function verifyEmployeeToken(bearerToken) {
  if (!bearerToken || typeof bearerToken !== 'string' || !bearerToken.includes('.')) {
    throw new Error('Jeton invalide.');
  }
  const [bodyB64, sigB64] = bearerToken.split('.');
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(bodyB64).digest();
  const actualSig = fromB64url(sigB64);
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    throw new Error('Signature de jeton invalide.');
  }
  let body;
  try { body = JSON.parse(fromB64url(bodyB64).toString('utf8')); } catch (e) { throw new Error('Jeton illisible.'); }
  if (!body.exp || Date.now() > body.exp) throw new Error('Session expirée. Veuillez vous reconnecter.');
  return body;
}

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 11) return '+' + digits;
  return '+1' + digits;
}

module.exports = { hashPassword, verifyPassword, createEmployeeToken, verifyEmployeeToken, toE164, TOKEN_TTL_MS };
