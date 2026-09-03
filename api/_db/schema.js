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
  clerkUserId: text('clerk_user_id'), // lien vers le compte Clerk correspondant (accès mobile)
  employeeNumber: text('employee_number'), // numéro d'employé (export paie)
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
  status: text('status').notNull().default('ouvert'), // ouvert | ferme | auto_ferme
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('punches_tenant_idx').on(t.tenantId),
  employeeIdx: index('punches_employee_idx').on(t.employeeId),
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
  scheduleEntries,
  historyLog,
  holidays,
  superuserAuditLog,
};
