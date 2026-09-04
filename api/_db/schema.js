// db/schema.js
//
// Schéma Drizzle (Postgres / Neon) pour la conversion multi-entité de Exacto.
// Voir Plan-Technique-Multi-Entite-Exacto.md pour le contexte complet.
//
// IMPORTANT — ce que cette base contient et ne contient PAS :
//   - La table `tenants` + `tenant_settings` existe pour TOUS les tenants, y compris EPD (registre
//     léger : nom, statut, fonctionnalités activées). EPD y a une ligne même si ses données
//     opérationnelles restent 100% dans Monday.
//   - Les tables opérationnelles (employees, projects, punches, schedule_entries, history_log,
//     holidays) ne sont peuplées QUE pour les tenants non-EPD (ceux qui n'ont pas leur propre
//     Monday). EPD continue d'utiliser exclusivement ses boards Monday pour ces données — rien
//     ici ne les duplique ni ne les remplace.
//
// Ce fichier ne modifie et ne dépend d'AUCUN fichier existant (admin.html, planif.html,
// api/monday.js, etc.) — nouvelle base de données, nouveau chemin, entièrement additif.

const {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  doublePrecision,
} = require('drizzle-orm/pg-core');

// ───────────────────────── Registre des tenants (universel, y compris EPD) ─────────────────────

const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // 'epd' est réservé — EPD garde son chemin Monday, cette ligne sert seulement de registre.
  slug: text('slug').notNull(),
  status: text('status').notNull().default('active'), // 'active' | 'suspended'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  slugIdx: uniqueIndex('tenants_slug_idx').on(t.slug),
}));

const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('America/Toronto'),
  // "Entreprise de la construction" — active la classification CCQ/hors-CCQ, temps et demi/double.
  ccqEnabled: boolean('ccq_enabled').notNull().default(false),
  // "Gestion de primes applicables" — active le module Primes.
  primesEnabled: boolean('primes_enabled').notNull().default(false),
  // Logiciel de paie choisi. Une seule valeur supportée pour l'instant : 'avantage'.
  payrollSoftware: text('payroll_software'), // 'avantage' | null
  // Accès au module Planification — coché par le superuser, pas par le tenant lui-même.
  planifEnabled: boolean('planif_enabled').notNull().default(false),
});

const primes = pgTable('primes', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  percentage: text('percentage'), // ex. "50" pour 1.5x, "100" pour 2x — texte pour rester flexible
  code: text('code'),
}, (t) => ({
  tenantIdx: index('primes_tenant_idx').on(t.tenantId),
}));

// ───────────────────────── Données opérationnelles (tenants Postgres seulement) ────────────────

const employees = pgTable('employees', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  email: text('email'),
  jobTitle: text('job_title'),
  status: text('status').notNull().default('actif'), // 'actif' | 'inactif'
  clerkUserId: text('clerk_user_id'), // lien vers le compte Clerk correspondant (accès poinçon mobile)
  employeeNumber: text('employee_number'), // numéro d'employé (export paie)
  // Adresse domicile (géocodée, même mécanisme que les projets) — utilisée pour le calcul de
  // distance domicile-chantier dans le module Poinçon (Phase 5).
  address: text('address'),
  homeLat: doublePrecision('home_lat'),
  homeLng: doublePrecision('home_lng'),
  excludeFromPayroll: boolean('exclude_from_payroll').notNull().default(false),
  // Prime applicable par défaut pour cet employé (module Poinçon) — nullable, seulement pertinent
  // si tenant_settings.primes_enabled est activé.
  primeId: uuid('prime_id').references(() => primes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('employees_tenant_idx').on(t.tenantId),
}));

const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code'),
  address: text('address'),
  // Coordonnées capturées via la recherche d'adresse (Nominatim/OpenStreetMap) au moment de la
  // sélection — garantit que l'adresse correspond à un lieu géolocalisable réel, requis pour le
  // futur module Planification (distances, géorepérage). Null seulement pour les anciens projets
  // créés avant l'ajout de cette validation.
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  status: text('status').notNull().default('en_planification'), // en_planification | en_cours | termine
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('projects_tenant_idx').on(t.tenantId),
}));

const jobTitles = pgTable('job_titles', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
}, (t) => ({
  tenantIdx: index('job_titles_tenant_idx').on(t.tenantId),
}));

const punches = pgTable('punches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id),
  clockIn: timestamp('clock_in', { withTimezone: true }),
  clockOut: timestamp('clock_out', { withTimezone: true }),
  // ouvert (en cours) | ferme (en attente d'approbation) | auto_ferme (fermé par le cron d'oubli) |
  // approuve | rejete | exporte (verrouillé après un export de paie — voir Phase 5e)
  status: text('status').notNull().default('ouvert'),
  // Géolocalisation capturée au moment du poinçon (obligatoire côté mobile, même principe qu'EPD).
  gpsLatIn: doublePrecision('gps_lat_in'),
  gpsLngIn: doublePrecision('gps_lng_in'),
  gpsLatOut: doublePrecision('gps_lat_out'),
  gpsLngOut: doublePrecision('gps_lng_out'),
  // Pauses prises pendant le quart — gérées au niveau du poinçon pour la V1 (contrairement à EPD où
  // c'est géré au niveau de la journée ; simplification volontaire, ajustable plus tard si besoin).
  breakMorning: boolean('break_morning').notNull().default(false),
  breakLunch: boolean('break_lunch').notNull().default(false),
  breakAfternoon: boolean('break_afternoon').notNull().default(false),
  // Heures supplémentaires — ajustables manuellement par l'admin (comme EPD), pertinent seulement
  // si tenant_settings.ccq_enabled est activé.
  overtime15: doublePrecision('overtime_15'), // temps et demi
  overtime2: doublePrecision('overtime_2'),   // temps double
  // Distance domicile-chantier (calculée à vol d'oiseau à partir de employees.home_lat/lng et
  // projects.lat/lng — pas de matrice routière OSRM dédiée pour les tenants en V1).
  kmTraveled: doublePrecision('km_traveled'),
  primeApplied: boolean('prime_applied').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('punches_tenant_idx').on(t.tenantId),
  employeeIdx: index('punches_employee_idx').on(t.employeeId),
}));

const tenantMessages = pgTable('tenant_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  author: text('author').notNull(), // 'employee' | 'admin'
  body: text('body').notNull(),
  readByAdmin: boolean('read_by_admin').notNull().default(false),
  readByEmployee: boolean('read_by_employee').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('tenant_messages_tenant_idx').on(t.tenantId),
  employeeIdx: index('tenant_messages_employee_idx').on(t.employeeId),
}));

const scheduleEntries = pgTable('schedule_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id),
  workDate: date('work_date').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('schedule_entries_tenant_idx').on(t.tenantId),
}));

const historyLog = pgTable('history_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  weekKey: text('week_key').notNull(),
  userLabel: text('user_label'),
  description: text('description'),
  diffJson: jsonb('diff_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('history_log_tenant_idx').on(t.tenantId),
}));

const holidays = pgTable('holidays', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  label: text('label'),
}, (t) => ({
  tenantIdx: index('holidays_tenant_idx').on(t.tenantId),
}));

// ───────────────────────── Superuser (gestion de plateforme) ───────────────────────────────────

const superuserAuditLog = pgTable('superuser_audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorClerkUserId: text('actor_clerk_user_id').notNull(),
  actorLabel: text('actor_label'),
  action: text('action').notNull(), // 'create_tenant' | 'update_settings' | 'set_status' | 'create_first_admin'
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
  details: jsonb('details'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

module.exports = {
  tenants,
  tenantSettings,
  employees,
  projects,
  jobTitles,
  primes,
  punches,
  tenantMessages,
  scheduleEntries,
  historyLog,
  holidays,
  superuserAuditLog,
};
