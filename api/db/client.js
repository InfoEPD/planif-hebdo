// api/db/client.js
//
// Connexion Neon (Postgres) via le driver serverless — instance unique réutilisée entre les
// invocations "à chaud" d'une même fonction Vercel. Lit DATABASE_URL, injectée automatiquement
// par l'intégration Neon du Vercel Marketplace.

const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');
const schema = require('./schema');

let _db = null;

function getDb() {
  if (_db) return _db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL n'est pas configuré sur le serveur (intégration Neon manquante sur le projet Vercel)."
    );
  }
  const sql = neon(connectionString);
  _db = drizzle(sql, { schema });
  return _db;
}

module.exports = { getDb, schema };
