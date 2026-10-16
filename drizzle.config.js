// drizzle.config.js (racine du dépôt)
//
// Config Drizzle Kit — sert uniquement à générer/appliquer les migrations SQL du schéma
// (db/schema.js) vers la base Neon. Ne fait pas partie du code exécuté en production ; utilisé
// en local ou en CI via `npx drizzle-kit generate` / `npx drizzle-kit push`.

/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: './db/schema.js',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};
