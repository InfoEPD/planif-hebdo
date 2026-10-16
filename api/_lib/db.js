// api/_lib/db.js
// Connexion Neon (Postgres, driver HTTP serverless) — SQL brut paramétré, sans ORM.
// DATABASE_URL est injectée par l'intégration Neon de Vercel (ou ajoutée à la main).

const { neon } = require('@neondatabase/serverless');

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL n'est pas configuré sur le serveur (base Neon du projet Finance).");
  _sql = neon(cs);
  return _sql;
}

/** Exécute une requête paramétrée ($1, $2, …) et retourne le tableau de lignes. */
async function q(text, params) {
  const s = getSql();
  const rows = typeof s.query === 'function' ? await s.query(text, params || []) : await s(text, params || []);
  return Array.isArray(rows) ? rows : (rows && rows.rows) || [];
}

module.exports = { q };
