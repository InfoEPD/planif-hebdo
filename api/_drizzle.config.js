// api/_drizzle.config.js
/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: './_db/schema.js',
  out: './_db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};
