// api/punch.js
// Début / changement de chantier / fin de poinçon (interface mobile employé). Écrit dans le
// board Monday "⏱️ Poinçons". Nécessite un jeton de session Clerk avec publicMetadata.role
// === 'employee' (voir api/employee-today.js pour la note de configuration Clerk requise).
//
// Convention CCQ commerciale (Québec) utilisée pour ajuster le total payable :
//   - Dîner (30 min) : pris = 30 min déduites du temps écoulé (pause non payée) ; NON pris =
//     AUCUNE déduction (l'employé a travaillé pendant sa pause, donc payé pour ce temps —
//     par rapport au cas "pris", cela revient à "ajouter" les 30 min qui auraient sinon été
//     déduites, mais l'ajustement lui-même reste neutre, jamais positif).
//   - Pause matin (15 min) et pause après-midi (15 min) : payées, donc normalement non
//     déduites. Si NON prises, on AJOUTE 15 min au total payable (l'employé a soit
//     travaillé pendant la pause, soit quitté plus tôt sans la prendre).
//   - Le total payable est ensuite arrondi au 15 minutes le plus proche (haut ou bas).
//   - Cette déduction/ajustement ne s'applique qu'UNE SEULE FOIS par journée, sur le
//     dernier segment de travail (voir action 'switch' ci-dessous pour les changements
//     de chantier en cours de journée — un employé peut avoir plusieurs poinçons/segments
//     le même jour, un par chantier).
//
// Actions (réservées aux comptes employés, role === 'employee') :
//   gpsConsentStatus — Loi 25 : dernier consentement GPS connu (affichage de la modale).
//   recordGpsConsent — Loi 25 : acquitte le consentement GPS (écran "Mes données").
//   myDataExport     — Loi 25 : export complet des données personnelles de l'employé.
//   start  — débute un poinçon sur un projet.
//   switch — change de chantier en cours de poinçon : ferme le segment actif (heure de fin
//            arrondie au 15 min le plus proche) et ouvre immédiatement un nouveau segment sur
//            le nouveau projet à CETTE MÊME heure arrondie (aucune seconde perdue/dupliquée).
//   finish — termine la journée : calcule le total payable sur l'ENSEMBLE des segments du
//            jour (tous chantiers confondus) et applique la déduction/ajustement des pauses
//            une seule fois, imputée au dernier segment.
//
// La géolocalisation (lat/lng) est OBLIGATOIRE pour start/switch/finish — validée ici côté
// serveur pour qu'elle ne puisse pas être contournée depuis le client.
//
// Ressources Loi 25 (fusionnées depuis l'ancien api/privacy.js, pour rester sous la limite de
// 12 fonctions Serverless du plan Vercel Hobby — voir aussi api/tenant.js resource
// 'settings'/'incidents'/'dataRequests' pour l'équivalent côté tenants Postgres). Body :
// { resource, action, ...params }. Vérifiées AVANT le verrou "employé" ci-dessous puisque
// réservées aux comptes admin/lecture-seule (sauf dataRequests/create, ouvert aux employés) :
//
//   resource: 'settings'   — action: get {} | update { retentionGpsDays, retentionPunchYears } (admin)
//   resource: 'incidents'  — action: list {} (admin/lecture-seule) | create {...} | update { id, patch } (admin)
//   resource: 'dataRequests' — action: create {...} (admin OU employé — employeeRef forcé à son
//                              propre id pour un employé) | listAll {} (admin/lecture-seule) |
//                              update { id, patch } (admin)

const { verifyToken } = require('@clerk/backend');
// Utilisé par les actions Loi 25 (gpsConsentStatus/recordGpsConsent/myDataExport, et les
// ressources 'settings'/'incidents'/'dataRequests' fusionnées depuis l'ancien api/privacy.js —
// voir plus bas) — le reste de ce fichier continue de fonctionner à 100% avec Monday, sans base
// Postgres. Voir db/schema.js (privacyConsents/privacyIncidents/privacyDataRequests).
const { eq, and, desc } = require('drizzle-orm');
const { getDb, schema } = require('./_db/client');

const POINCONS_BOARD = 18427410930;
const COL_EMPLOYE = 'board_relation_mm6d1zaz';
const COL_PROJET = 'board_relation_mm6ddgy';
const COL_DATE = 'date_mm6d1p6e';
const COL_SEMAINE = 'text_mm6d1bk5';
const COL_HEURE_DEBUT = 'hour_mm6dfaha';
const COL_HEURE_FIN = 'hour_mm6dfqfg';
const COL_GPS_DEBUT = 'text_mm6d2r65';
const COL_GPS_FIN = 'text_mm6ddr4z';
const COL_MATIN_NON_PRISE = 'boolean_mm6dbmf2';
const COL_RAISON_MATIN = 'text_mm6dp8f9';
const COL_DINER_NON_PRIS = 'boolean_mm6dczby';
const COL_RAISON_DINER = 'text_mm6djdex';
const COL_PM_PRISE = 'boolean_mm6dpdmf';
const COL_TOTAL_BRUT = 'numeric_mm6d12a7';
const COL_TOTAL_AJUSTE = 'numeric_mm6d8c9m';
const COL_KM_SUGGERE = 'numeric_mm6d4hvv';
const COL_KM_AJUSTE = 'numeric_mm6dxafw';
const COL_STATUT = 'color_mm6dxpt7';
// Nom de qui a approuvé/rejeté (admin OU employé Approbateur mobile — même champ, voir
// admin.html/wireDetailEvents()) et commentaire de rejet. Voir actions 'listForApproval'/
// 'submitApproval' ci-dessous.
const COL_APPROVED_BY = 'text_mm73nqaw';
const COL_REJECTION_COMMENT = 'text_mm73cjt0';
// Nom de la Tâche choisie par l'employé (copie figée en texte — voir admin-poincon.html /
// api/employee-today.js pour la Configuration Métiers/Tâches).
const COL_TACHE = 'text_mm6enx2b';

// Board Employés — utilisé pour vérifier server-side qu'un employé est bien "Approbateur"
// (EMP_APPROBATEUR_COL) avant de lui permettre d'approuver/rejeter les poinçons de collègues,
// et pour retrouver son propre nom (affiché comme COL_APPROVED_BY). Mêmes IDs que admin.html.
const EMPLOYEES_BOARD = 8371777574;
const EMP_APPROBATEUR_COL = 'boolean_mm73h61q';

async function isApprobateur(mondayToken, employeeItemId) {
  const data = await mondayGraphQL(mondayToken, `
    query($ids: [ID!]) { items(ids: $ids) { id name column_values(ids: ["${EMP_APPROBATEUR_COL}"]) { id text } } }
  `, { ids: [String(employeeItemId)] });
  const it = (data.items || [])[0];
  if (!it) return { ok: false, name: '' };
  const cv = (it.column_values || []).find(c => c.id === EMP_APPROBATEUR_COL);
  return { ok: !!(cv && cv.text === 'v'), name: it.name || '' };
}

// Validation serveur du projet (voir audit du 26 août 2026, point #6) : le client (mobile) ne
// propose que les projets actifs dans sa liste déroulante, mais rien n'empêchait auparavant un
// appel direct à l'API d'assigner un poinçon à N'IMPORTE QUEL item de Monday (projet terminé,
// inexistant, ou même un item d'un autre board). Même board/colonne que employee-today.js.
const PROJECTS_BOARD = 8371776057;
const PROJECT_STAGE_COL = 'status3';
const PROJECT_ACTIVE_LABEL = 'Projet en cours';

async function isProjectActive(mondayToken, projectId) {
  if (!projectId) return false;
  const detail = await mondayGraphQL(mondayToken, `
    query($ids: [ID!]) {
      items(ids: $ids) { id board { id } column_values(ids: ["${PROJECT_STAGE_COL}"]) { id text } }
    }
  `, { ids: [String(projectId)] });
  const item = (detail.items || [])[0];
  if (!item || String((item.board || {}).id) !== String(PROJECTS_BOARD)) return false;
  const stageCv = (item.column_values || []).find(c => c.id === PROJECT_STAGE_COL);
  return !!(stageCv && stageCv.text === PROJECT_ACTIVE_LABEL);
}

function nowInToronto() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { date: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour === '24' ? '0' : map.hour), minute: Number(map.minute) };
}

function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=dim
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function round15(minutes) {
  return Math.round(minutes / 15) * 15;
}

// Arrondit une HEURE DE L'HORLOGE (pas une durée) au 15 minutes le plus proche.
function roundClockToNearest15(hour, minute) {
  const total = hour * 60 + minute;
  const rounded = Math.round(total / 15) * 15;
  const wrapped = ((rounded % 1440) + 1440) % 1440;
  return { hour: Math.floor(wrapped / 60), minute: wrapped % 60 };
}

function isValidCoord(v) { return typeof v === 'number' && isFinite(v); }

// Écart maximal toléré entre l'horloge du téléphone (clientTimestamp, ms epoch envoyés par
// pointeuse.html) et l'heure réelle du serveur, avant de refuser le poinçon. Ceci ne peut pas
// forcer le réglage "Date et heure automatiques" du téléphone, mais empêche un employé d'avancer
// ou de reculer manuellement l'heure de son appareil pour poinçonner à un moment différent de la
// réalité — la validation ci-dessous est faite avec l'heure du SERVEUR, non contournable.
const MAX_CLOCK_DRIFT_MS = 3 * 60 * 1000; // 3 minutes

function checkClientClock(clientTimestamp) {
  if (typeof clientTimestamp !== 'number' || !isFinite(clientTimestamp) || clientTimestamp <= 0) {
    return "Impossible de valider l'heure de votre téléphone. Veuillez réessayer.";
  }
  const drift = Math.abs(Date.now() - clientTimestamp);
  if (drift > MAX_CLOCK_DRIFT_MS) {
    return "L'heure de votre téléphone ne correspond pas à l'heure réelle. Veuillez activer \"Date et heure automatiques\" dans les réglages de votre téléphone, puis réessayer.";
  }
  return null;
}

// Résout (ou crée au premier appel) la ligne `tenants` réservée à EPD — voir api/privacy.js pour
// la même logique côté admin/superuser. Nécessaire parce que ce fichier (100% Monday par ailleurs)
// écrit le consentement GPS dans la table Postgres universelle privacy_consents.
async function resolveEpdTenantId(db) {
  const existing = await db.select().from(schema.tenants).where(eq(schema.tenants.slug, 'epd'));
  if (existing.length) return existing[0].id;
  const [created] = await db.insert(schema.tenants).values({ name: 'EPD', slug: 'epd', status: 'active' }).returning();
  await db.insert(schema.tenantSettings).values({ tenantId: created.id });
  return created.id;
}

async function mondayGraphQL(mondayToken, query, variables) {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': mondayToken, 'API-Version': '2023-10' },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

// Durées de pause configurables (voir admin.html → Configuration → Pauses). Stockées sur le
// même board/item que le reste de la config générale (nom entreprise, logo, etc.). Valeurs par
// défaut historiques si la colonne est vide (nouvelle colonne jamais renseignée) ou si l'appel
// échoue pour une raison quelconque — on ne veut jamais bloquer un poinçon pour ça.
const CONFIG_BOARD = 18427580797;
const CONFIG_ITEM_ID = 12863190818;
const CONFIG_PAUSE_MATIN = 'numeric_mm6wxthw';
const CONFIG_PAUSE_DINER = 'numeric_mm6wvwhc';
const CONFIG_PAUSE_PM = 'numeric_mm6w7450';
const DEFAULT_PAUSE_MATIN_MIN = 15;
const DEFAULT_PAUSE_DINER_MIN = 30;
const DEFAULT_PAUSE_PM_MIN = 15;

async function loadPauseConfig(mondayToken) {
  try {
    const data = await mondayGraphQL(mondayToken, `
      query($ids: [ID!]) { items(ids: $ids) { id column_values(ids: ["${CONFIG_PAUSE_MATIN}", "${CONFIG_PAUSE_DINER}", "${CONFIG_PAUSE_PM}"]) { id text } } }
    `, { ids: [String(CONFIG_ITEM_ID)] });
    const it = (data.items || [])[0];
    const cvArr = (it && it.column_values) || [];
    const find = (id) => { const c = cvArr.find(x => x.id === id); return c && c.text; };
    const matinText = find(CONFIG_PAUSE_MATIN);
    const dinerText = find(CONFIG_PAUSE_DINER);
    const pmText = find(CONFIG_PAUSE_PM);
    return {
      matin: (matinText !== undefined && matinText !== null && matinText !== '') ? Number(matinText) : DEFAULT_PAUSE_MATIN_MIN,
      diner: (dinerText !== undefined && dinerText !== null && dinerText !== '') ? Number(dinerText) : DEFAULT_PAUSE_DINER_MIN,
      pm: (pmText !== undefined && pmText !== null && pmText !== '') ? Number(pmText) : DEFAULT_PAUSE_PM_MIN
    };
  } catch (err) {
    return { matin: DEFAULT_PAUSE_MATIN_MIN, diner: DEFAULT_PAUSE_DINER_MIN, pm: DEFAULT_PAUSE_PM_MIN };
  }
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
  // Garde multi-tenant : ce fichier est réservé aux comptes EPD (voir Plan-Technique-Multi-Entite-Exacto.md).
  // Un tenantId défini et différent de 'EPD' n'a pas accès ici.
  if (claims.tenantId && claims.tenantId !== 'EPD') {
    res.status(403).json({ error: "Ce compte n'a pas accès à cette application." });
    return;
  }
  const meta = claims || {};
  const { action, resource } = req.body || {};

  // ───────── Confidentialité (Loi 25) : settings/incidents/dataRequests (fusionné depuis
  // l'ancien api/privacy.js) — vérifié AVANT le verrou "employé" ci-dessous puisque ces
  // ressources sont réservées aux comptes admin/lecture-seule (sauf dataRequests/create).
  if (resource === 'settings' || resource === 'incidents' || resource === 'dataRequests') {
    const isAdminRole = meta.role === 'admin';
    const isAdminOrReadOnly = isAdminRole || meta.role === 'lecture-seule';
    try {
      const db = getDb();
      const tenantId = await resolveEpdTenantId(db);

      if (resource === 'settings') {
        if (!isAdminOrReadOnly) { res.status(403).json({ error: 'Accès réservé aux administrateurs.' }); return; }
        if (action === 'get') {
          const [row] = await db.select().from(schema.tenantSettings).where(eq(schema.tenantSettings.tenantId, tenantId));
          res.status(200).json({ retentionGpsDays: row ? row.retentionGpsDays : 400, retentionPunchYears: row ? row.retentionPunchYears : 6 });
          return;
        }
        if (action === 'update') {
          if (!isAdminRole) { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
          const { retentionGpsDays, retentionPunchYears } = req.body || {};
          const patch = {};
          if (retentionGpsDays !== undefined) {
            const n = Number(retentionGpsDays);
            if (!Number.isFinite(n) || n < 30) { res.status(400).json({ error: 'retentionGpsDays doit être un nombre de jours ≥ 30.' }); return; }
            patch.retentionGpsDays = Math.round(n);
          }
          if (retentionPunchYears !== undefined) {
            const n = Number(retentionPunchYears);
            if (!Number.isFinite(n) || n < 1) { res.status(400).json({ error: "retentionPunchYears doit être un nombre d'années ≥ 1." }); return; }
            patch.retentionPunchYears = Math.round(n);
          }
          if (Object.keys(patch).length) await db.update(schema.tenantSettings).set(patch).where(eq(schema.tenantSettings.tenantId, tenantId));
          res.status(200).json({ ok: true });
          return;
        }
      }

      if (resource === 'incidents') {
        if (!isAdminOrReadOnly) { res.status(403).json({ error: 'Accès réservé aux administrateurs.' }); return; }
        if (action === 'list') {
          const rows = await db.select().from(schema.privacyIncidents)
            .where(eq(schema.privacyIncidents.tenantId, tenantId))
            .orderBy(desc(schema.privacyIncidents.discoveredAt));
          res.status(200).json({ incidents: rows });
          return;
        }
        if (!isAdminRole) { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
        if (action === 'create') {
          const { description, occurredAt, personsAffectedCount, severity, containmentActions } = req.body || {};
          if (!description) { res.status(400).json({ error: 'La description est requise.' }); return; }
          const sev = ['faible', 'serieux'].includes(severity) ? severity : 'faible';
          const [row] = await db.insert(schema.privacyIncidents).values({
            tenantId,
            description,
            occurredAt: occurredAt ? new Date(occurredAt) : null,
            personsAffectedCount: personsAffectedCount != null ? Number(personsAffectedCount) : null,
            severity: sev,
            containmentActions: containmentActions || null,
            createdByLabel: meta.name || meta.email || meta.sub || null,
          }).returning();
          res.status(200).json({ ok: true, incident: row });
          return;
        }
        if (action === 'update') {
          const { id, patch } = req.body || {};
          if (!id || !patch) { res.status(400).json({ error: 'id et patch sont requis.' }); return; }
          const safePatch = {};
          if (patch.severity !== undefined) {
            if (!['faible', 'serieux'].includes(patch.severity)) { res.status(400).json({ error: 'severity invalide.' }); return; }
            safePatch.severity = patch.severity;
          }
          if (patch.containmentActions !== undefined) safePatch.containmentActions = patch.containmentActions;
          if (patch.reportedToCai !== undefined) {
            safePatch.reportedToCai = !!patch.reportedToCai;
            safePatch.reportedToCaiAt = patch.reportedToCai ? new Date() : null;
          }
          if (patch.notifiedPersons !== undefined) {
            safePatch.notifiedPersons = !!patch.notifiedPersons;
            safePatch.notifiedPersonsAt = patch.notifiedPersons ? new Date() : null;
          }
          await db.update(schema.privacyIncidents).set(safePatch)
            .where(and(eq(schema.privacyIncidents.id, id), eq(schema.privacyIncidents.tenantId, tenantId)));
          res.status(200).json({ ok: true });
          return;
        }
      }

      if (resource === 'dataRequests') {
        if (action === 'create') {
          // Ouvert aux admins ET aux employés (écran "Mes données" de punch.html/pointeuse.html).
          let employeeRef = (req.body || {}).employeeRef || null;
          if (meta.role === 'employee') {
            if (!meta.employeeItemId) { res.status(403).json({ error: "Ce compte n'a pas accès." }); return; }
            employeeRef = String(meta.employeeItemId); // jamais la valeur du client pour un employé
          } else if (!isAdminOrReadOnly) {
            res.status(403).json({ error: 'Non autorisé.' }); return;
          }
          const { requesterName, requesterContact, type, details } = req.body || {};
          if (!requesterName || !['acces', 'rectification', 'suppression', 'retrait_consentement'].includes(type)) {
            res.status(400).json({ error: 'requesterName et un type valide sont requis.' });
            return;
          }
          const [row] = await db.insert(schema.privacyDataRequests).values({
            tenantId, employeeRef, requesterName, requesterContact: requesterContact || null, type, details: details || null,
          }).returning();
          res.status(200).json({ ok: true, request: row });
          return;
        }
        if (!isAdminOrReadOnly) { res.status(403).json({ error: 'Accès réservé aux administrateurs.' }); return; }
        if (action === 'listAll') {
          const rows = await db.select().from(schema.privacyDataRequests)
            .where(eq(schema.privacyDataRequests.tenantId, tenantId))
            .orderBy(desc(schema.privacyDataRequests.createdAt));
          res.status(200).json({ requests: rows });
          return;
        }
        if (action === 'update') {
          if (!isAdminRole) { res.status(403).json({ error: 'Accès en lecture seule — modification non autorisée.' }); return; }
          const { id, patch } = req.body || {};
          if (!id || !patch) { res.status(400).json({ error: 'id et patch sont requis.' }); return; }
          const safePatch = {};
          if (patch.status !== undefined) {
            if (!['ouverte', 'en_traitement', 'completee'].includes(patch.status)) { res.status(400).json({ error: 'status invalide.' }); return; }
            safePatch.status = patch.status;
            if (patch.status === 'completee') safePatch.resolvedAt = new Date();
          }
          if (patch.adminNote !== undefined) safePatch.adminNote = patch.adminNote;
          await db.update(schema.privacyDataRequests).set(safePatch)
            .where(and(eq(schema.privacyDataRequests.id, id), eq(schema.privacyDataRequests.tenantId, tenantId)));
          res.status(200).json({ ok: true });
          return;
        }
      }

      res.status(400).json({ error: 'Action inconnue.' });
      return;
    } catch (err) {
      const msg = (err && err.errors && err.errors[0] && err.errors[0].message) || err.message || String(err);
      res.status(502).json({ error: 'Erreur: ' + msg });
      return;
    }
  }

  if (meta.role !== 'employee' || !meta.employeeItemId) {
    res.status(403).json({ error: "Ce compte n'a pas accès à l'interface de poinçon." });
    return;
  }
  const employeeItemId = String(meta.employeeItemId);

  try {
    // Loi 25 — statut de consentement GPS actuel (appelé au démarrage de punch.html/pointeuse.html
    // pour décider s'il faut afficher la modale de consentement). Lecture seule, peu coûteuse.
    if (action === 'gpsConsentStatus') {
      try {
        const db = getDb();
        const tenantId = await resolveEpdTenantId(db);
        const rows = await db.select().from(schema.privacyConsents).where(eq(schema.privacyConsents.tenantId, tenantId));
        const mine = rows.filter(r => r.employeeRef === String(employeeItemId) && r.type === 'gps')
          .sort((a, b) => new Date(b.consentedAt) - new Date(a.consentedAt));
        res.status(200).json({ gpsConsentAt: mine.length ? mine[0].consentedAt : null });
      } catch (err) {
        res.status(200).json({ gpsConsentAt: null });
      }
      return;
    }

    // Loi 25 — consentement explicite à la collecte GPS, acquitté une fois via la modale de
    // punch.html/pointeuse.html avant le tout premier poinçon. Journalisé dans la table Postgres
    // universelle privacy_consents (voir db/schema.js) — ré-appelable sans effet de bord néfaste
    // (ajoute simplement une nouvelle entrée de journal).
    if (action === 'recordGpsConsent') {
      const db = getDb();
      const tenantId = await resolveEpdTenantId(db);
      let employeeLabel = null;
      try {
        const data = await mondayGraphQL(mondayToken, `query($ids: [ID!]) { items(ids: $ids) { id name } }`, { ids: [String(employeeItemId)] });
        employeeLabel = ((data.items || [])[0] || {}).name || null;
      } catch (err) { /* best effort — n'empêche pas d'enregistrer le consentement */ }
      await db.insert(schema.privacyConsents).values({
        tenantId, employeeRef: employeeItemId, employeeLabel, type: 'gps',
      });
      res.status(200).json({ ok: true });
      return;
    }

    // Loi 25 — droit d'accès en libre-service : l'employé télécharge lui-même l'ensemble de ses
    // renseignements personnels détenus par Exacto (nom, poinçons avec coordonnées GPS). Utilisé
    // par l'écran "Mes données" de punch.html/pointeuse.html.
    if (action === 'myDataExport') {
      const profData = await mondayGraphQL(mondayToken, `query($ids: [ID!]) { items(ids: $ids) { id name } }`, { ids: [String(employeeItemId)] });
      const employeeName = ((profData.items || [])[0] || {}).name || '';

      const histData = await mondayGraphQL(mondayToken, `
        query($board: [ID!], $empId: CompareValue!, $empCol: ID!) {
          boards(ids: $board) {
            items_page(query_params: { rules: [{ column_id: $empCol, compare_value: $empId, operator: any_of }], order_by: [{ column_id: "${COL_DATE}", direction: desc }] }, limit: 500) {
              items {
                id
                column_values(ids: ["${COL_PROJET}", "${COL_DATE}", "${COL_HEURE_DEBUT}", "${COL_HEURE_FIN}", "${COL_GPS_DEBUT}", "${COL_GPS_FIN}", "${COL_TOTAL_AJUSTE}", "${COL_STATUT}"]) {
                  id text
                  ... on BoardRelationValue { linked_items { id name } }
                  ... on HourValue { hour minute }
                }
              }
            }
          }
        }
      `, { board: [String(POINCONS_BOARD)], empId: [Number(employeeItemId)], empCol: COL_EMPLOYE });

      const items = ((histData.boards[0] && histData.boards[0].items_page.items) || []);
      const punches = items.map(it => {
        const cv = {};
        (it.column_values || []).forEach(c => { cv[c.id] = c; });
        const proj = (cv[COL_PROJET] && cv[COL_PROJET].linked_items && cv[COL_PROJET].linked_items[0]) || null;
        const hd = cv[COL_HEURE_DEBUT], hf = cv[COL_HEURE_FIN];
        return {
          date: (cv[COL_DATE] && cv[COL_DATE].text) || '',
          projectName: proj ? proj.name : '',
          heureDebut: (hd && hd.hour != null) ? `${String(hd.hour).padStart(2, '0')}:${String(hd.minute).padStart(2, '0')}` : '',
          heureFin: (hf && hf.hour != null) ? `${String(hf.hour).padStart(2, '0')}:${String(hf.minute).padStart(2, '0')}` : '',
          gpsDebut: (cv[COL_GPS_DEBUT] && cv[COL_GPS_DEBUT].text) || '',
          gpsFin: (cv[COL_GPS_FIN] && cv[COL_GPS_FIN].text) || '',
          totalAjuste: (cv[COL_TOTAL_AJUSTE] && cv[COL_TOTAL_AJUSTE].text) || '',
          statut: (cv[COL_STATUT] && cv[COL_STATUT].text) || 'En attente',
        };
      });

      let gpsConsentAt = null;
      try {
        const db = getDb();
        const tenantId = await resolveEpdTenantId(db);
        const rows = await db.select().from(schema.privacyConsents)
          .where(eq(schema.privacyConsents.tenantId, tenantId));
        const mine = rows.filter(r => r.employeeRef === String(employeeItemId) && r.type === 'gps')
          .sort((a, b) => new Date(b.consentedAt) - new Date(a.consentedAt));
        if (mine.length) gpsConsentAt = mine[0].consentedAt;
      } catch (err) { /* informatif seulement */ }

      res.status(200).json({
        exportedAt: new Date().toISOString(),
        profile: { fullName: employeeName, gpsConsentAt },
        punches,
      });
      return;
    }

    if (action === 'start') {
      const { projectId, tache, lat, lng, kmSuggested, clientTimestamp } = req.body || {};
      if (!projectId) { res.status(400).json({ error: 'Projet manquant.' }); return; }
      if (!tache || !String(tache).trim()) { res.status(400).json({ error: 'Tâche manquante.' }); return; }
      if (!isValidCoord(lat) || !isValidCoord(lng)) {
        res.status(400).json({ error: 'Localisation (GPS) requise pour débuter un poinçon. Veuillez activer la localisation.' });
        return;
      }
      const clockError = checkClientClock(clientTimestamp);
      if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
      if (!(await isProjectActive(mondayToken, projectId))) {
        res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
        return;
      }
      const now = nowInToronto();

      // Éviter un doublon si l'employé a déjà un poinçon ouvert aujourd'hui.
      const existing = await mondayGraphQL(mondayToken, `
        query($board: ID!, $dateCol: String!, $date: [String]!) {
          items_page_by_column_values(board_id: $board, columns: [{ column_id: $dateCol, column_values: $date }], limit: 50) {
            items { id column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_FIN}"]) { id text ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      `, { board: String(POINCONS_BOARD), dateCol: COL_DATE, date: [now.date] });

      const openItem = (existing.items_page_by_column_values.items || []).find(it => {
        const empCv = (it.column_values || []).find(c => c.id === COL_EMPLOYE);
        const finCv = (it.column_values || []).find(c => c.id === COL_HEURE_FIN);
        const ids = (empCv && empCv.linked_item_ids) || [];
        return ids.map(String).includes(employeeItemId) && (!finCv || !finCv.text);
      });
      if (openItem) {
        res.status(200).json({ itemId: openItem.id, resumed: true });
        return;
      }

      const columnValues = {
        [COL_EMPLOYE]: { item_ids: [Number(employeeItemId)] },
        [COL_PROJET]: { item_ids: [Number(projectId)] },
        [COL_DATE]: { date: now.date },
        [COL_SEMAINE]: mondayOfWeek(now.date),
        [COL_HEURE_DEBUT]: { hour: now.hour, minute: now.minute },
        [COL_GPS_DEBUT]: `${lat},${lng}`,
        [COL_STATUT]: { label: 'En attente' },
        [COL_TACHE]: String(tache).trim()
      };
      if (typeof kmSuggested === 'number') columnValues[COL_KM_SUGGERE] = kmSuggested;

      const created = await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $name: String!, $cv: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), name: `Poinçon ${now.date}`, cv: JSON.stringify(columnValues) });

      res.status(200).json({ itemId: created.create_item.id, resumed: false, startedAt: now });
      return;
    }

    if (action === 'switch') {
      const { itemId, newProjectId, tache, lat, lng, clientTimestamp } = req.body || {};
      if (!itemId || !newProjectId) { res.status(400).json({ error: 'Poinçon ou nouveau projet manquant.' }); return; }
      if (!tache || !String(tache).trim()) { res.status(400).json({ error: 'Tâche manquante.' }); return; }
      if (!isValidCoord(lat) || !isValidCoord(lng)) {
        res.status(400).json({ error: 'Localisation (GPS) requise pour changer de chantier. Veuillez activer la localisation.' });
        return;
      }
      const clockError = checkClientClock(clientTimestamp);
      if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
      if (!(await isProjectActive(mondayToken, newProjectId))) {
        res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
        return;
      }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_DEBUT}", "${COL_HEURE_FIN}", "${COL_DATE}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });

      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const empCv = item.column_values.find(c => c.id === COL_EMPLOYE);
      const ids = (empCv && empCv.linked_item_ids) || [];
      if (!ids.map(String).includes(employeeItemId)) {
        res.status(403).json({ error: "Ce poinçon n'appartient pas à cet employé." });
        return;
      }
      const finCv = item.column_values.find(c => c.id === COL_HEURE_FIN);
      if (finCv && finCv.text) { res.status(400).json({ error: 'Ce poinçon est déjà terminé.' }); return; }
      const dateCv = item.column_values.find(c => c.id === COL_DATE);
      const itemDate = (dateCv && dateCv.text) || nowInToronto().date;
      const startCv = item.column_values.find(c => c.id === COL_HEURE_DEBUT);
      const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
      const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;

      const now = nowInToronto();
      const rounded = roundClockToNearest15(now.hour, now.minute);

      let elapsedMin = (rounded.hour * 60 + rounded.minute) - (startHour * 60 + startMinute);
      if (elapsedMin < 0) elapsedMin += 1440;
      // Brut ET ajusté sont exprimés sur la même base décimale (arrondi au quart d'heure le
      // plus proche) pour éviter toute confusion entre les deux colonnes à l'affichage.
      const brutH = Math.round((round15(elapsedMin) / 60) * 100) / 100;

      // Ferme le segment actif — sans déduction de pause ici (appliquée une seule fois, à la
      // toute fin de journée, sur le dernier segment).
      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, {
        board: String(POINCONS_BOARD), item: String(itemId),
        cv: JSON.stringify({
          [COL_HEURE_FIN]: { hour: rounded.hour, minute: rounded.minute },
          [COL_GPS_FIN]: `${lat},${lng}`,
          [COL_TOTAL_BRUT]: brutH,
          [COL_TOTAL_AJUSTE]: brutH
        })
      });

      // Ouvre le nouveau segment EXACTEMENT à l'heure arrondie de fin du précédent — aucune
      // seconde perdue ni dupliquée pour l'employé.
      const columnValues = {
        [COL_EMPLOYE]: { item_ids: [Number(employeeItemId)] },
        [COL_PROJET]: { item_ids: [Number(newProjectId)] },
        [COL_DATE]: { date: itemDate },
        [COL_SEMAINE]: mondayOfWeek(itemDate),
        [COL_HEURE_DEBUT]: { hour: rounded.hour, minute: rounded.minute },
        [COL_GPS_DEBUT]: `${lat},${lng}`,
        [COL_STATUT]: { label: 'En attente' },
        [COL_TACHE]: String(tache).trim()
      };
      const created = await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $name: String!, $cv: JSON!) {
          create_item(board_id: $board, item_name: $name, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), name: `Poinçon ${itemDate}`, cv: JSON.stringify(columnValues) });

      res.status(200).json({ oldItemId: itemId, newItemId: created.create_item.id, switchedAt: rounded });
      return;
    }

    if (action === 'finish') {
      const { itemId, lat, lng, morningSkipped, morningReason, lunchSkipped, lunchReason, afternoonTaken, clientTimestamp } = req.body || {};
      if (!itemId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }
      if (!isValidCoord(lat) || !isValidCoord(lng)) {
        res.status(400).json({ error: 'Localisation (GPS) requise pour terminer un poinçon. Veuillez activer la localisation.' });
        return;
      }
      const clockError = checkClientClock(clientTimestamp);
      if (clockError) { res.status(400).json({ error: clockError, clockDrift: true }); return; }
      if (morningSkipped && !(morningReason || '').trim()) {
        res.status(400).json({ error: "Raison obligatoire si la pause du matin n'a pas été prise." });
        return;
      }
      if (lunchSkipped && !(lunchReason || '').trim()) {
        res.status(400).json({ error: "Raison obligatoire si le dîner n'a pas été pris." });
        return;
      }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_DEBUT}", "${COL_DATE}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });

      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const empCv = item.column_values.find(c => c.id === COL_EMPLOYE);
      const ids = (empCv && empCv.linked_item_ids) || [];
      if (!ids.map(String).includes(employeeItemId)) {
        res.status(403).json({ error: "Ce poinçon n'appartient pas à cet employé." });
        return;
      }
      const startCv = item.column_values.find(c => c.id === COL_HEURE_DEBUT);
      const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
      const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;
      const dateCv = item.column_values.find(c => c.id === COL_DATE);
      const itemDate = (dateCv && dateCv.text) || nowInToronto().date;

      const now = nowInToronto();
      let elapsedMin = (now.hour * 60 + now.minute) - (startHour * 60 + startMinute);
      if (elapsedMin < 0) elapsedMin += 1440; // au cas où le poinçon chevauche minuit
      // Le total PAYABLE (plus bas) est calculé à partir du temps RÉEL écoulé (elapsedMin, non
      // arrondi) pour rester précis. Le total BRUT affiché, lui, est exprimé sur la même base
      // décimale que l'ajusté (arrondi au quart d'heure) pour éviter toute confusion à l'écran.
      const brutH = Math.round((round15(elapsedMin) / 60) * 100) / 100;

      // Retrouve les AUTRES segments (chantiers) déjà fermés aujourd'hui pour cet employé
      // (résultat d'un ou plusieurs changements de chantier via l'action 'switch'), afin de
      // calculer le total payable de la journée ENTIÈRE, pas seulement ce dernier segment.
      const dayItems = await mondayGraphQL(mondayToken, `
        query($board: ID!, $dateCol: String!, $date: [String]!) {
          items_page_by_column_values(board_id: $board, columns: [{ column_id: $dateCol, column_values: $date }], limit: 50) {
            items {
              id
              column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_FIN}", "${COL_TOTAL_AJUSTE}"]) {
                id text
                ... on BoardRelationValue { linked_item_ids }
              }
            }
          }
        }
      `, { board: String(POINCONS_BOARD), dateCol: COL_DATE, date: [itemDate] });

      const otherClosedItems = (dayItems.items_page_by_column_values.items || []).filter(it => {
        if (String(it.id) === String(itemId)) return false;
        const empCv2 = (it.column_values || []).find(c => c.id === COL_EMPLOYE);
        const finCv2 = (it.column_values || []).find(c => c.id === COL_HEURE_FIN);
        const idsOther = (empCv2 && empCv2.linked_item_ids) || [];
        return idsOther.map(String).includes(employeeItemId) && finCv2 && finCv2.text;
      });
      const sumPrevAjusteMin = otherClosedItems.reduce((sum, it) => {
        const ajCv = (it.column_values || []).find(c => c.id === COL_TOTAL_AJUSTE);
        const h = Number((ajCv && ajCv.text) || 0);
        return sum + (isFinite(h) ? h * 60 : 0);
      }, 0);
      const sumPrevBrutMin = sumPrevAjusteMin; // segments antérieurs = brut non ajusté (voir action 'switch')

      const grandTotalBrutMin = sumPrevBrutMin + elapsedMin;
      // La question du dîner/pause PM n'a de sens que si la journée s'est réellement
      // rendue à ce moment-là. Calculé ici côté serveur (autoritatif, non contournable)
      // à partir de l'heure de fin RÉELLE, peu importe ce que le client a envoyé.
      const finishMinutes = now.hour * 60 + now.minute;
      const lunchApplicable = finishMinutes >= 13 * 60;
      const afternoonApplicable = finishMinutes >= 14 * 60;
      const afternoonSkipped = afternoonApplicable && afternoonTaken === false;
      // Dîner : pris = 30 min déduites (pause non payée) ; NON pris = AUCUNE déduction
      // (l'employé a travaillé pendant sa pause, donc payé pour ce temps). L'ajustement
      // reste neutre (0) quand non pris — ne JAMAIS ajouter 30 min positivement, sinon on
      // paierait l'employé deux fois pour le même 30 minutes.
      const lunchSkippedEffective = lunchApplicable && lunchSkipped === true;
      const pauseConfig = await loadPauseConfig(mondayToken);
      const lunchAdjust = lunchApplicable ? (lunchSkippedEffective ? 0 : -pauseConfig.diner) : 0;
      const dayPayableRaw = grandTotalBrutMin
        + lunchAdjust
        + (morningSkipped ? pauseConfig.matin : 0)
        + (afternoonSkipped ? pauseConfig.pm : 0);
      const dayPayableMin = Math.max(0, round15(dayPayableRaw));
      // La déduction/l'ajustement de la journée est imputé entièrement à CE dernier segment,
      // de façon à ce que la somme de tous les segments du jour égale le total payable exact.
      const lastAjusteMin = Math.max(0, dayPayableMin - sumPrevAjusteMin);

      const columnValues = {
        [COL_HEURE_FIN]: { hour: now.hour, minute: now.minute },
        [COL_GPS_FIN]: `${lat},${lng}`,
        [COL_MATIN_NON_PRISE]: { checked: morningSkipped ? 'true' : 'false' },
        [COL_RAISON_MATIN]: morningReason || '',
        [COL_DINER_NON_PRIS]: { checked: lunchSkipped ? 'true' : 'false' },
        [COL_RAISON_DINER]: lunchReason || '',
        [COL_PM_PRISE]: { checked: afternoonTaken ? 'true' : 'false' },
        [COL_TOTAL_BRUT]: brutH,
        [COL_TOTAL_AJUSTE]: Math.round((lastAjusteMin / 60) * 100) / 100
      };

      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), item: String(itemId), cv: JSON.stringify(columnValues) });

      res.status(200).json({
        itemId,
        totalBrutH: brutH,
        totalAjusteH: Math.round((lastAjusteMin / 60) * 100) / 100,
        dayTotalAjusteH: Math.round((dayPayableMin / 60) * 100) / 100
      });
      return;
    }

    if (action === 'editPending') {
      // Permet à l'employé de corriger LUI-MÊME un poinçon déjà terminé, mais SEULEMENT tant
      // qu'il n'a pas encore été traité (Approuvé/Rejeté) par l'admin. Il peut changer le
      // chantier et les 3 cases de pause. Les heures de début/fin ne sont JAMAIS modifiables
      // ici (elles restent celles réellement poinçonnées, avec GPS/horodatage serveur).
      const { itemId, projectId, morningSkipped, morningReason, lunchSkipped, lunchReason, afternoonTaken } = req.body || {};
      if (!itemId) { res.status(400).json({ error: 'Poinçon manquant.' }); return; }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}", "${COL_HEURE_DEBUT}", "${COL_HEURE_FIN}", "${COL_DATE}", "${COL_STATUT}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });

      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const empCv = item.column_values.find(c => c.id === COL_EMPLOYE);
      const ids = (empCv && empCv.linked_item_ids) || [];
      if (!ids.map(String).includes(employeeItemId)) {
        res.status(403).json({ error: "Ce poinçon n'appartient pas à cet employé." });
        return;
      }
      const statutCv = item.column_values.find(c => c.id === COL_STATUT);
      const statut = (statutCv && statutCv.text) || 'En attente';
      if (statut !== 'En attente') {
        res.status(403).json({ error: 'Ce poinçon a déjà été traité par l\'administrateur (' + statut + ') et ne peut plus être modifié.' });
        return;
      }
      const finCv = item.column_values.find(c => c.id === COL_HEURE_FIN);
      if (!finCv || finCv.hour == null) { res.status(400).json({ error: 'Ce poinçon est toujours en cours — impossible de le modifier ici.' }); return; }
      const startCv = item.column_values.find(c => c.id === COL_HEURE_DEBUT);
      const dateCv = item.column_values.find(c => c.id === COL_DATE);
      const itemDate = (dateCv && dateCv.text) || nowInToronto().date;

      if (projectId && !(await isProjectActive(mondayToken, projectId))) {
        res.status(400).json({ error: "Ce projet n'est plus actif ou est introuvable. Rafraîchissez votre liste de projets et réessayez." });
        return;
      }

      const columnValues = {};
      if (projectId) columnValues[COL_PROJET] = { item_ids: [Number(projectId)] };

      const pauseFieldsSent = (morningSkipped !== undefined) || (lunchSkipped !== undefined) || (afternoonTaken !== undefined);
      if (pauseFieldsSent) {
        // Les cases de pause n'ont de sens payable que pour une journée à UN SEUL segment
        // (aucun changement de chantier en cours de route) — sur une journée à plusieurs
        // segments, la répartition des pauses entre segments est ambiguë et reste réservée à
        // l'admin. On vérifie donc que c'est le seul poinçon de cet employé ce jour-là.
        const dayItems = await mondayGraphQL(mondayToken, `
          query($board: ID!, $dateCol: String!, $date: [String]!) {
            items_page_by_column_values(board_id: $board, columns: [{ column_id: $dateCol, column_values: $date }], limit: 50) {
              items { id column_values(ids: ["${COL_EMPLOYE}"]) { id ... on BoardRelationValue { linked_item_ids } } }
            }
          }
        `, { board: String(POINCONS_BOARD), dateCol: COL_DATE, date: [itemDate] });
        const empDayItems = (dayItems.items_page_by_column_values.items || []).filter(it => {
          const c = (it.column_values || []).find(c => c.id === COL_EMPLOYE);
          return ((c && c.linked_item_ids) || []).map(String).includes(employeeItemId);
        });
        if (empDayItems.length > 1) {
          res.status(400).json({ error: "Journée avec changement de chantier : les pauses ne peuvent pas être modifiées ici. Contactez l'administrateur." });
          return;
        }

        if (morningSkipped && !(morningReason || '').trim()) {
          res.status(400).json({ error: "Raison obligatoire si la pause du matin n'a pas été prise." });
          return;
        }
        if (lunchSkipped && !(lunchReason || '').trim()) {
          res.status(400).json({ error: "Raison obligatoire si le dîner n'a pas été pris." });
          return;
        }

        const startHour = startCv && typeof startCv.hour === 'number' ? startCv.hour : 0;
        const startMinute = startCv && typeof startCv.minute === 'number' ? startCv.minute : 0;
        const finHour = finCv.hour, finMinute = finCv.minute;
        let elapsedMin = (finHour * 60 + finMinute) - (startHour * 60 + startMinute);
        if (elapsedMin < 0) elapsedMin += 1440;
        const finishMinutes = finHour * 60 + finMinute;
        const lunchApplicable = finishMinutes >= 13 * 60;
        const afternoonApplicable = finishMinutes >= 14 * 60;
        const afternoonSkipped = afternoonApplicable && afternoonTaken === false;
        // Dîner : pris = 30 min déduites (pause non payée) ; NON pris = AUCUNE déduction
        // (l'employé a travaillé pendant sa pause, donc payé pour ce temps). L'ajustement
        // reste neutre (0) quand non pris — ne JAMAIS ajouter 30 min positivement, sinon on
        // paierait l'employé deux fois pour le même 30 minutes.
        const lunchSkippedEffective = lunchApplicable && lunchSkipped === true;
        const pauseConfig = await loadPauseConfig(mondayToken);
        const lunchAdjust = lunchApplicable ? (lunchSkippedEffective ? 0 : -pauseConfig.diner) : 0;
        const payableRaw = elapsedMin
          + lunchAdjust
          + (morningSkipped ? pauseConfig.matin : 0)
          + (afternoonSkipped ? pauseConfig.pm : 0);
        const payableMin = Math.max(0, round15(payableRaw));

        columnValues[COL_MATIN_NON_PRISE] = { checked: morningSkipped ? 'true' : 'false' };
        columnValues[COL_RAISON_MATIN] = morningReason || '';
        columnValues[COL_DINER_NON_PRIS] = { checked: (lunchApplicable && lunchSkipped) ? 'true' : 'false' };
        columnValues[COL_RAISON_DINER] = lunchReason || '';
        columnValues[COL_PM_PRISE] = { checked: afternoonTaken ? 'true' : 'false' };
        columnValues[COL_TOTAL_AJUSTE] = Math.round((payableMin / 60) * 100) / 100;
      }

      if (!Object.keys(columnValues).length) { res.status(400).json({ error: 'Aucune modification envoyée.' }); return; }

      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) {
          change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id }
        }
      `, { board: String(POINCONS_BOARD), item: String(itemId), cv: JSON.stringify(columnValues) });

      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'listForApproval') {
      // Liste, pour la semaine demandée (par défaut la semaine en cours), les feuilles de temps
      // des COLLÈGUES qui ont travaillé le MÊME jour sur un chantier où l'employé Approbateur a
      // LUI-MÊME travaillé — voir EMP_APPROBATEUR_COL. Semaine clé Lundi (mondayOfWeek), comme
      // le reste de l'interface mobile (voir openHistory()/mondayOfWeek() côté client).
      const { weekMonday } = req.body || {};
      const approbateur = await isApprobateur(mondayToken, employeeItemId);
      if (!approbateur.ok) {
        res.status(403).json({ error: "Ce compte n'est pas autorisé à approuver des feuilles de temps." });
        return;
      }
      const weekKey = (weekMonday && /^\d{4}-\d{2}-\d{2}$/.test(weekMonday)) ? weekMonday : mondayOfWeek(nowInToronto().date);

      const data = await mondayGraphQL(mondayToken, `
        query($board: ID!, $col: String!, $val: [String]!) {
          items_page_by_column_values(board_id: $board, columns: [{ column_id: $col, column_values: $val }], limit: 300) {
            items {
              id
              column_values(ids: ["${COL_EMPLOYE}","${COL_PROJET}","${COL_DATE}","${COL_HEURE_DEBUT}","${COL_HEURE_FIN}","${COL_STATUT}","${COL_TACHE}","${COL_TOTAL_AJUSTE}","${COL_APPROVED_BY}","${COL_REJECTION_COMMENT}","${COL_MATIN_NON_PRISE}","${COL_RAISON_MATIN}","${COL_DINER_NON_PRIS}","${COL_RAISON_DINER}","${COL_PM_PRISE}"]) {
                id text
                ... on BoardRelationValue { linked_items { id name } }
                ... on HourValue { hour minute }
              }
            }
          }
        }
      `, { board: String(POINCONS_BOARD), col: COL_SEMAINE, val: [weekKey] });

      const items = (data.items_page_by_column_values.items || []).map(it => {
        const cv = {};
        (it.column_values || []).forEach(c => { cv[c.id] = c; });
        const emp = (cv[COL_EMPLOYE].linked_items || [])[0] || { id: '', name: '?' };
        const proj = (cv[COL_PROJET].linked_items || [])[0] || { id: '', name: '?' };
        const hd = cv[COL_HEURE_DEBUT], hf = cv[COL_HEURE_FIN];
        return {
          itemId: it.id,
          empId: emp.id, empName: emp.name,
          projId: proj.id, projName: proj.name,
          date: cv[COL_DATE].text || '',
          heureDebut: (hd && hd.hour != null) ? `${String(hd.hour).padStart(2, '0')}:${String(hd.minute).padStart(2, '0')}` : '',
          heureFin: (hf && hf.hour != null) ? `${String(hf.hour).padStart(2, '0')}:${String(hf.minute).padStart(2, '0')}` : '',
          statut: cv[COL_STATUT].text || 'En attente',
          tache: cv[COL_TACHE].text || '',
          totalAjuste: cv[COL_TOTAL_AJUSTE].text || '',
          approvedByName: cv[COL_APPROVED_BY].text || '',
          rejectionComment: cv[COL_REJECTION_COMMENT].text || '',
          matinNP: cv[COL_MATIN_NON_PRISE].text === 'v',
          raisonMatin: cv[COL_RAISON_MATIN].text || '',
          dinerNP: cv[COL_DINER_NON_PRIS].text === 'v',
          raisonDiner: cv[COL_RAISON_DINER].text || '',
          pmPrise: cv[COL_PM_PRISE].text === 'v'
        };
      });

      // Les pauses ne sont significatives que sur le segment le PLUS LONG de la journée de chaque
      // employé (voir saveDayGroup() admin.html / computeDayPayable() — les autres segments d'un
      // même jour, s'il y a eu changement de chantier, restent neutres). On calcule donc, par
      // employé+jour, quel segment fait foi et quelle est l'heure de fin la plus tardive de la
      // journée (pour savoir si le dîner/la pause PM sont applicables — règle 13h/14h).
      const toMin = (hm) => { if (!hm) return null; const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
      const dayPauseByEmpDate = {};
      items.forEach(p => {
        const key = `${p.empId}|${p.date}`;
        const startMin = toMin(p.heureDebut), endMin = toMin(p.heureFin);
        const durMin = (startMin != null && endMin != null) ? ((endMin - startMin + 1440) % 1440) : -1;
        const finFin = endMin != null ? endMin : -1;
        const cur = dayPauseByEmpDate[key];
        if (!cur || durMin > cur.durMin) {
          dayPauseByEmpDate[key] = { durMin, matinNP: p.matinNP, raisonMatin: p.raisonMatin, dinerNP: p.dinerNP, raisonDiner: p.raisonDiner, pmPrise: p.pmPrise, dayFinishMin: Math.max(cur ? cur.dayFinishMin : -1, finFin) };
        } else {
          cur.dayFinishMin = Math.max(cur.dayFinishMin, finFin);
        }
      });

      // Jours/chantiers où L'APPROBATEUR LUI-MÊME a travaillé cette semaine (paires date+projet).
      const ownPairs = new Set(
        items.filter(p => String(p.empId) === employeeItemId).map(p => `${p.date}|${p.projId}`)
      );
      const colleagues = items.filter(p =>
        String(p.empId) !== employeeItemId && ownPairs.has(`${p.date}|${p.projId}`)
      );

      // Regroupé par jour puis par projet, pour l'affichage mobile (voir renderApprovalWeek()).
      // Le détail des pauses affiché vient du segment le plus long de la journée de CET employé
      // (dayPauseByEmpDate), pas du segment précis affiché ici — même convention qu'admin.html.
      const byDate = {};
      colleagues.forEach(p => {
        const dayPause = dayPauseByEmpDate[`${p.empId}|${p.date}`];
        const lunchApplicable = !!dayPause && dayPause.dayFinishMin >= 13 * 60;
        const afternoonApplicable = !!dayPause && dayPause.dayFinishMin >= 14 * 60;
        const withPause = {
          ...p,
          matinNP: dayPause ? dayPause.matinNP : p.matinNP,
          raisonMatin: dayPause ? dayPause.raisonMatin : p.raisonMatin,
          dinerNP: dayPause ? dayPause.dinerNP : p.dinerNP,
          raisonDiner: dayPause ? dayPause.raisonDiner : p.raisonDiner,
          pmPrise: dayPause ? dayPause.pmPrise : p.pmPrise,
          lunchApplicable, afternoonApplicable
        };
        if (!byDate[p.date]) byDate[p.date] = {};
        if (!byDate[p.date][p.projId]) byDate[p.date][p.projId] = { projId: p.projId, projName: p.projName, punches: [] };
        byDate[p.date][p.projId].punches.push(withPause);
      });
      const days = Object.keys(byDate).sort().map(date => ({
        date,
        projects: Object.values(byDate[date]).sort((a, b) => a.projName.localeCompare(b.projName))
      }));

      res.status(200).json({ weekMonday: weekKey, days });
      return;
    }

    if (action === 'submitApproval') {
      // Approuve/rejette le poinçon d'un COLLÈGUE — REMPLACE directement le statut, exactement
      // comme les boutons ✔/✘ du portail Admin (même champs COL_STATUT/COL_APPROVED_BY/
      // COL_REJECTION_COMMENT). Aucune approbation Admin distincte n'est requise ensuite.
      const { itemId, decision, comment } = req.body || {};
      if (!itemId || !['approuve', 'rejete'].includes(decision)) {
        res.status(400).json({ error: 'Paramètres invalides.' });
        return;
      }
      if (decision === 'rejete' && !(comment || '').trim()) {
        res.status(400).json({ error: 'Un commentaire est requis pour rejeter une feuille de temps.' });
        return;
      }
      const approbateur = await isApprobateur(mondayToken, employeeItemId);
      if (!approbateur.ok) {
        res.status(403).json({ error: "Ce compte n'est pas autorisé à approuver des feuilles de temps." });
        return;
      }

      const detail = await mondayGraphQL(mondayToken, `
        query($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${COL_EMPLOYE}","${COL_PROJET}","${COL_DATE}","${COL_HEURE_DEBUT}","${COL_HEURE_FIN}","${COL_STATUT}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
              ... on HourValue { hour minute }
            }
          }
        }
      `, { ids: [String(itemId)] });
      const item = (detail.items || [])[0];
      if (!item) { res.status(404).json({ error: 'Poinçon introuvable.' }); return; }
      const cv = {};
      (item.column_values || []).forEach(c => { cv[c.id] = c; });
      const empIds = (cv[COL_EMPLOYE].linked_item_ids || []).map(String);
      if (empIds.includes(employeeItemId)) {
        res.status(403).json({ error: 'Impossible d\'approuver sa propre feuille de temps.' });
        return;
      }
      const statutActuel = cv[COL_STATUT].text || 'En attente';
      if (statutActuel === 'Exporté') {
        res.status(403).json({ error: 'Ce poinçon a déjà été exporté à la paie et ne peut plus être modifié.' });
        return;
      }
      const hf = cv[COL_HEURE_FIN];
      if (decision === 'approuve' && (!hf || hf.hour == null)) {
        res.status(400).json({ error: 'Impossible d\'approuver : ce poinçon est encore incomplet (pas encore terminé).' });
        return;
      }
      const projId = (cv[COL_PROJET].linked_item_ids || [])[0];
      const date = cv[COL_DATE].text || '';

      // Revalide server-side (ne fait jamais confiance à listForApproval seul) que l'approbateur
      // a bien LUI-MÊME travaillé sur ce même chantier, ce même jour.
      const ownDay = await mondayGraphQL(mondayToken, `
        query($board: ID!, $col: String!, $val: [String]!) {
          items_page_by_column_values(board_id: $board, columns: [{ column_id: $col, column_values: $val }], limit: 300) {
            items { id column_values(ids: ["${COL_EMPLOYE}","${COL_PROJET}","${COL_DATE}"]) { id text ... on BoardRelationValue { linked_item_ids } } }
          }
        }
      `, { board: String(POINCONS_BOARD), col: COL_DATE, val: [date] });
      const ownMatch = (ownDay.items_page_by_column_values.items || []).some(it => {
        const c = {};
        (it.column_values || []).forEach(x => { c[x.id] = x; });
        const eIds = (c[COL_EMPLOYE].linked_item_ids || []).map(String);
        const pIds = (c[COL_PROJET].linked_item_ids || []).map(String);
        return eIds.includes(employeeItemId) && pIds.map(String).includes(String(projId));
      });
      if (!ownMatch) {
        res.status(403).json({ error: "Vous ne pouvez approuver que les feuilles de temps d'un chantier où vous avez vous-même travaillé ce jour-là." });
        return;
      }

      await mondayGraphQL(mondayToken, `
        mutation($board: ID!, $item: ID!, $cv: JSON!) { change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cv) { id } }
      `, {
        board: String(POINCONS_BOARD), item: String(itemId),
        cv: JSON.stringify({
          [COL_STATUT]: { label: decision === 'approuve' ? 'Approuvé' : 'Rejeté' },
          [COL_APPROVED_BY]: approbateur.name || '',
          [COL_REJECTION_COMMENT]: decision === 'rejete' ? String(comment).trim() : ''
        })
      });

      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (err) {
    res.status(502).json({ error: 'Erreur de connexion à monday.com: ' + err.message });
  }
};
