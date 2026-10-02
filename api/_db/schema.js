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
  integer,
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
  // Section "Générale" de Configuration (parité EPD, voir admin.html) — gérés par l'admin du
  // tenant lui-même (contrairement aux flags ci-dessus, contrôlés par le superuser).
  companyName: text('company_name'),
  companyAddress: text('company_address'),
  // Logo encodé en data URL (base64) — stocké directement en texte (Postgres n'a pas la limite
  // de longueur des colonnes texte Monday, donc pas besoin du découpage par "chunks" utilisé
  // côté EPD).
  companyLogo: text('company_logo'),
  companyCodeAvantage: text('company_code_avantage'),
  // Durées de pause configurables (en minutes), utilisées dans computePunchHours() (api/tenant.js).
  // Défauts historiques : 15 min matin, 30 min dîner, 15 min PM (parité avec EPD/admin.html).
  pauseMatinMin: integer('pause_matin_min').notNull().default(15),
  pauseDinerMin: integer('pause_diner_min').notNull().default(30),
  pausePmMin: integer('pause_pm_min').notNull().default(15),
  // Politique de conservation (Loi 25) — configurable par le tenant (admin.html/mon-entreprise.html,
  // onglet Confidentialité). retentionGpsDays régit la purge automatique des coordonnées GPS
  // précises des poinçons (voir cron api/privacy-retention-cron.js) ; retentionPunchYears est
  // informatif seulement (aligné sur les obligations de conservation des dossiers de paie) — aucune
  // suppression automatique des poinçons eux-mêmes, seulement de leurs coordonnées GPS.
  retentionGpsDays: integer('retention_gps_days').notNull().default(400),
  retentionPunchYears: integer('retention_punch_years').notNull().default(6),
  // Réglages du module Planification (parité EPD planif.html SETTINGS_BOARD) — singleton par tenant.
  planifDefaultStart: text('planif_default_start').notNull().default('07:00'),
  planifDefaultEnd: text('planif_default_end').notNull().default('15:30'),
  planifShowWeekend: boolean('planif_show_weekend').notNull().default(false),
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
  // Coché = voit dans sa vue Mobile un bouton "Approbation" pour approuver/rejeter les feuilles
  // de temps des collègues sur le même chantier que lui, le même jour. Cette action REMPLACE
  // directement le statut du poinçon (voir punches.approvedByName/rejectionComment ci-dessous) —
  // même principe que EPD (admin.html/EMP_APPROBATEUR_COL).
  isApprover: boolean('is_approver').notNull().default(false),
  // Prime applicable par défaut pour cet employé (module Poinçon) — nullable, seulement pertinent
  // si tenant_settings.primes_enabled est activé.
  primeId: uuid('prime_id').references(() => primes.id, { onDelete: 'set null' }),
  // Horodatage du consentement explicite à la collecte GPS (Loi 25) — capturé au premier poinçon,
  // voir api/tenant.js resource 'punches' action 'start' et la modale de consentement côté mobile
  // (mon-poincon.html). Null tant que l'employé n'a pas encore acquitté la notice.
  gpsConsentAt: timestamp('gps_consent_at', { withTimezone: true }),
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
  // Parité EPD (Configuration > Restriction de projets) :
  numAvantage: text('num_avantage'), // "# Projet Avantage" — utilisé comme SCONT à l'export paie
  horsCcq: boolean('hors_ccq').notNull().default(false), // restreint les Tâches sélectionnables au poinçon aux tâches non-CCQ
  rayonM: integer('rayon_m').notNull().default(500), // rayon de tolérance GPS (mètres) pour le géorepérage
  // Parité EPD (planif.html PROJECT_START_COL/PROJECT_END_COL) — surcharge des heures par défaut
  // du module Planification pour CE projet précis (ex. chantier de nuit). Null = utilise
  // tenant_settings.planif_default_start/end.
  heureDebut: text('heure_debut'),
  heureFin: text('heure_fin'),
  // Numéro de projet affiché dans la grille/courriels de planification (distinct de num_avantage,
  // qui sert à l'export paie) — parité EPD (colonne "numero" sur l'item Projet Monday).
  numero: text('numero'),
  responsable: text('responsable'), // "Chargé de projets" — parité EPD
  // Défauts (utilisés quand project_week_overrides n'a pas de ligne pour la semaine courante) —
  // parité EPD LABOR_COL/REQUIRED_COL.
  laborActiveDefault: boolean('labor_active_default').notNull().default(true),
  requiredCountDefault: integer('required_count_default'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('projects_tenant_idx').on(t.tenantId),
}));

// Surcharges hebdomadaires par projet (parité EPD : LABOR_WEEK_COL / REQUIRED_WEEK_COL / COMMENT_COL,
// stockés en JSON sur l'item Projet Monday) — ici une ligne par (projet, semaine) plutôt que du JSON
// imbriqué, pour rester interrogeable simplement. weekKey = date ISO du lundi de la semaine visée.
const projectWeekOverrides = pgTable('project_week_overrides', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  weekKey: date('week_key').notNull(),
  requiredCount: integer('required_count'), // null = utilise la valeur par défaut du projet
  laborActive: boolean('labor_active'), // null = utilise l'état par défaut (actif)
  comment: text('comment'), // commentaire de planification figé pour cette semaine précise
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('project_week_overrides_tenant_idx').on(t.tenantId),
  uniq: uniqueIndex('project_week_overrides_uniq').on(t.projectId, t.weekKey),
}));

const jobTitles = pgTable('job_titles', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
}, (t) => ({
  tenantIdx: index('job_titles_tenant_idx').on(t.tenantId),
}));

// Tâches (parité EPD, Configuration > Métiers & Tâches) — chaque tâche appartient à un métier
// (job_title) et porte son propre statut CCQ/hors CCQ + code Avantage. Le poinçon stocke le NOM
// de la tâche choisie (voir punches.tache) plutôt qu'une référence, pour rester un instantané
// historique fidèle même si la tâche est renommée/supprimée plus tard — même convention que
// employees.jobTitle (texte, pas de FK).
const taches = pgTable('taches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  jobTitleId: uuid('job_title_id').notNull().references(() => jobTitles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  ccq: boolean('ccq').notNull().default(true),
  codeAvantage: text('code_avantage'),
}, (t) => ({
  tenantIdx: index('taches_tenant_idx').on(t.tenantId),
  jobTitleIdx: index('taches_job_title_idx').on(t.jobTitleId),
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
  // Nom de la tâche choisie par l'employé au poinçon (voir table taches) — texte figé, pas de FK
  // (parité EPD : Configuration > Métiers & Tâches détermine si CCQ/hors CCQ et le code Avantage).
  tache: text('tache'),
  // Géolocalisation capturée au moment du poinçon (obligatoire côté mobile, même principe qu'EPD).
  gpsLatIn: doublePrecision('gps_lat_in'),
  gpsLngIn: doublePrecision('gps_lng_in'),
  gpsLatOut: doublePrecision('gps_lat_out'),
  gpsLngOut: doublePrecision('gps_lng_out'),
  // Pauses cochées sur CE poinçon précis. Le champ reste stocké par poinçon (comme EPD stocke ses
  // 3 colonnes de pause par item Monday), mais le calcul de l'Ajusté se fait désormais au niveau de
  // la JOURNÉE ENTIÈRE de l'employé (voir api/tenant.js, computeDayGroup()/computeDayAdjustedHours)
  // — seul le segment ayant travaillé le plus d'heures ce jour-là ("biggest") voit ses 3 cases
  // réellement appliquées ; les autres segments du même jour sont payés neutres (= leur propre
  // brut), même convention que EPD (admin.html computeDayPayable()/saveDayGroup()).
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
  // Nom de qui a approuvé/rejeté ce poinçon — l'admin OU un employé Approbateur via mobile (même
  // champ dans les deux cas, voir employees.isApprover) — et, pour un rejet, son commentaire.
  // Affichés dans mon-entreprise.html à côté du poinçon (voir approvalInfoHtml()).
  approvedByName: text('approved_by_name'),
  rejectionComment: text('rejection_comment'),
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
  // Marqué true une fois annulé via resource 'planif' action 'historyUndo' (module Planification) —
  // empêche une seconde annulation de la même entrée. Toujours false pour les entrées créées avant
  // l'ajout du module Planification (défaut).
  undone: boolean('undone').notNull().default(false),
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

// ───────────────────────── Module Planification (tenants Postgres) — tables additionnelles ─────
// Parité avec planif.html (EPD/Monday) : voir Plan-Technique-Multi-Entite-Exacto.md. Les
// affectations jour×projet elles-mêmes vivent déjà dans schedule_entries ci-dessus (une ligne par
// employé assigné à un projet un jour donné ; plusieurs lignes pour le même employé/jour = double
// affectation, l'ordinal 1er/2e chantier se déduisant de created_at, comme côté EPD).

// Absences (vacances/congés) — parité EPD ABSENCES_BOARD.
const absences = pgTable('absences', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  label: text('label'), // ex. "Vacances", "Congé maladie" — libre, affiché dans les courriels de brouillon
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('absences_tenant_idx').on(t.tenantId),
  employeeIdx: index('absences_employee_idx').on(t.employeeId),
}));

// Instantané de l'horaire envoyé par semaine — parité EPD SCHEDULE_LOG_BOARD, sans le découpage en
// 15 colonnes de 2000 caractères (contournement de la limite Monday) : un seul champ jsonb suffit
// en Postgres. Sert à "Envoyer modifications" (diff avec l'état courant de schedule_entries).
const planifSendLog = pgTable('planif_send_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  weekKey: date('week_key').notNull(),
  snapshotJson: jsonb('snapshot_json').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('planif_send_log_tenant_idx').on(t.tenantId),
  uniq: uniqueIndex('planif_send_log_uniq').on(t.tenantId, t.weekKey),
}));

// Compétences/disciplines — configurables PAR TENANT (contrairement à EPD où les 5 disciplines
// sont codées en dur) puisque chaque entreprise cliente a ses propres corps de métier.
const competencies = pgTable('competencies', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  tenantIdx: index('competencies_tenant_idx').on(t.tenantId),
}));

const employeeCompetencies = pgTable('employee_competencies', {
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  competencyId: uuid('competency_id').notNull().references(() => competencies.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: uniqueIndex('employee_competencies_pk').on(t.employeeId, t.competencyId),
}));

// Équipement (camions, équipement de levage) — parité EPD EQUIPMENT_BOARD/LIFT_BOARD. Un
// équipement "actif" assigné à un employé fait apparaître un badge sur sa carte dans la grille,
// pour chaque jour où il est planifié.
const equipment = pgTable('equipment', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // 'camion' | 'levage'
  label: text('label'),
  marque: text('marque'),
  modele: text('modele'),
  annee: text('annee'),
  status: text('status').notNull().default('actif'), // 'actif' | 'inactif'
  employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
}, (t) => ({
  tenantIdx: index('equipment_tenant_idx').on(t.tenantId),
  employeeIdx: index('equipment_employee_idx').on(t.employeeId),
}));

// ───────────────────────── Conformité Loi 25 (universel — EPD ET tenants Postgres) ─────────────
//
// Ces 3 tables sont volontairement rattachées à `tenants.id` (qui a une ligne pour TOUS les
// tenants, y compris EPD — voir commentaire en haut de fichier) plutôt qu'aux tables opérationnelles
// spécifiques à chaque camp. Elles ne dupliquent aucune donnée métier (employés/projets/poinçons) :
// c'est une couche de conformité neuve, lue/écrite par api/privacy.js (nouveau fichier indépendant,
// n'importe ni monday.js ni tenant.js). Pour EPD, api/privacy.js résout tenantId en cherchant (ou en
// créant au premier appel) la ligne `tenants` de slug 'epd'.

const privacyIncidents = pgTable('privacy_incidents', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),
  description: text('description').notNull(),
  personsAffectedCount: integer('persons_affected_count'),
  severity: text('severity').notNull().default('faible'), // 'faible' | 'serieux'
  containmentActions: text('containment_actions'),
  reportedToCai: boolean('reported_to_cai').notNull().default(false),
  reportedToCaiAt: timestamp('reported_to_cai_at', { withTimezone: true }),
  notifiedPersons: boolean('notified_persons').notNull().default(false),
  notifiedPersonsAt: timestamp('notified_persons_at', { withTimezone: true }),
  createdByLabel: text('created_by_label'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('privacy_incidents_tenant_idx').on(t.tenantId),
}));

const privacyDataRequests = pgTable('privacy_data_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // employeeRef : employees.id (texte) pour un tenant Postgres, ou l'item Monday (EMPLOYEES_BOARD)
  // pour EPD — volontairement un champ texte libre plutôt qu'une FK, pour rester universel.
  employeeRef: text('employee_ref'),
  requesterName: text('requester_name').notNull(),
  requesterContact: text('requester_contact'),
  type: text('type').notNull(), // 'acces' | 'rectification' | 'suppression' | 'retrait_consentement'
  details: text('details'),
  status: text('status').notNull().default('ouverte'), // 'ouverte' | 'en_traitement' | 'completee'
  adminNote: text('admin_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => ({
  tenantIdx: index('privacy_data_requests_tenant_idx').on(t.tenantId),
}));

// Registre de consentement GPS — utilisé UNIQUEMENT pour EPD (les tenants Postgres stockent le
// consentement directement sur employees.gpsConsentAt, voir plus haut, pour éviter une jointure).
// Un item Monday (employeeRef) peut apparaître plusieurs fois si l'employé retire puis redonne
// son consentement — table volontairement append-only (journal), pas de mise à jour en place.
const privacyConsents = pgTable('privacy_consents', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  employeeRef: text('employee_ref').notNull(),
  employeeLabel: text('employee_label'),
  type: text('type').notNull().default('gps'),
  consentedAt: timestamp('consented_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('privacy_consents_tenant_idx').on(t.tenantId),
}));

// ───────────────────────── Identifiants employés EPD (poinçon mobile) ──────────────────────────
// Seule donnée opérationnelle EPD stockée ici plutôt que dans Monday (voir note en tête de
// fichier) : les mots de passe de connexion à l'interface mobile de poinçon (punch.html), qui a
// remplacé Clerk par une authentification maison téléphone + mot de passe. employeeItemId fait
// référence à l'item correspondant sur le board Monday "Employés" (EPD) — aucune ligne dans la
// table `employees` ci-dessus, qui reste réservée aux tenants non-EPD.

const employeeCredentials = pgTable('employee_credentials', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeItemId: text('employee_item_id').notNull(),
  passwordHash: text('password_hash').notNull(), // scrypt — voir api/_auth/employeeAuth.js
  // Force l'employé à choisir son propre mot de passe à la prochaine connexion, après que
  // l'admin en ait défini un temporaire (même logique que l'ancien setPasswordCompromised Clerk).
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by'), // libellé de l'admin ayant défini/réinitialisé ce mot de passe
}, (t) => ({
  employeeItemIdx: uniqueIndex('employee_credentials_employee_item_idx').on(t.employeeItemId),
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
  taches,
  primes,
  punches,
  tenantMessages,
  scheduleEntries,
  historyLog,
  holidays,
  projectWeekOverrides,
  absences,
  planifSendLog,
  competencies,
  employeeCompetencies,
  equipment,
  privacyIncidents,
  privacyDataRequests,
  privacyConsents,
  employeeCredentials,
  superuserAuditLog,
};
