// db/client.js
//
// Connexion Neon (Postgres) via le driver serverless — instance unique réutilisée entre les
// invocations "à chaud" d'une même fonction Vercel. Lit DATABASE_URL, injectée automatiquement
// par l'intégration Neon du Vercel Marketplace (aucune configuration manuelle de jeton requise
// une fois l'intégration installée sur le projet).
//
// N'est utilisé QUE par les nouveaux fichiers liés au multi-tenant (api/tenant-*.js,
// api/superuser-tenants.js). Le chemin Monday existant (api/monday.js et les autres) n'importe
// jamais ce fichier.

const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');
const schema = require('./db-schema');

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
